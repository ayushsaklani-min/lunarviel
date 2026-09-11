import { describe, expect, it } from 'vitest';

import { clearBatch } from './clearBatch.js';
import { batch, EPOCH_ID, MARKET_ID, order } from './test-fixtures.js';

function fillMap(result: ReturnType<typeof clearBatch>): Map<string, bigint> {
  return new Map(result.fills.map(fill => [fill.orderCommitment, fill.filledLots]));
}

describe('clearBatch', () => {
  it('clears a simple cross at the deterministic lower tie-break price', () => {
    const result = clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 10n, limitPriceTicks: 105n }),
      order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: 10n, limitPriceTicks: 100n }),
    ]));

    expect(result.clearingPriceTicks).toBe(100n);
    expect(result.totalVolumeLots).toBe(10n);
    expect(fillMap(result)).toEqual(new Map([['buy', 10n], ['sell', 10n]]));
  });

  it('uses the frozen reference price before the final lower-price tie-break', () => {
    const result = clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 10n, limitPriceTicks: 110n }),
      order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: 10n, limitPriceTicks: 90n }),
    ], {
      referencePriceTicks: 105n,
      referencePriceHash: 'reference-hash',
    }));

    expect(result.clearingPriceTicks).toBe(110n);
    expect(result.referencePriceHash).toBe('reference-hash');
  });

  it('returns canonical zero price for no-cross and empty batches', () => {
    const noCross = clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 2n, limitPriceTicks: 90n }),
      order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: 2n, limitPriceTicks: 100n }),
    ]));
    const empty = clearBatch(batch([]));

    expect(noCross.clearingPriceTicks).toBe(0n);
    expect(noCross.totalVolumeLots).toBe(0n);
    expect(empty.clearingPriceTicks).toBe(0n);
    expect(empty.activeOrderCommitments).toEqual([]);
  });

  it('uses price priority before marginal pro-rata', () => {
    const result = clearBatch(batch([
      order({ commitment: 'buy-high', traderTag: 'trader-a', side: 'BUY', quantityLots: 4n, limitPriceTicks: 110n }),
      order({ commitment: 'buy-low', traderTag: 'trader-b', side: 'BUY', quantityLots: 10n, limitPriceTicks: 100n }),
      order({ commitment: 'sell', traderTag: 'trader-c', side: 'SELL', quantityLots: 6n, limitPriceTicks: 90n }),
    ]));

    expect(fillMap(result).get('buy-high')).toBe(4n);
    expect(fillMap(result).get('buy-low')).toBe(2n);
  });

  it('uses canonical bytes for equal largest-remainder ties', () => {
    const result = clearBatch(batch([
      order({ commitment: 'buy-a', traderTag: 'trader-a', side: 'BUY', quantityLots: 1n, limitPriceTicks: 100n }),
      order({ commitment: 'buy-b', traderTag: 'trader-b', side: 'BUY', quantityLots: 1n, limitPriceTicks: 100n }),
      order({ commitment: 'buy-c', traderTag: 'trader-c', side: 'BUY', quantityLots: 1n, limitPriceTicks: 100n }),
      order({ commitment: 'sell', traderTag: 'trader-d', side: 'SELL', quantityLots: 2n, limitPriceTicks: 100n }),
    ]));

    expect(fillMap(result).get('buy-a')).toBe(1n);
    expect(fillMap(result).get('buy-b')).toBe(1n);
    expect(fillMap(result).has('buy-c')).toBe(false);
  });

  it('removes all simultaneous hard-constraint violations and recomputes', () => {
    const result = clearBatch(batch([
      order({ commitment: 'fok', traderTag: 'trader-a', side: 'BUY', quantityLots: 10n, limitPriceTicks: 100n, tif: 'FOK', allowPartial: false }),
      order({ commitment: 'min-fill', traderTag: 'trader-b', side: 'BUY', quantityLots: 10n, limitPriceTicks: 100n, minFillLots: 6n }),
      order({ commitment: 'sell', traderTag: 'trader-c', side: 'SELL', quantityLots: 5n, limitPriceTicks: 90n }),
    ]));

    expect(result.removedConstraintViolations).toEqual(['fok', 'min-fill']);
    expect(result.totalVolumeLots).toBe(0n);
    expect(result.activeOrderCommitments).toEqual(['sell']);
  });

  it('accepts inactive dummy slots with zero quantity and price', () => {
    const result = clearBatch(batch([
      order({
        commitment: 'dummy-slot',
        traderTag: 'dummy-trader',
        side: 'BUY',
        quantityLots: 0n,
        limitPriceTicks: 0n,
        active: false,
      }),
    ]));

    expect(result.totalVolumeLots).toBe(0n);
    expect(result.activeOrderCommitments).toEqual([]);
  });

  it('handles quantities larger than JavaScript safe integers without floating point', () => {
    const quantity = 2n ** 100n;
    const result = clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: quantity, limitPriceTicks: 2n ** 90n }),
      order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: quantity, limitPriceTicks: 2n ** 90n }),
    ]));

    expect(result.totalVolumeLots).toBe(quantity);
  });

  it('rejects opposite-side orders with the same trader tag', () => {
    expect(() => clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'same-trader', side: 'BUY', quantityLots: 1n, limitPriceTicks: 10n }),
      order({ commitment: 'sell', traderTag: 'same-trader', side: 'SELL', quantityLots: 1n, limitPriceTicks: 9n }),
    ]))).toThrow('SELF_TRADE_POLICY');
  });

  it('fails closed for mismatched epoch and incomplete reference inputs', () => {
    expect(() => clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 1n, limitPriceTicks: 10n, epochId: 'wrong' }),
    ]))).toThrow('ORDER_EPOCH_MISMATCH');

    expect(() => clearBatch(batch([], { referencePriceTicks: 10n }))).toThrow('REFERENCE_PRICE_HASH_REQUIRED');
    expect(() => clearBatch(batch([], { maxPriceCollarBps: 10n }))).toThrow('REFERENCE_PRICE_REQUIRED');
    expect(() => clearBatch(batch([
      order({ commitment: '\ud800', traderTag: 'trader-a', side: 'BUY', quantityLots: 1n, limitPriceTicks: 10n }),
    ]))).toThrow('INVALID_COMMITMENT');
  });

  it('enforces the price collar with exact bigint cross multiplication', () => {
    expect(() => clearBatch(batch([
      order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 10n, limitPriceTicks: 120n }),
      order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: 10n, limitPriceTicks: 120n }),
    ], {
      referencePriceTicks: 100n,
      referencePriceHash: 'reference-hash',
      maxPriceCollarBps: 500n,
    }))).toThrow('PRICE_COLLAR_VIOLATION');
  });

  it('binds market, epoch, rule, root, and config into every solution', () => {
    const result = clearBatch(batch([]));
    expect(result).toMatchObject({
      version: 1,
      marketId: MARKET_ID,
      epochId: EPOCH_ID,
      ruleVersion: 'fba-limit-v1',
      inputRoot: 'input-root-fixture',
      configHash: 'config-hash-fixture',
    });
    expect(result.canonicalSolutionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
