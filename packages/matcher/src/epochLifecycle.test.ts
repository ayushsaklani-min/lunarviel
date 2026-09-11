import { describe, expect, it } from 'vitest';

import { EpochLifecycleError, transitionEpochLifecycleV1, type EpochLifecycleSnapshotV1 } from './epochLifecycle.js';

const snapshot = (state: EpochLifecycleSnapshotV1['state'] = 'OPEN'): EpochLifecycleSnapshotV1 => ({
  state,
  parameters: {
    marketId: 'market-1', epochId: 'epoch-1', sequence: 7n, ruleVersion: 'v1', configHash: 'aa'.repeat(32),
    tickSizeAtomic: 1n, lotSizeAtomic: 10n, feeBps: 25n, maxPriceCollarBps: 500n,
  },
  orderCount: 2, maxOrders: 4,
});

const event = (type: Parameters<typeof transitionEpochLifecycleV1>[1]['type'], configHash = 'aa'.repeat(32)) => ({ type, configHash }) as Parameters<typeof transitionEpochLifecycleV1>[1];

describe('epoch lifecycle V1', () => {
  it('enforces the frozen happy-path lifecycle', () => {
    let current = snapshot();
    for (const [from, action, to] of [
      ['OPEN', 'CLOSE', 'CLOSED'], ['CLOSED', 'START_PROVING', 'PROVING'],
      ['PROVING', 'PROOF_VERIFIED', 'PENDING_FIRMUP'], ['PENDING_FIRMUP', 'START_SETTLEMENT', 'SETTLING'],
      ['SETTLING', 'FINALIZE', 'FINALIZED'],
    ] as const) {
      expect(current.state).toBe(from);
      current = transitionEpochLifecycleV1(current, event(action));
      expect(current.state).toBe(to);
      expect(current.parameters.configHash).toBe('aa'.repeat(32));
    }
  });

  it('rejects illegal transitions, stale configuration and post-finalization mutation', () => {
    expect(() => transitionEpochLifecycleV1(snapshot(), event('START_PROVING'))).toThrowError(new EpochLifecycleError('INVALID_TRANSITION'));
    expect(() => transitionEpochLifecycleV1(snapshot(), event('CLOSE', 'bb'.repeat(32)))).toThrowError(new EpochLifecycleError('CONFIG_HASH_MISMATCH'));
    expect(() => transitionEpochLifecycleV1(snapshot('FINALIZED'), event('INVALIDATE'))).toThrowError(new EpochLifecycleError('TERMINAL_EPOCH'));
  });

  it('allows only explicit recompute/invalidate recovery branches', () => {
    expect(transitionEpochLifecycleV1(snapshot('CLOSED'), event('RECOMPUTE')).state).toBe('RECOMPUTE');
    expect(transitionEpochLifecycleV1(snapshot('RECOMPUTE'), event('START_PROVING')).state).toBe('PROVING');
    expect(transitionEpochLifecycleV1(snapshot('PROVING'), event('INVALIDATE')).state).toBe('INVALIDATED');
    expect(() => transitionEpochLifecycleV1(snapshot('OPEN'), event('FINALIZE'))).toThrowError('INVALID_TRANSITION');
  });

  it('rejects non-integral counts and unsafe market parameters', () => {
    expect(() => transitionEpochLifecycleV1({ ...snapshot(), orderCount: 5 }, event('CLOSE'))).toThrowError('INVALID_ORDER_COUNT');
    expect(() => transitionEpochLifecycleV1({ ...snapshot(), parameters: { ...snapshot().parameters, tickSizeAtomic: 0n } }, event('CLOSE'))).toThrowError('INVALID_PARAMETERS');
  });
});
