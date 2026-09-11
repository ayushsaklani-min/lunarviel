import type { BatchInputV1, MatchingOrderV1 } from './types.js';

export const MARKET_ID = 'NIGHT-USDC';
export const EPOCH_ID = 'epoch-0001';

export function order(
  partial: Partial<MatchingOrderV1> & Pick<MatchingOrderV1, 'commitment' | 'traderTag' | 'side' | 'quantityLots' | 'limitPriceTicks'>,
): MatchingOrderV1 {
  return {
    version: 1,
    marketId: MARKET_ID,
    epochId: EPOCH_ID,
    orderType: 'LIMIT',
    minFillLots: 0n,
    tif: 'GFE',
    allowPartial: true,
    active: true,
    ...partial,
  };
}

export function batch(
  orders: readonly MatchingOrderV1[],
  partial: Partial<Omit<BatchInputV1, 'orders'>> = {},
): BatchInputV1 {
  return {
    version: 1,
    marketId: MARKET_ID,
    epochId: EPOCH_ID,
    ruleVersion: 'fba-limit-v1',
    inputRoot: 'input-root-fixture',
    configHash: 'config-hash-fixture',
    orders,
    ...partial,
  };
}
