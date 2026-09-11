import { describe, expect, it } from 'vitest';

import {
  ChainAdmissionReconciliationRepositoryError,
  PostgresChainAdmissionReconciliationRepository,
  type DurableChainAdmissionDecisionV1,
} from './chainAdmissionReconciliationRepository.js';
import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';

type Row = Record<string, unknown>;

class FakeReconciliationClient implements SerializableSqlClient {
  readonly commands: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly reconciliations = new Map<string, Row>();
  readonly order: Row = {
    id: 'order-1',
    marketId: 'NIGHT-USDCX',
    epochId: 'epoch-7',
    commitment: '11'.repeat(32),
    state: 'PENDING_CHAIN',
    chainAdmissionTxId: null,
    leafIndex: null,
  };

  async query<RowType extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.commands.push({ text, values });
    if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] as RowType[] };
    if (text.includes('FROM "OrderEnvelope" WHERE "id" = $1 FOR UPDATE')) {
      return { rows: values[0] === this.order.id ? [this.order as RowType] : [] };
    }
    if (text.includes('INSERT INTO "OrderAdmissionReconciliation"')) {
      const hash = values[4] as string;
      if (this.reconciliations.has(hash)) return { rows: [] as RowType[] };
      this.reconciliations.set(hash, { id: values[0] });
      return { rows: [{ id: values[0] } as unknown as RowType] };
    }
    if (text.includes('FROM "OrderAdmissionReconciliation"')) {
      const existing = this.reconciliations.get(values[1] as string);
      return { rows: existing ? [existing as RowType] : [] };
    }
    if (text.includes("UPDATE \"OrderEnvelope\"")) {
      if (this.order.state !== 'PENDING_CHAIN') return { rows: [] as RowType[] };
      this.order.state = 'ACCEPTED';
      this.order.chainAdmissionTxId = values[1];
      this.order.leafIndex = values[2];
      return { rows: [{ id: this.order.id } as unknown as RowType] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void {}
}

function pool(client: FakeReconciliationClient): SerializableSqlPool {
  return { async connect() { return client; } };
}

const accepted: DurableChainAdmissionDecisionV1 = {
  action: 'ACCEPT',
  code: 'ADMISSION_CONFIRMED',
  sourceIds: ['indexer-b', 'node-a'],
  admission: {
    marketId: 'NIGHT-USDCX', epochId: 'epoch-7', commitment: '11'.repeat(32), txId: 'tx-admit-7', leafIndex: '4',
  },
};

function expectRepositoryError(action: () => Promise<unknown>, code: ChainAdmissionReconciliationRepositoryError['code']) {
  return action().then(
    () => { throw new Error(`Expected ${code}`); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ChainAdmissionReconciliationRepositoryError);
      if (!(error instanceof ChainAdmissionReconciliationRepositoryError)) throw error;
      expect(error.code).toBe(code);
    },
  );
}

describe('PostgresChainAdmissionReconciliationRepository', () => {
  it('atomically records matching public evidence and accepts a pending order', async () => {
    const client = new FakeReconciliationClient();
    const repository = new PostgresChainAdmissionReconciliationRepository(pool(client), { newId: () => 'reconciliation-1' });

    const result = await repository.apply('order-1', accepted);
    const replay = await repository.apply('order-1', accepted);

    expect(result).toEqual({ state: 'ACCEPTED', replayed: false });
    expect(replay).toEqual({ state: 'ACCEPTED', replayed: true });
    expect(client.order.chainAdmissionTxId).toBe('tx-admit-7');
    expect(client.commands.filter((command) => command.text.startsWith('BEGIN'))).toHaveLength(2);
  });

  it('records a pause without promoting the order and replays the exact pause', async () => {
    const client = new FakeReconciliationClient();
    const repository = new PostgresChainAdmissionReconciliationRepository(pool(client));
    const pause: DurableChainAdmissionDecisionV1 = {
      action: 'PAUSE', code: 'INDEXER_DISAGREEMENT', sourceIds: ['node-a', 'indexer-b'],
    };

    expect(await repository.apply('order-1', pause)).toEqual({ state: 'PENDING_CHAIN', replayed: false });
    expect(await repository.apply('order-1', pause)).toEqual({ state: 'PENDING_CHAIN', replayed: true });
    expect(client.order.state).toBe('PENDING_CHAIN');
  });

  it('fails closed for an inclusion that does not match the stored public order', async () => {
    const client = new FakeReconciliationClient();
    const repository = new PostgresChainAdmissionReconciliationRepository(pool(client));
    const mismatched: DurableChainAdmissionDecisionV1 = {
      ...accepted,
      admission: { ...accepted.admission, commitment: '22'.repeat(32) },
    };

    await expectRepositoryError(() => repository.apply('order-1', mismatched), 'DECISION_CONFLICT');
    expect(client.reconciliations.size).toBe(0);
    expect(client.order.state).toBe('PENDING_CHAIN');
  });
});
