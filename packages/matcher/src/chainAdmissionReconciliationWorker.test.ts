import { describe, expect, it, vi } from 'vitest';

import type { ChainAdmissionTransitionResultV1 } from '@lunarveil/db';

import { ChainAdmissionReconciliationServiceV1 } from './chainAdmissionReconciliationService.js';
import {
  ChainAdmissionReconciliationWorkerV1,
  type PendingChainOrderV1,
} from './chainAdmissionReconciliationWorker.js';

const order = (orderId: string): PendingChainOrderV1 => ({
  orderId, marketId: 'market-1', epochId: 'epoch-1', commitment: '11'.repeat(32), state: 'PENDING_CHAIN',
});

function transitionRepository() {
  const apply = vi.fn(async (_orderId: string, decision: { action: string }): Promise<ChainAdmissionTransitionResultV1> => ({
    state: decision.action === 'ACCEPT' ? 'ACCEPTED' : 'PENDING_CHAIN', replayed: false,
  }));
  return { apply, service: new ChainAdmissionReconciliationServiceV1({ apply }) };
}

function included(sourceId: string) {
  return {
    sourceId, outcome: 'INCLUDED' as const,
    admission: { marketId: 'market-1', epochId: 'epoch-1', commitment: '11'.repeat(32), txId: 'tx-1', leafIndex: '2' },
  };
}

describe('ChainAdmissionReconciliationWorkerV1', () => {
  it('gathers deterministic public observations and durably accepts on quorum', async () => {
    const repository = transitionRepository();
    const worker = new ChainAdmissionReconciliationWorkerV1(
      { async listPending() { return [order('order-b'), order('order-a')]; } },
      [
        { sourceId: 'indexer-b', async observe() { return included('indexer-b'); } },
        { sourceId: 'node-a', async observe() { return included('node-a'); } },
      ],
      repository.service,
      { requiredMatchingSources: 2 },
    );

    const result = await worker.runOnce();
    expect(result).toMatchObject({ scanned: 2, reconciled: 2, accepted: 2, paused: 0, pending: 0, failed: 0 });
    expect(result.results.map(entry => entry.orderId)).toEqual(['order-a', 'order-b']);
    expect(repository.apply).toHaveBeenCalledTimes(2);
  });

  it('fails closed to pending when a source is unavailable', async () => {
    const repository = transitionRepository();
    const worker = new ChainAdmissionReconciliationWorkerV1(
      { async listPending() { return [order('order-a')]; } },
      [
        { sourceId: 'node-a', async observe() { return included('node-a'); } },
        { sourceId: 'indexer-b', async observe() { throw new Error('rpc outage'); } },
      ],
      repository.service,
      { requiredMatchingSources: 2 },
    );

    const result = await worker.runOnce();
    expect(result).toMatchObject({ scanned: 1, reconciled: 0, accepted: 0, paused: 0, pending: 1, failed: 0 });
    expect(repository.apply).not.toHaveBeenCalled();
  });

  it('counts malformed order/source failures without stopping the batch', async () => {
    const repository = transitionRepository();
    const worker = new ChainAdmissionReconciliationWorkerV1(
      { async listPending() { return [{ ...order('order-b'), state: 'ACCEPTED' }, order('order-a')]; } },
      [{ sourceId: 'node-a', async observe() { return included('node-a'); } }],
      repository.service,
      { requiredMatchingSources: 1 },
    );

    const result = await worker.runOnce();
    expect(result).toMatchObject({ scanned: 2, reconciled: 1, accepted: 1, failed: 1 });
    expect(result.results.find(entry => entry.orderId === 'order-b')?.failed).toBe(true);
  });

  it('rejects duplicate or empty source configuration', () => {
    const repository = transitionRepository();
    const pending = { async listPending() { return []; } };
    expect(() => new ChainAdmissionReconciliationWorkerV1(pending, [], repository.service, { requiredMatchingSources: 1 })).toThrow('INVALID_WORKER_SOURCES');
    expect(() => new ChainAdmissionReconciliationWorkerV1(pending, [{ sourceId: 'node-a', async observe() { return included('node-a'); } }, { sourceId: 'node-a', async observe() { return included('node-a'); } }], repository.service, { requiredMatchingSources: 1 })).toThrow('INVALID_WORKER_SOURCES');
  });
});
