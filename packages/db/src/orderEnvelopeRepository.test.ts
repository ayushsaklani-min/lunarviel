import { describe, expect, it } from 'vitest';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
} from '@lunarveil/crypto';

import {
  OrderEnvelopeRepositoryError,
  PostgresOrderEnvelopeRepository,
  type SerializableSqlClient,
  type SerializableSqlPool,
} from './orderEnvelopeRepository.js';

const nowMs = 1_800_000_000_000n;

type Row = Record<string, unknown>;

class FakePostgresClient implements SerializableSqlClient {
  readonly commands: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly byRequestId = new Map<string, Row>();
  readonly byCommitment = new Map<string, Row>();
  released = false;

  async query<RowType extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.commands.push({ text, values });
    if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as RowType[] };
    if (text.includes('INSERT INTO "OrderEnvelope"')) {
      const [
        id, clientRequestId, marketId, epochId, commitment, encryptionKeyId,
        envelopeVersion, envelopeAlgorithm, ephemeralPublicKey, envelopeSalt,
        envelopeNonce, ciphertext, traderTagHash,
      ] = values as [string, string, string, string, string, string, number, string, string, string, string, Buffer, string];
      if (this.byRequestId.has(clientRequestId)) return { rows: [] as RowType[] };
      if (this.byCommitment.has(commitment)) return { rows: [] as RowType[] };
      const row: Row = {
        id,
        clientRequestId,
        marketId,
        epochId,
        commitment,
        encryptionKeyId,
        envelopeVersion,
        envelopeAlgorithm,
        ephemeralPublicKey,
        envelopeSalt,
        envelopeNonce,
        ciphertext: Buffer.from(ciphertext),
        traderTagHash,
        state: 'PENDING_CHAIN',
        createdAt: new Date(Number(nowMs)),
      };
      this.byRequestId.set(clientRequestId, row);
      this.byCommitment.set(commitment, row);
      return { rows: [row as RowType] };
    }
    if (text.includes('WHERE "clientRequestId" = $1')) {
      const row = this.byRequestId.get(values[0] as string);
      return { rows: row ? [row as RowType] : [] };
    }
    if (text.includes('WHERE "commitment" = $1')) {
      const row = this.byCommitment.get(values[0] as string);
      return { rows: row ? [row as RowType] : [] };
    }
    if (text.includes('WHERE "id" = $1 AND "state" = \'PENDING_CHAIN\'')) {
      const row = [...this.byRequestId.values()].find(value => value.id === values[0] && value.state === 'PENDING_CHAIN');
      return { rows: row ? [row as RowType] : [] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void {
    this.released = true;
  }
}

function fakePool(client: FakePostgresClient): SerializableSqlPool {
  return { connect: async () => client };
}

async function envelope(overrides: Partial<{ clientRequestId: string; commitment: string }> = {}) {
  const matcher = await generateMatcherDecryptionKeyV1({
    keyId: 'matcher-2026-09-a',
    activeFromMs: nowMs - 1n,
    expiresAtMs: nowMs + 60_000n,
  });
  return sealOrderEnvelopeV1({
    header: {
      clientRequestId: overrides.clientRequestId ?? '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
      marketId: 'NIGHT-USDCX',
      epochId: 'epoch-7',
      commitment: overrides.commitment ?? '11'.repeat(32),
      traderTagHash: '22'.repeat(32),
    },
    matcherKey: matcherPublicKeyV1(matcher),
    plaintext: new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}'),
    nowMs,
  });
}

function expectRepositoryError(action: () => Promise<unknown>, code: OrderEnvelopeRepositoryError['code']) {
  return action().then(
    () => { throw new Error(`Expected ${code}`); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(OrderEnvelopeRepositoryError);
      if (!(error instanceof OrderEnvelopeRepositoryError)) throw error;
      expect(error.code).toBe(code);
    },
  );
}

describe('PostgresOrderEnvelopeRepository', () => {
  it('stores an encrypted envelope in one serializable transaction and replays the exact request', async () => {
    const client = new FakePostgresClient();
    const repository = new PostgresOrderEnvelopeRepository(fakePool(client), { newId: () => 'order-1' });
    const submitted = await envelope();

    const first = await repository.submit({ envelope: submitted, clientSignature: new Uint8Array([7]) });
    const replay = await repository.submit({ envelope: submitted, clientSignature: new Uint8Array([8]) });

    expect(first.replayed).toBe(false);
    expect(first.record.state).toBe('PENDING_CHAIN');
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe('order-1');
    expect(client.released).toBe(true);
    expect(client.commands.filter((command) => command.text.startsWith('BEGIN'))).toHaveLength(2);
    expect(client.commands.filter((command) => command.text === 'COMMIT')).toHaveLength(2);
    expect(client.commands.flatMap((command) => command.values)
      .filter((value): value is string => typeof value === 'string')
      .join('\n')).not.toContain('quantityLots');
  });

  it('fails closed when a client request ID is reused with another encrypted transport', async () => {
    const client = new FakePostgresClient();
    const repository = new PostgresOrderEnvelopeRepository(fakePool(client));
    await repository.submit({ envelope: await envelope(), clientSignature: new Uint8Array([7]) });
    const conflicting = await envelope();

    await expectRepositoryError(
      () => repository.submit({ envelope: conflicting, clientSignature: new Uint8Array([7]) }),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects a duplicate commitment under a distinct client request ID', async () => {
    const client = new FakePostgresClient();
    const repository = new PostgresOrderEnvelopeRepository(fakePool(client));
    await repository.submit({ envelope: await envelope(), clientSignature: new Uint8Array([7]) });
    const duplicate = await envelope({ clientRequestId: 'b5595ce1-38d3-44aa-88b1-40d60fd0e0c7' });

    await expectRepositoryError(
      () => repository.submit({ envelope: duplicate, clientSignature: new Uint8Array([7]) }),
      'DUPLICATE_COMMITMENT',
    );
  });

  it('loads ciphertext only through the matcher-only pending preflight path', async () => {
    const client = new FakePostgresClient();
    const repository = new PostgresOrderEnvelopeRepository(fakePool(client), { newId: () => 'order-1' });
    const submitted = await envelope();
    await repository.submit({ envelope: submitted, clientSignature: new Uint8Array([7]) });

    await expect(repository.loadPendingEnvelope('order-1')).resolves.toEqual(submitted);
    expect(client.commands.at(-1)?.text).toContain('"state" = \'PENDING_CHAIN\'');
  });
});
