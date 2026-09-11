import { describe, expect, it } from "vitest";

import type { EpochV1, MarketV1 } from "@lunarveil/api-client";

import {
  epochCapacityPercentV1,
  epochStateLabelV1,
  formatAtomicV1,
  formatEpochCountdownV1,
  marketAvailabilityV1,
  marketPairLabelV1,
  marketStatusLabelV1,
} from "./marketFormat";

const market: MarketV1 = {
  id: "market-1",
  marketKey: "NIGHT-USDCX",
  baseAssetId: "night",
  quoteAssetId: "usdcx",
  tickSizeAtomic: "1",
  lotSizeAtomic: "100",
  epochDurationSeconds: 60,
  maxOrdersPerEpoch: 4,
  minBatchPrivacy: 2,
  matchingRuleVersion: "rules-v1",
  status: "ACTIVE",
};

const epoch: EpochV1 = {
  id: "epoch-1",
  marketId: "market-1",
  sequence: "7",
  state: "OPEN",
  orderCount: 3,
  maxOrders: 4,
  scheduledCloseAtMs: "1800000060000",
  ruleVersion: "rules-v1",
  configHash: "ab".repeat(32),
};

describe("formatAtomicV1", () => {
  it("groups a decimal string without ever parsing it to a number", () => {
    expect(formatAtomicV1("1")).toBe("1");
    expect(formatAtomicV1("1000")).toBe("1,000");
    expect(formatAtomicV1("123456789")).toBe("123,456,789");
    // Beyond Number.MAX_SAFE_INTEGER: parsing would silently corrupt this.
    const huge = "123456789012345678901234567890";
    expect(formatAtomicV1(huge).replaceAll(",", "")).toBe(huge);
  });

  it("refuses anything that is not a canonical decimal", () => {
    expect(formatAtomicV1("1.5")).toBe("—");
    expect(formatAtomicV1("-1")).toBe("—");
    expect(formatAtomicV1("")).toBe("—");
  });
});

describe("market labels", () => {
  it("renders the trading pair and status", () => {
    expect(marketPairLabelV1(market)).toBe("NIGHT / USDCX");
    expect(marketStatusLabelV1(market)).toBe("Accepting orders");
  });

  it("treats admission-paused and settlement-only as restricted, not closed", () => {
    // Existing orders still settle; calling either "closed" would misstate it.
    expect(marketAvailabilityV1({ ...market, status: "ADMISSION_PAUSED" })).toBe("RESTRICTED");
    expect(marketAvailabilityV1({ ...market, status: "SETTLEMENT_ONLY" })).toBe("RESTRICTED");
    expect(marketAvailabilityV1({ ...market, status: "DISABLED" })).toBe("CLOSED");
    expect(marketAvailabilityV1(market)).toBe("OPEN");
  });
});

describe("formatEpochCountdownV1", () => {
  it("counts down in minutes and hours from bigint milliseconds", () => {
    expect(formatEpochCountdownV1(1_800_000_000_000n, "1800000060000")).toBe("1m 00s");
    expect(formatEpochCountdownV1(1_800_000_000_000n, "1800003725000")).toBe("1h 02m 05s");
  });

  it("reports a passed close time rather than a negative countdown", () => {
    // An epoch past its scheduled close that has not advanced is a real
    // operational condition, not a rendering edge case to hide.
    expect(formatEpochCountdownV1(1_800_000_120_000n, "1800000060000")).toBe("Close time passed");
    expect(formatEpochCountdownV1(1_800_000_060_000n, "1800000060000")).toBe("Close time passed");
  });

  it("refuses a malformed close time", () => {
    expect(formatEpochCountdownV1(0n, "not-a-number")).toBe("—");
  });
});

describe("epoch panel helpers", () => {
  it("labels every epoch state", () => {
    expect(epochStateLabelV1(epoch)).toBe("Collecting orders");
    expect(epochStateLabelV1({ ...epoch, state: "PENDING_FIRMUP" })).toBe("Awaiting participant firm-up");
  });

  it("clamps capacity to a whole percentage", () => {
    expect(epochCapacityPercentV1(epoch)).toBe(75);
    expect(epochCapacityPercentV1({ ...epoch, orderCount: 0 })).toBe(0);
    expect(epochCapacityPercentV1({ ...epoch, orderCount: 9, maxOrders: 4 })).toBe(100);
  });
});
