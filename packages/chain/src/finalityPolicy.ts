export type FinalityOutcomeV1 = 'CONFIRMED' | 'IMMATURE' | 'INVALID';

export interface BlockDepthFinalityInputV1 {
  readonly inclusionHeight: bigint;
  readonly tipHeight: bigint;
  readonly confirmationDepth: number;
}

/**
 * Pure depth rule. No clock, no network, no state.
 *
 * `INVALID` covers any input we cannot reason about — a tip behind the
 * inclusion, negative heights, a malformed depth. It is never treated as
 * confirmation: an unreadable chain view must not admit an order.
 */
export function evaluateBlockDepthFinalityV1(input: BlockDepthFinalityInputV1): FinalityOutcomeV1 {
  const { inclusionHeight, tipHeight, confirmationDepth } = input;
  if (typeof inclusionHeight !== 'bigint' || typeof tipHeight !== 'bigint') return 'INVALID';
  if (inclusionHeight < 0n || tipHeight < 0n) return 'INVALID';
  if (!Number.isSafeInteger(confirmationDepth) || confirmationDepth < 0) return 'INVALID';
  if (tipHeight < inclusionHeight) return 'INVALID';
  return tipHeight - inclusionHeight >= BigInt(confirmationDepth) ? 'CONFIRMED' : 'IMMATURE';
}
