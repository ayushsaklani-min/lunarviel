import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseBatchSolution, serializeBatchSolution } from './canonical.js';
import { clearBatch } from './clearBatch.js';
import { batch, order } from './test-fixtures.js';
import type { MatchingOrderV1 } from './types.js';

const baseOrderArb = fc.record({
  commitment: fc.uuid(),
  traderTag: fc.uuid(),
  side: fc.constantFrom<'BUY' | 'SELL'>('BUY', 'SELL'),
  quantityLots: fc.bigInt({ min: 1n, max: 1_000n }),
  limitPriceTicks: fc.bigInt({ min: 1n, max: 1_000n }),
  constraint: fc.constantFrom<'partial' | 'full' | 'fok' | 'min-fill'>('partial', 'full', 'fok', 'min-fill'),
  active: fc.boolean(),
});

interface GeneratedOrder {
  commitment: string;
  traderTag: string;
  side: 'BUY' | 'SELL';
  quantityLots: bigint;
  limitPriceTicks: bigint;
  constraint: 'partial' | 'full' | 'fok' | 'min-fill';
  active: boolean;
}

function generatedOrders(raw: readonly GeneratedOrder[]): MatchingOrderV1[] {
  return raw.map((item, index) => {
    const constraint = item.constraint;
    const minFillLots = constraint === 'min-fill' ? (item.quantityLots + 1n) / 2n : 0n;
    return order({
      commitment: `${item.commitment}-${index.toString().padStart(2, '0')}`,
      traderTag: `${item.traderTag}-${index}`,
      side: item.side,
      quantityLots: item.quantityLots,
      limitPriceTicks: item.limitPriceTicks,
      minFillLots,
      tif: constraint === 'fok' ? 'FOK' : 'GFE',
      allowPartial: constraint === 'partial' || constraint === 'min-fill',
      active: item.active,
    });
  });
}

function objective(orders: readonly MatchingOrderV1[], price: bigint): readonly [bigint, bigint, bigint] {
  const buy = orders
    .filter(item => item.side === 'BUY' && item.limitPriceTicks >= price)
    .reduce((total, item) => total + item.quantityLots, 0n);
  const sell = orders
    .filter(item => item.side === 'SELL' && item.limitPriceTicks <= price)
    .reduce((total, item) => total + item.quantityLots, 0n);
  return [buy < sell ? buy : sell, buy >= sell ? buy - sell : sell - buy, price];
}

function better(left: readonly [bigint, bigint, bigint], right: readonly [bigint, bigint, bigint]): boolean {
  if (left[0] !== right[0]) return left[0] > right[0];
  if (left[1] !== right[1]) return left[1] < right[1];
  return left[2] < right[2];
}

describe('matching properties', () => {
  it('satisfies all clearing invariants for 10,000 generated batches', () => {
    fc.assert(fc.property(
      fc.array(baseOrderArb, { minLength: 0, maxLength: 12 }),
      raw => {
        const orders = generatedOrders(raw);
        const input = batch(orders);
        const result = clearBatch(input);

        // Input order is not a priority signal.
        expect(clearBatch(batch([...orders].reverse()))).toEqual(result);
        expect(clearBatch(batch([...orders].sort((a, b) => a.commitment < b.commitment ? -1 : 1)))).toEqual(result);

        const byCommitment = new Map(orders.map(item => [item.commitment, item]));
        const finalActive = new Set(result.activeOrderCommitments);
        let buyFill = 0n;
        let sellFill = 0n;
        for (const fill of result.fills) {
          const matched = byCommitment.get(fill.orderCommitment)!;
          expect(matched).toBeDefined();
          expect(finalActive.has(fill.orderCommitment)).toBe(true);
          expect(fill.filledLots).toBeGreaterThan(0n);
          expect(fill.filledLots).toBeLessThanOrEqual(matched.quantityLots);
          expect(matched.active).toBe(true);
          expect(result.removedConstraintViolations).not.toContain(matched.commitment);
          if (matched.tif === 'FOK' || !matched.allowPartial) expect(fill.filledLots).toBe(matched.quantityLots);
          expect(fill.filledLots).toBeGreaterThanOrEqual(matched.minFillLots);
          if (matched.side === 'BUY') {
            buyFill += fill.filledLots;
            expect(result.clearingPriceTicks).toBeLessThanOrEqual(matched.limitPriceTicks);
          } else {
            sellFill += fill.filledLots;
            expect(result.clearingPriceTicks).toBeGreaterThanOrEqual(matched.limitPriceTicks);
          }
        }
        expect(buyFill).toBe(sellFill);
        expect(buyFill).toBe(result.totalVolumeLots);

        const activeOrders = orders.filter(item => finalActive.has(item.commitment));
        const candidates = [...new Set(activeOrders.map(item => item.limitPriceTicks.toString()))].map(BigInt);
        if (result.totalVolumeLots === 0n) {
          expect(result.clearingPriceTicks).toBe(0n);
        } else {
          expect(candidates).toContain(result.clearingPriceTicks);
          const selected = objective(activeOrders, result.clearingPriceTicks);
          for (const candidate of candidates) expect(better(objective(activeOrders, candidate), selected)).toBe(false);
        }

        // Canonical decimal-string transport is lossless.
        expect(parseBatchSolution(serializeBatchSolution(result))).toEqual(result);
      },
    ), { numRuns: 10_000, endOnFailure: true });
  }, 120_000);

  it('allocates every generated marginal level by exact largest remainder', () => {
    const quantitiesArb = fc.array(fc.bigInt({ min: 1n, max: 100n }), { minLength: 2, maxLength: 10 });
    fc.assert(fc.property(quantitiesArb.chain(quantities => {
      const total = quantities.reduce((sum, value) => sum + value, 0n);
      return fc.bigInt({ min: 1n, max: total - 1n }).map(target => ({ quantities, target, total }));
    }), ({ quantities, target, total }) => {
      const buyers = quantities.map((quantity, index) => order({
        commitment: `buy-${index.toString().padStart(2, '0')}`,
        traderTag: `buyer-${index}`,
        side: 'BUY',
        quantityLots: quantity,
        limitPriceTicks: 100n,
      }));
      const seller = order({
        commitment: 'sell',
        traderTag: 'seller',
        side: 'SELL',
        quantityLots: target,
        limitPriceTicks: 100n,
      });
      const result = clearBatch(batch([...buyers, seller]));
      const fills = new Map(result.fills.map(fill => [fill.orderCommitment, fill.filledLots]));

      const expected = buyers.map(item => ({
        commitment: item.commitment,
        base: (target * item.quantityLots) / total,
        remainder: (target * item.quantityLots) % total,
      }));
      let left = target - expected.reduce((sum, item) => sum + item.base, 0n);
      expected.sort((a, b) => a.remainder === b.remainder
        ? (a.commitment < b.commitment ? -1 : 1)
        : (a.remainder > b.remainder ? -1 : 1));
      for (const item of expected) {
        const rounded = item.base + (left > 0n ? 1n : 0n);
        if (left > 0n) left -= 1n;
        expect(fills.get(item.commitment) ?? 0n).toBe(rounded);
      }
      expect([...fills.entries()]
        .filter(([commitment]) => commitment.startsWith('buy-'))
        .reduce((sum, [, value]) => sum + value, 0n)).toBe(target);
    }), { numRuns: 1_000, endOnFailure: true });
  }, 30_000);
});
