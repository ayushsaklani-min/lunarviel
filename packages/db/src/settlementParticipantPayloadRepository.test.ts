import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import {
  PostgresSettlementParticipantPayloadRepository,
  SettlementParticipantPayloadRepositoryError,
} from './settlementParticipantPayloadRepository.js';

type Row = Record<string, unknown>;

class FakePayloadClient implements SerializableSqlClient {
  readonly commands: Array<{ text: string; values: readonly unknown[] }> = [];
  stored: Row | undefined;
  released = 0;

  async query<RowType extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.commands.push({ text, values });
    if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as RowType[] };
    if (text.includes('INSERT INTO "SettlementParticipantPayload"')) {
      if (this.stored !== undefined) return { rows: [] as RowType[] };
      this.stored = {
        id: values[0], sessionId: values[1], traderTagHash: values[2], ciphertextPayload: Buffer.from(values[3] as Uint8Array),
        receivedAt: new Date('2026-09-04T12:00:00.000Z'),
      };
      return { rows: [this.stored as RowType] };
    }
    if (text.includes('FROM "SettlementParticipantPayload"')) {
      return { rows: this.stored === undefined ? [] : [this.stored as RowType] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.released += 1; }
}

function pool(client: FakePayloadClient): SerializableSqlPool {
  return { async connect() { return client; } };
}

const input = (ciphertextPayload = new Uint8Array([1, 2, 3, 4])) => ({
  sessionId: 'session-1', traderTagHash: 'aa'.repeat(32), ciphertextPayload,
});

describe('PostgresSettlementParticipantPayloadRepository', () => {
  it('stores opaque ciphertext once, replays identical encrypted bytes, and returns no payload', async () => {
    const client = new FakePayloadClient();
    const repository = new PostgresSettlementParticipantPayloadRepository(pool(client), { newId: () => 'payload-1' });

    const first = await repository.submit(input());
    const replay = await repository.submit(input());

    expect(first).toEqual({
      record: { id: 'payload-1', sessionId: 'session-1', traderTagHash: 'aa'.repeat(32), receivedAtMs: 1788523200000n },
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.record).not.toHaveProperty('ciphertextPayload');
    expect(client.commands.map((command) => command.text).join('\n')).not.toContain('opaqueTransaction');
    expect(client.released).toBe(2);
  });

  it('fails closed when a participant retries with changed ciphertext', async () => {
    const client = new FakePayloadClient();
    const repository = new PostgresSettlementParticipantPayloadRepository(pool(client));
    await repository.submit(input());

    await expect(repository.submit(input(new Uint8Array([9, 9, 9])))).rejects.toEqual(
      new SettlementParticipantPayloadRepositoryError('IDEMPOTENCY_CONFLICT'),
    );
  });

  it('rejects malformed identifiers and unencrypted empty payloads before database use', async () => {
    const client = new FakePayloadClient();
    const repository = new PostgresSettlementParticipantPayloadRepository(pool(client));

    await expect(repository.submit({ ...input(), sessionId: '' })).rejects.toMatchObject({ code: 'DATABASE_CONFLICT' });
    await expect(repository.submit(input(new Uint8Array()))).rejects.toMatchObject({ code: 'DATABASE_CONFLICT' });
    expect(client.commands).toHaveLength(0);
  });
});
