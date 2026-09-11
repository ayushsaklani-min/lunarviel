import { describe, expect, it } from 'vitest';

import {
  ChainAdmissionConsensusError,
  evaluateChainAdmissionConsensusV1,
  type ChainAdmissionConsensusInputV1,
} from './chainAdmissionConsensus.js';

const order = {
  marketId: 'NIGHT-USDCX',
  epochId: 'epoch-7',
  commitment: '11'.repeat(32),
  state: 'PENDING_CHAIN' as const,
};

function included(sourceId: string, overrides: Partial<{ txId: string; leafIndex: string; commitment: string }> = {}) {
  return {
    sourceId,
    outcome: 'INCLUDED' as const,
    admission: {
      marketId: order.marketId,
      epochId: order.epochId,
      commitment: overrides.commitment ?? order.commitment,
      txId: overrides.txId ?? 'tx-admit-7',
      leafIndex: overrides.leafIndex ?? '4',
    },
  };
}

function evaluate(overrides: Partial<ChainAdmissionConsensusInputV1> = {}) {
  return evaluateChainAdmissionConsensusV1({
    order,
    requiredMatchingSources: 2,
    observations: [included('indexer-b'), included('node-a')],
    ...overrides,
  });
}

function expectConsensusError(action: () => unknown, code: ChainAdmissionConsensusError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ChainAdmissionConsensusError);
    if (!(error instanceof ChainAdmissionConsensusError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('evaluateChainAdmissionConsensusV1', () => {
  it('accepts only matching public chain evidence at configured quorum', () => {
    expect(evaluate()).toEqual({
      action: 'ACCEPT',
      code: 'ADMISSION_CONFIRMED',
      sourceIds: ['indexer-b', 'node-a'],
      admission: included('ignored').admission,
    });
  });

  it('keeps a record pending when evidence is unavailable or below quorum', () => {
    expect(evaluate({ observations: [{ sourceId: 'node-a', outcome: 'UNAVAILABLE' }] }))
      .toMatchObject({ action: 'KEEP_PENDING', code: 'AWAITING_CHAIN_CONFIRMATION' });
    expect(evaluate({ observations: [included('node-a'), { sourceId: 'node-b', outcome: 'UNAVAILABLE' }] }))
      .toMatchObject({ action: 'KEEP_PENDING', code: 'INSUFFICIENT_CHAIN_QUORUM' });
  });

  it('pauses on indexer disagreement or an admission for another commitment', () => {
    expect(evaluate({ observations: [included('node-a'), { sourceId: 'indexer-b', outcome: 'NOT_FOUND' }] }))
      .toMatchObject({ action: 'PAUSE', code: 'INDEXER_DISAGREEMENT' });
    expect(evaluate({ observations: [included('node-a'), included('node-b', { commitment: '22'.repeat(32) })] }))
      .toMatchObject({ action: 'PAUSE', code: 'ONCHAIN_ADMISSION_MISMATCH' });
  });

  it('rejects malformed quorum, duplicate evidence sources and non-pending records', () => {
    expectConsensusError(() => evaluate({ requiredMatchingSources: 0 }), 'INVALID_QUORUM');
    expectConsensusError(() => evaluate({ observations: [included('node-a'), included('node-a')] }), 'DUPLICATE_SOURCE');
    expectConsensusError(() => evaluate({ order: { ...order, state: 'ACCEPTED' } }), 'ORDER_NOT_PENDING');
  });
});
