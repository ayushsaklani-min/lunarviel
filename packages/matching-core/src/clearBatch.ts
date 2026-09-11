import {
  assertCanonicalIdentifier,
  compareCanonicalBytes,
  finalizeSolution,
  isValidBatchSolution,
} from './canonical.js';
import type {
  BatchInputV1,
  BatchSolutionPayloadV1,
  BatchSolutionV1,
  Fill,
  MatchingOrderV1,
  Side,
} from './types.js';

const ZERO = 0n;
const BPS = 10_000n;

function abs(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, ZERO);
}

function assertBatchInput(input: BatchInputV1): void {
  if (input.version !== 1) throw new Error('UNSUPPORTED_INPUT_VERSION');
  assertCanonicalIdentifier(input.marketId, 'INVALID_MARKET_ID');
  assertCanonicalIdentifier(input.epochId, 'INVALID_EPOCH_ID');
  assertCanonicalIdentifier(input.ruleVersion, 'INVALID_RULE_VERSION');
  assertCanonicalIdentifier(input.inputRoot, 'INVALID_INPUT_ROOT');
  assertCanonicalIdentifier(input.configHash, 'INVALID_CONFIG_HASH');

  if (input.referencePriceTicks !== undefined) {
    if (input.referencePriceTicks <= ZERO) throw new Error('INVALID_REFERENCE_PRICE');
    if (input.referencePriceHash === undefined) throw new Error('REFERENCE_PRICE_HASH_REQUIRED');
  } else if (input.referencePriceHash !== undefined) {
    throw new Error('REFERENCE_PRICE_REQUIRED');
  }
  if (input.maxPriceCollarBps !== undefined) {
    if (input.maxPriceCollarBps < ZERO) throw new Error('INVALID_PRICE_COLLAR');
    if (input.referencePriceTicks === undefined) throw new Error('REFERENCE_PRICE_REQUIRED');
  }

  const seen = new Set<string>();
  const sideByTrader = new Map<string, Side>();
  for (const order of input.orders) {
    assertCanonicalIdentifier(order.commitment, 'INVALID_COMMITMENT');
    assertCanonicalIdentifier(order.traderTag, 'INVALID_TRADER_TAG');
    if (seen.has(order.commitment)) throw new Error('DUPLICATE_COMMITMENT');
    seen.add(order.commitment);
    if (order.version !== 1 || order.orderType !== 'LIMIT') throw new Error('UNSUPPORTED_ORDER_VERSION');
    if (order.marketId !== input.marketId) throw new Error('ORDER_MARKET_MISMATCH');
    if (order.epochId !== input.epochId) throw new Error('ORDER_EPOCH_MISMATCH');
    if (order.quantityLots < ZERO || (order.active && order.quantityLots === ZERO)) {
      throw new Error('INVALID_QUANTITY');
    }
    if (order.limitPriceTicks < ZERO || (order.active && order.limitPriceTicks === ZERO)) {
      throw new Error('INVALID_PRICE');
    }
    if (order.minFillLots < ZERO || order.minFillLots > order.quantityLots) {
      throw new Error('INVALID_MIN_FILL');
    }
    if (order.tif === 'FOK' && order.allowPartial) throw new Error('FOK_PARTIAL_CONFLICT');

    if (order.active) {
      const previous = sideByTrader.get(order.traderTag);
      if (previous !== undefined && previous !== order.side) throw new Error('SELF_TRADE_POLICY');
      sideByTrader.set(order.traderTag, order.side);
    }
  }
}

function candidatePrices(orders: readonly MatchingOrderV1[]): bigint[] {
  return [...new Set(orders.filter(order => order.active).map(order => order.limitPriceTicks.toString(10)))]
    .map(value => BigInt(value))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

interface Score {
  price: bigint;
  volume: bigint;
  imbalance: bigint;
  referenceDistance: bigint;
}

function scorePrice(
  orders: readonly MatchingOrderV1[],
  price: bigint,
  referencePriceTicks?: bigint,
): Score {
  const buy = sum(orders
    .filter(order => order.active && order.side === 'BUY' && order.limitPriceTicks >= price)
    .map(order => order.quantityLots));
  const sell = sum(orders
    .filter(order => order.active && order.side === 'SELL' && order.limitPriceTicks <= price)
    .map(order => order.quantityLots));
  return {
    price,
    volume: buy < sell ? buy : sell,
    imbalance: abs(buy - sell),
    referenceDistance: referencePriceTicks === undefined ? ZERO : abs(price - referencePriceTicks),
  };
}

function betterScore(left: Score, right: Score, useReference: boolean): boolean {
  if (left.volume !== right.volume) return left.volume > right.volume;
  if (left.imbalance !== right.imbalance) return left.imbalance < right.imbalance;
  if (useReference && left.referenceDistance !== right.referenceDistance) {
    return left.referenceDistance < right.referenceDistance;
  }
  return left.price < right.price;
}

function chooseClearingPrice(
  orders: readonly MatchingOrderV1[],
  referencePriceTicks?: bigint,
): Score | undefined {
  let best: Score | undefined;
  for (const price of candidatePrices(orders)) {
    const score = scorePrice(orders, price, referencePriceTicks);
    if (best === undefined || betterScore(score, best, referencePriceTicks !== undefined)) best = score;
  }
  return best;
}

function enforceCollar(price: bigint, input: BatchInputV1): void {
  if (input.maxPriceCollarBps === undefined) return;
  const reference = input.referencePriceTicks!;
  if (abs(price - reference) * BPS > reference * input.maxPriceCollarBps) {
    throw new Error('PRICE_COLLAR_VIOLATION');
  }
}

function proRata(
  orders: readonly MatchingOrderV1[],
  remaining: bigint,
): Map<string, bigint> {
  const fills = new Map<string, bigint>();
  if (remaining <= ZERO || orders.length === 0) return fills;

  const total = sum(orders.map(order => order.quantityLots));
  if (remaining >= total) {
    for (const order of orders) fills.set(order.commitment, order.quantityLots);
    return fills;
  }

  const rows = orders.map(order => {
    const numerator = remaining * order.quantityLots;
    const base = numerator / total;
    fills.set(order.commitment, base);
    return { order, remainder: numerator % total };
  });

  let left = remaining - sum([...fills.values()]);
  rows.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return compareCanonicalBytes(left.order.commitment, right.order.commitment);
  });

  for (const row of rows) {
    if (left === ZERO) break;
    fills.set(row.order.commitment, (fills.get(row.order.commitment) ?? ZERO) + 1n);
    left -= 1n;
  }
  return fills;
}

function allocateSide(
  eligible: readonly MatchingOrderV1[],
  target: bigint,
  side: Side,
): Map<string, bigint> {
  const fills = new Map<string, bigint>();
  let remaining = target;
  const levels = new Map<string, MatchingOrderV1[]>();
  for (const order of eligible) {
    const key = order.limitPriceTicks.toString(10);
    const level = levels.get(key) ?? [];
    level.push(order);
    levels.set(key, level);
  }

  const prices = [...levels.keys()].map(value => BigInt(value)).sort((left, right) => {
    if (left === right) return 0;
    if (side === 'BUY') return left > right ? -1 : 1;
    return left < right ? -1 : 1;
  });

  for (const price of prices) {
    if (remaining === ZERO) break;
    const levelOrders = levels.get(price.toString(10))!;
    const levelTotal = sum(levelOrders.map(order => order.quantityLots));
    if (levelTotal <= remaining) {
      for (const order of levelOrders) fills.set(order.commitment, order.quantityLots);
      remaining -= levelTotal;
    } else {
      for (const [commitment, fill] of proRata(levelOrders, remaining)) fills.set(commitment, fill);
      remaining = ZERO;
    }
  }
  return fills;
}

function allocate(
  orders: readonly MatchingOrderV1[],
  price: bigint,
  volume: bigint,
): Map<string, bigint> {
  const buys = orders.filter(order => order.active && order.side === 'BUY' && order.limitPriceTicks >= price);
  const sells = orders.filter(order => order.active && order.side === 'SELL' && order.limitPriceTicks <= price);
  return new Map([
    ...allocateSide(buys, volume, 'BUY'),
    ...allocateSide(sells, volume, 'SELL'),
  ]);
}

function hardConstraintViolations(
  orders: readonly MatchingOrderV1[],
  fills: ReadonlyMap<string, bigint>,
): string[] {
  return orders
    .filter(order => order.active)
    .filter(order => {
      const fill = fills.get(order.commitment) ?? ZERO;
      if (fill === ZERO) return false;
      if (order.tif === 'FOK' && fill !== order.quantityLots) return true;
      if (!order.allowPartial && fill !== order.quantityLots) return true;
      return fill < order.minFillLots;
    })
    .map(order => order.commitment)
    .sort(compareCanonicalBytes);
}

function makeSolution(
  input: BatchInputV1,
  active: readonly MatchingOrderV1[],
  removed: ReadonlySet<string>,
  clearingPriceTicks: bigint,
  totalVolumeLots: bigint,
  fills: Fill[],
): BatchSolutionV1 {
  const payload: BatchSolutionPayloadV1 = {
    version: 1,
    marketId: input.marketId,
    epochId: input.epochId,
    ruleVersion: input.ruleVersion,
    clearingPriceTicks,
    totalVolumeLots,
    fills,
    activeOrderCommitments: active.filter(order => order.active).map(order => order.commitment),
    removedConstraintViolations: [...removed],
    inputRoot: input.inputRoot,
    configHash: input.configHash,
  };
  if (input.referencePriceHash !== undefined) payload.referencePriceHash = input.referencePriceHash;
  return finalizeSolution(payload);
}

export function clearBatch(input: BatchInputV1): BatchSolutionV1 {
  assertBatchInput(input);
  const orders = input.orders.map(order => ({ ...order }));
  const removed = new Set<string>();

  for (let iteration = 0; iteration <= orders.length; iteration++) {
    const active = orders.map(order => ({
      ...order,
      active: order.active && !removed.has(order.commitment),
    }));
    const best = chooseClearingPrice(active, input.referencePriceTicks);
    if (best === undefined || best.volume === ZERO) {
      return makeSolution(input, active, removed, ZERO, ZERO, []);
    }

    enforceCollar(best.price, input);
    const allocated = allocate(active, best.price, best.volume);
    const violations = hardConstraintViolations(active, allocated);
    if (violations.length === 0) {
      const fills = active
        .map(order => ({
          orderCommitment: order.commitment,
          filledLots: allocated.get(order.commitment) ?? ZERO,
        }))
        .filter(fill => fill.filledLots > ZERO)
        .sort((left, right) => compareCanonicalBytes(left.orderCommitment, right.orderCommitment));
      return makeSolution(input, active, removed, best.price, best.volume, fills);
    }

    for (const commitment of violations) removed.add(commitment);
  }

  throw new Error('CONSTRAINT_RECOMPUTE_DID_NOT_CONVERGE');
}

/** Recomputes the reference result and rejects any altered candidate. */
export function verifyBatchSolution(input: BatchInputV1, candidate: BatchSolutionV1): boolean {
  return isValidBatchSolution(clearBatch(input), candidate);
}

export type {
  BatchInputV1,
  BatchSolutionPayloadV1,
  BatchSolutionV1,
  BatchSolutionWireV1,
  ClearResult,
  Fill,
  FillWireV1,
  MatchingOrderV1,
  Order,
  Side,
  TimeInForce,
} from './types.js';
