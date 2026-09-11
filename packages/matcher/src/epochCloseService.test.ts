import { describe, expect, it } from 'vitest';

import type { DueEpochV1, EpochCloseOutcomeV1 } from '@lunarveil/db';

import { EpochCloseServiceV1, type EpochLifecycleStore } from './epochCloseService.js';

const NOW = 1_800_000_000_000n;

function due(overrides: Partial<DueEpochV1> = {}): DueEpochV1 {
  return {
    epochId: 'epoch-1',
    marketId: 'market-1',
    sequence: 7n,
    configHash: 'ab'.repeat(32),
    ruleVersion: 'rules-v1',
    maxOrders: 4,
    tickSizeAtomic: 5n,
    lotSizeAtomic: 100n,
    feeBps: 0n,
    maxPriceCollarBps: undefined,
    admittedOrderCount: 2,
    ...overrides,
  };
}

interface StoreSpyV1 {
  readonly store: EpochLifecycleStore;
  readonly closed: { epochId: string; expectedConfigHash: string }[];
}

function store(
  epochs: readonly DueEpochV1[],
  outcome: (epochId: string) => EpochCloseOutcomeV1 = epochId => ({ outcome: 'CLOSED', epochId, admittedOrderCount: 2 }),
): StoreSpyV1 {
  const closed: StoreSpyV1['closed'] = [];
  return {
    closed,
    store: {
      async listDueForClose() { return epochs; },
      async close(input) {
        closed.push({ epochId: input.epochId, expectedConfigHash: input.expectedConfigHash });
        return outcome(input.epochId);
      },
    },
  };
}

describe('EpochCloseServiceV1', () => {
  it('closes every due epoch and reports the counts', async () => {
    const spy = store([due(), due({ epochId: 'epoch-2' })]);
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    expect(await service.runOnce()).toEqual({ scanned: 2, closed: 2, skipped: 0, refused: 0 });
    expect(spy.closed.map(entry => entry.epochId)).toEqual(['epoch-1', 'epoch-2']);
  });

  it('passes the config hash it decided against, so a changed row is refused downstream', async () => {
    const spy = store([due({ configHash: 'cd'.repeat(32) })]);
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    await service.runOnce();
    expect(spy.closed[0]?.expectedConfigHash).toBe('cd'.repeat(32));
  });

  it('counts a lost race as skipped rather than closed', async () => {
    // Another replica closed it first; the repository reports SKIPPED.
    const spy = store([due()], epochId => ({ outcome: 'SKIPPED', epochId, reason: 'NOT_OPEN' }));
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    expect(await service.runOnce()).toEqual({ scanned: 1, closed: 0, skipped: 1, refused: 0 });
  });

  it('refuses an epoch the state machine rejects, and leaves it open', async () => {
    // More admitted orders than the market's maximum: the frozen parameters
    // do not describe this epoch, so closing would freeze a root over a
    // configuration the system cannot reason about.
    const spy = store([due({ admittedOrderCount: 9, maxOrders: 4 })]);
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    expect(await service.runOnce()).toEqual({ scanned: 1, closed: 0, skipped: 0, refused: 1 });
    expect(spy.closed).toEqual([]);
  });

  it('refuses an epoch whose frozen parameters do not validate', async () => {
    const spy = store([
      due({ epochId: 'epoch-bad-tick', tickSizeAtomic: 0n }),
      due({ epochId: 'epoch-bad-hash', configHash: 'not-a-hash' }),
      due({ epochId: 'epoch-bad-fee', feeBps: 20_000n }),
    ]);
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    expect(await service.runOnce()).toEqual({ scanned: 3, closed: 0, skipped: 0, refused: 3 });
    expect(spy.closed).toEqual([]);
  });

  it('keeps closing the rest of the batch after one refusal', async () => {
    const spy = store([due({ epochId: 'epoch-bad', tickSizeAtomic: 0n }), due({ epochId: 'epoch-good' })]);
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    expect(await service.runOnce()).toEqual({ scanned: 2, closed: 1, skipped: 0, refused: 1 });
    expect(spy.closed.map(entry => entry.epochId)).toEqual(['epoch-good']);
  });

  it('does nothing when no epoch is due', async () => {
    const spy = store([]);
    const service = new EpochCloseServiceV1(spy.store, { nowMs: () => NOW });

    expect(await service.runOnce()).toEqual({ scanned: 0, closed: 0, skipped: 0, refused: 0 });
    expect(spy.closed).toEqual([]);
  });

  it('rejects an out-of-range batch size at construction', () => {
    const spy = store([]);
    expect(() => new EpochCloseServiceV1(spy.store, { nowMs: () => NOW, batchSize: 0 })).toThrow();
    expect(() => new EpochCloseServiceV1(spy.store, { nowMs: () => NOW, batchSize: 101 })).toThrow();
  });

  it('uses one clock reading for the whole pass', async () => {
    // A pass that re-read the clock could close an epoch against a later
    // instant than the one it selected candidates with.
    const readings: bigint[] = [];
    const spy = store([due(), due({ epochId: 'epoch-2' })]);
    const service = new EpochCloseServiceV1(spy.store, {
      nowMs: () => { const value = NOW + BigInt(readings.length); readings.push(value); return value; },
    });

    await service.runOnce();
    expect(readings).toHaveLength(1);
  });
});
