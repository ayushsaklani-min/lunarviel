import { describe, expect, it } from "vitest";

import type { TraderOrderV1 } from "@lunarveil/api-client";

import {
  ORDER_LIFECYCLE_PATH_V1,
  formatTimestampV1,
  groupOrdersByEpochV1,
  isTerminalOrderStateV1,
  orderLifecycleStepLabelV1,
  orderLifecycleStepV1,
  orderProgressToneV1,
  orderStateLabelV1,
  shortenHashV1,
} from "./orderLifecycle";

function order(overrides: Partial<TraderOrderV1> = {}): TraderOrderV1 {
  return {
    orderId: "order-1",
    clientRequestId: "4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c",
    marketId: "market-1",
    epochId: "epoch-1",
    commitment: "ab".repeat(32),
    state: "PENDING_CHAIN",
    createdAtMs: "1800000000000",
    ...overrides,
  };
}

describe("orderStateLabelV1", () => {
  it("describes a pending order as awaiting admission, not as submitted", () => {
    // "Submitted" or "processing" would imply the order is on its way onto
    // the chain. Nothing creates an admission transaction, so it is not.
    expect(orderStateLabelV1("PENDING_CHAIN")).toBe("Awaiting chain admission");
    expect(orderStateLabelV1("ACCEPTED")).toBe("Admitted on chain");
  });

  it("labels every state", () => {
    const states = [
      "PENDING_CHAIN", "ACCEPTED", "RESERVED", "PARTIALLY_FILLED", "FILLED",
      "CANCEL_PENDING", "CANCELLED", "EXPIRED", "REJECTED",
    ] as const;
    for (const state of states) {
      expect(orderStateLabelV1(state).length).toBeGreaterThan(0);
    }
  });
});

describe("orderLifecycleStepLabelV1", () => {
  it("uses short pill names so the headline is not repeated", () => {
    expect(orderLifecycleStepLabelV1("PENDING_CHAIN")).toBe("Pending");
    expect(orderLifecycleStepLabelV1("ACCEPTED")).toBe("Admitted");
    expect(orderLifecycleStepLabelV1("PENDING_CHAIN")).not.toBe(orderStateLabelV1("PENDING_CHAIN"));
  });
});

describe("lifecycle position", () => {
  it("places live states on the path and terminal ones off it", () => {
    expect(orderLifecycleStepV1("PENDING_CHAIN")).toBe(0);
    expect(orderLifecycleStepV1("FILLED")).toBe(ORDER_LIFECYCLE_PATH_V1.length - 1);
    // Cancelled, expired and rejected orders left the path; they did not
    // advance along it.
    expect(orderLifecycleStepV1("CANCELLED")).toBeUndefined();
    expect(orderLifecycleStepV1("EXPIRED")).toBeUndefined();
    expect(orderLifecycleStepV1("REJECTED")).toBeUndefined();
  });

  it("tones states by how much attention they deserve", () => {
    expect(orderProgressToneV1("PENDING_CHAIN")).toBe("waiting");
    expect(orderProgressToneV1("ACCEPTED")).toBe("live");
    expect(orderProgressToneV1("FILLED")).toBe("settled");
    expect(orderProgressToneV1("REJECTED")).toBe("ended");
  });

  it("treats filled and every ended state as terminal", () => {
    expect(isTerminalOrderStateV1("FILLED")).toBe(true);
    expect(isTerminalOrderStateV1("CANCELLED")).toBe(true);
    expect(isTerminalOrderStateV1("PENDING_CHAIN")).toBe(false);
    expect(isTerminalOrderStateV1("PARTIALLY_FILLED")).toBe(false);
  });
});

describe("formatTimestampV1", () => {
  it("renders an absolute UTC instant", () => {
    expect(formatTimestampV1("1800000000000")).toBe("2027-01-15 08:00:00Z");
  });

  it("refuses a malformed or unrepresentable instant instead of showing Invalid Date", () => {
    expect(formatTimestampV1("not-a-number")).toBe("—");
    expect(formatTimestampV1("99999999999999999")).toBe("—");
  });
});

describe("shortenHashV1", () => {
  it("shortens long hashes and leaves short values alone", () => {
    expect(shortenHashV1("ab".repeat(32))).toContain("…");
    expect(shortenHashV1("epoch-1")).toBe("epoch-1");
  });
});

describe("groupOrdersByEpochV1", () => {
  it("groups by epoch and preserves the order the API returned", () => {
    const grouped = groupOrdersByEpochV1([
      order({ orderId: "a", epochId: "epoch-2" }),
      order({ orderId: "b", epochId: "epoch-1" }),
      order({ orderId: "c", epochId: "epoch-2" }),
    ]);

    expect(grouped.map(group => group.epochId)).toEqual(["epoch-2", "epoch-1"]);
    expect(grouped[0]?.orders.map(item => item.orderId)).toEqual(["a", "c"]);
  });

  it("returns nothing for no orders", () => {
    expect(groupOrdersByEpochV1([])).toEqual([]);
  });
});
