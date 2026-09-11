import { describe, expect, it } from 'vitest';

import type {
  ChainAdmissionTransitionResultV1,
  DurableChainAdmissionDecisionV1,
} from '@lunarveil/db';

import {
  ChainAdmissionReconciliationServiceV1,
  type ChainAdmissionTransitionRepository,
} from './chainAdmissionReconciliationService.js';

const order = {
  marketId: 'NIGHT-USDCX', epochId: 'epoch-7', commitment: '11'.repeat(32), state: 'PENDING_CHAIN' as const,
};

function included(sourceId: string) {
  return {
    sourceId,
    outcome: 'INCLUDED' as const,
    admission: { ...order, txId: 'tx-admit-7', leafIndex: '4' },
  };
}

function repository(): { repository: ChainAdmissionTransitionRepository; decisions: DurableChainAdmissionDecisionV1[] } {
  const decisions: DurableChainAdmissionDecisionV1[] = [];
  return {
    decisions,
    repository: {
      async apply(_orderId: string, decision: DurableChainAdmissionDecisionV1): Promise<ChainAdmissionTransitionResultV1> {
        decisions.push(decision);
        return { state: decision.action === 'ACCEPT' ? 'ACCEPTED' : 'PENDING_CHAIN', replayed: false };
      },
    },
  };
}

describe('ChainAdmissionReconciliationServiceV1', () => {
  it('persists only an accepted consensus decision', async () => {
    const port = repository();
    const result = await new ChainAdmissionReconciliationServiceV1(port.repository).reconcile('order-1', {
      order, requiredMatchingSources: 2, observations: [included('node-a'), included('indexer-b')],
    });

    expect(result).toMatchObject({ persisted: true, transition: { state: 'ACCEPTED' } });
    expect(port.decisions).toEqual([expect.objectContaining({ action: 'ACCEPT', code: 'ADMISSION_CONFIRMED' })]);
  });

  it('does not mutate durable state when consensus is still pending', async () => {
    const port = repository();
    const result = await new ChainAdmissionReconciliationServiceV1(port.repository).reconcile('order-1', {
      order, requiredMatchingSources: 2, observations: [{ sourceId: 'node-a', outcome: 'UNAVAILABLE' }],
    });

    expect(result).toMatchObject({ persisted: false, decision: { action: 'KEEP_PENDING' } });
    expect(port.decisions).toEqual([]);
  });

  it('persists a pause decision but cannot convert it into acceptance', async () => {
    const port = repository();
    const result = await new ChainAdmissionReconciliationServiceV1(port.repository).reconcile('order-1', {
      order,
      requiredMatchingSources: 2,
      observations: [included('node-a'), { sourceId: 'indexer-b', outcome: 'NOT_FOUND' }],
    });

    expect(result).toMatchObject({ persisted: true, transition: { state: 'PENDING_CHAIN' } });
    expect(port.decisions).toEqual([expect.objectContaining({ action: 'PAUSE', code: 'INDEXER_DISAGREEMENT' })]);
  });
});
