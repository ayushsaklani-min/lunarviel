import type { TraderOrderStateV1, TraderOrderV1 } from "@lunarveil/api-client";

/**
 * How an order's lifecycle state should read to the trader who placed it.
 *
 * The wording is deliberately literal. `PENDING_CHAIN` in particular must not
 * be dressed up as "submitted" or "processing": until an admission
 * transaction exists on chain, the order is not admitted, and nothing in this
 * system creates one yet.
 */
export function orderStateLabelV1(state: TraderOrderStateV1): string {
  switch (state) {
    case "PENDING_CHAIN": return "Awaiting chain admission";
    case "ACCEPTED": return "Admitted on chain";
    case "RESERVED": return "Reserved for matching";
    case "PARTIALLY_FILLED": return "Partially filled";
    case "FILLED": return "Filled";
    case "CANCEL_PENDING": return "Cancellation requested";
    case "CANCELLED": return "Cancelled";
    case "EXPIRED": return "Expired";
    case "REJECTED": return "Rejected";
  }
}

/**
 * Short names for the lifecycle pills.
 *
 * The full label already appears as the order's headline; repeating it in the
 * track said the same thing twice on every row.
 */
export function orderLifecycleStepLabelV1(state: TraderOrderStateV1): string {
  switch (state) {
    case "PENDING_CHAIN": return "Pending";
    case "ACCEPTED": return "Admitted";
    case "RESERVED": return "Reserved";
    case "PARTIALLY_FILLED": return "Partial";
    case "FILLED": return "Filled";
    default: return orderStateLabelV1(state);
  }
}

export type OrderProgressToneV1 = "waiting" | "live" | "settled" | "ended";

export function orderProgressToneV1(state: TraderOrderStateV1): OrderProgressToneV1 {
  switch (state) {
    case "PENDING_CHAIN":
    case "CANCEL_PENDING":
      return "waiting";
    case "ACCEPTED":
    case "RESERVED":
      return "live";
    case "PARTIALLY_FILLED":
    case "FILLED":
      return "settled";
    case "CANCELLED":
    case "EXPIRED":
    case "REJECTED":
      return "ended";
  }
}

/**
 * The ordered lifecycle a healthy order walks, for a progress display.
 *
 * Terminal states are not on this path: an order that was cancelled, expired
 * or rejected left it rather than advanced along it.
 */
export const ORDER_LIFECYCLE_PATH_V1: readonly TraderOrderStateV1[] = [
  "PENDING_CHAIN", "ACCEPTED", "RESERVED", "PARTIALLY_FILLED", "FILLED",
];

export function orderLifecycleStepV1(state: TraderOrderStateV1): number | undefined {
  const index = ORDER_LIFECYCLE_PATH_V1.indexOf(state);
  return index < 0 ? undefined : index;
}

/** Whether this order can still make progress, or has reached an end. */
export function isTerminalOrderStateV1(state: TraderOrderStateV1): boolean {
  return orderProgressToneV1(state) === "ended" || state === "FILLED";
}

/** Short, absolute UTC rendering from canonical decimal milliseconds. */
export function formatTimestampV1(decimalMs: string): string {
  if (!/^[0-9]+$/u.test(decimalMs)) return "—";
  const value = BigInt(decimalMs);
  // Beyond this a Date cannot represent the instant; say so rather than show
  // "Invalid Date".
  if (value > 8_640_000_000_000_000n) return "—";
  return new Date(Number(value)).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function shortenHashV1(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

/**
 * Groups orders by epoch, newest first within each group.
 *
 * Orders arrive newest-first from the API; this preserves that order inside
 * each epoch rather than re-sorting, so what a trader sees matches what the
 * server considers most recent.
 */
export function groupOrdersByEpochV1(
  orders: readonly TraderOrderV1[],
): readonly { readonly epochId: string; readonly orders: readonly TraderOrderV1[] }[] {
  const groups = new Map<string, TraderOrderV1[]>();
  for (const order of orders) {
    const existing = groups.get(order.epochId);
    if (existing === undefined) groups.set(order.epochId, [order]);
    else existing.push(order);
  }
  return [...groups.entries()].map(([epochId, grouped]) => ({ epochId, orders: grouped }));
}
