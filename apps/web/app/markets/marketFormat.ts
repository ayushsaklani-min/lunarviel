import type { EpochV1, MarketV1 } from '@lunarveil/api-client';

/**
 * Display helpers for public market data.
 *
 * Every atomic quantity stays a `bigint` end to end. Nothing here calls
 * `Number()` on a market value: a display layer that quietly rounds is how
 * float error gets back into a system that forbids it.
 */

const GROUP_PATTERN = /\B(?=(\d{3})+(?!\d))/gu;

/** Groups a canonical decimal string in threes without parsing it. */
export function formatAtomicV1(decimal: string): string {
  if (!/^[0-9]+$/u.test(decimal)) return '—';
  return decimal.replace(GROUP_PATTERN, ',');
}

export function marketPairLabelV1(market: MarketV1): string {
  return `${market.baseAssetId.toUpperCase()} / ${market.quoteAssetId.toUpperCase()}`;
}

export type MarketAvailabilityV1 = 'OPEN' | 'RESTRICTED' | 'CLOSED';

/**
 * How a market's status should read to a user.
 *
 * `ADMISSION_PAUSED` is `RESTRICTED`, not `CLOSED`: existing orders still
 * settle, and describing it as closed would misstate what the system is doing.
 */
export function marketAvailabilityV1(market: MarketV1): MarketAvailabilityV1 {
  if (market.status === 'ACTIVE') return 'OPEN';
  if (market.status === 'DISABLED') return 'CLOSED';
  return 'RESTRICTED';
}

export function marketStatusLabelV1(market: MarketV1): string {
  switch (market.status) {
    case 'ACTIVE': return 'Accepting orders';
    case 'ADMISSION_PAUSED': return 'Admission paused';
    case 'SETTLEMENT_ONLY': return 'Settlement only';
    case 'DISABLED': return 'Disabled';
  }
}

export function epochStateLabelV1(epoch: EpochV1): string {
  switch (epoch.state) {
    case 'OPEN': return 'Collecting orders';
    case 'CLOSED': return 'Closed for matching';
    case 'PROVING': return 'Proving the batch';
    case 'PENDING_FIRMUP': return 'Awaiting participant firm-up';
    case 'SETTLING': return 'Settling';
    case 'FINALIZED': return 'Finalized';
    case 'RECOMPUTE': return 'Recomputing';
    case 'INVALIDATED': return 'Invalidated';
  }
}

/**
 * Renders the time left in an epoch from two millisecond values, as bigints.
 *
 * A close time already in the past is reported as such rather than as a
 * negative countdown — an epoch whose scheduled close has passed but whose
 * state has not advanced is a real condition an operator should see.
 */
export function formatEpochCountdownV1(nowMs: bigint, scheduledCloseAtMs: string): string {
  if (!/^[0-9]+$/u.test(scheduledCloseAtMs)) return '—';
  const remainingMs = BigInt(scheduledCloseAtMs) - nowMs;
  if (remainingMs <= 0n) return 'Close time passed';

  const totalSeconds = remainingMs / 1000n;
  const hours = totalSeconds / 3600n;
  const minutes = (totalSeconds % 3600n) / 60n;
  const seconds = totalSeconds % 60n;
  const pad = (value: bigint): string => value.toString().padStart(2, '0');
  return hours > 0n
    ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
    : `${minutes}m ${pad(seconds)}s`;
}

/** Fill of the epoch's order capacity, as a whole percentage. */
export function epochCapacityPercentV1(epoch: EpochV1): number {
  if (epoch.maxOrders <= 0) return 0;
  return Math.min(100, Math.round((epoch.orderCount / epoch.maxOrders) * 100));
}
