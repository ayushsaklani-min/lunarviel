import type { EpochV1, MarketV1 } from "@lunarveil/api-client";
import type { OrderSideV1, TimeInForceV1 } from "@lunarveil/crypto";

/**
 * Draft validation for the order ticket.
 *
 * This module is deliberately free of any value import from
 * `@lunarveil/crypto`: that package pulls in the Compact runtime's
 * WebAssembly, which cannot be instantiated while server-rendering this
 * route. Sealing lives in `sealOrder.ts` and is imported dynamically, in the
 * browser, at submit time. See ADR-0040.
 *
 * Every quantity is a `bigint` from the moment it leaves the input field.
 * Nothing here calls `Number()` on a market value, so no rounding can enter
 * between what a user typed and what gets committed.
 */

export interface OrderDraftV1 {
  readonly side: OrderSideV1;
  /** Decimal string, as typed. */
  readonly quantityLots: string;
  /** Decimal string, as typed. */
  readonly limitPriceTicks: string;
  /** Decimal string, as typed. Empty means zero. */
  readonly minFillLots: string;
  readonly tif: TimeInForceV1;
  readonly allowPartial: boolean;
}

export type OrderDraftProblemV1 =
  | "QUANTITY_REQUIRED"
  | "QUANTITY_NOT_INTEGER"
  | "QUANTITY_NOT_LOT_MULTIPLE"
  | "PRICE_REQUIRED"
  | "PRICE_NOT_INTEGER"
  | "PRICE_NOT_TICK_MULTIPLE"
  | "MIN_FILL_NOT_INTEGER"
  | "MIN_FILL_ABOVE_QUANTITY"
  | "MARKET_NOT_ACCEPTING_ORDERS"
  | "EPOCH_NOT_OPEN"
  | "EPOCH_FULL";

const DECIMAL_PATTERN = /^[0-9]+$/u;

function parsePositive(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return undefined;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : undefined;
}

/**
 * Every reason this draft cannot be submitted, not just the first.
 *
 * Reporting one problem at a time makes a user fix, resubmit and discover the
 * next; for an order that will be irreversible once admitted, showing all of
 * them at once is the safer interaction.
 */
export function validateOrderDraftV1(
  draft: OrderDraftV1,
  market: MarketV1,
  epoch: EpochV1 | undefined,
): readonly OrderDraftProblemV1[] {
  const problems: OrderDraftProblemV1[] = [];

  const quantity = parsePositive(draft.quantityLots);
  if (draft.quantityLots.trim() === "") problems.push("QUANTITY_REQUIRED");
  else if (quantity === undefined) problems.push("QUANTITY_NOT_INTEGER");
  else if (quantity % BigInt(market.lotSizeAtomic) !== 0n) problems.push("QUANTITY_NOT_LOT_MULTIPLE");

  const price = parsePositive(draft.limitPriceTicks);
  if (draft.limitPriceTicks.trim() === "") problems.push("PRICE_REQUIRED");
  else if (price === undefined) problems.push("PRICE_NOT_INTEGER");
  else if (price % BigInt(market.tickSizeAtomic) !== 0n) problems.push("PRICE_NOT_TICK_MULTIPLE");

  const minFillText = draft.minFillLots.trim();
  if (minFillText !== "") {
    if (!DECIMAL_PATTERN.test(minFillText)) problems.push("MIN_FILL_NOT_INTEGER");
    else if (quantity !== undefined && BigInt(minFillText) > quantity) problems.push("MIN_FILL_ABOVE_QUANTITY");
  }

  if (market.status !== "ACTIVE") problems.push("MARKET_NOT_ACCEPTING_ORDERS");
  if (epoch === undefined || epoch.state !== "OPEN") problems.push("EPOCH_NOT_OPEN");
  else if (epoch.orderCount >= epoch.maxOrders) problems.push("EPOCH_FULL");

  return problems;
}
