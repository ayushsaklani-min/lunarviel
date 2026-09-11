import { describe, expect, it } from "vitest";

import {
  OrderCommitmentLedgerV1,
  bytes32FromHex,
} from "./index.js";

const hex = (byte: string): Uint8Array => bytes32FromHex(byte.repeat(64));

describe("M2 order commitment state transitions", () => {
  it("admits idempotently and freezes an exact epoch range/root", () => {
    const ledger = new OrderCommitmentLedgerV1(9n);
    const first = ledger.submitOrderCommitment("admit-0001", 9n, hex("1"));
    const replay = ledger.submitOrderCommitment("admit-0001", 9n, hex("1"));
    const second = ledger.submitOrderCommitment("admit-0002", 9n, hex("2"));
    const frozen = ledger.closeEpoch("close-0001", 9n);

    expect(replay).toEqual(first);
    expect(second.index).toBe(1);
    expect(frozen).toEqual({
      sequence: 9n,
      startIndex: 0,
      endIndexExclusive: 2,
      orderCount: 2,
      closeRoot: second.root,
    });
    expect(ledger.closeEpoch("close-0001", 9n)).toEqual(frozen);
    expect(() => ledger.submitOrderCommitment("admit-0003", 9n, hex("3"))).toThrow(/closed/);
  });

  it("fails closed for wrong epoch and conflicting idempotency reuse", () => {
    const ledger = new OrderCommitmentLedgerV1(9n);
    expect(() => ledger.submitOrderCommitment("admit-0001", 8n, hex("1"))).toThrow(/wrong epoch/);
    ledger.submitOrderCommitment("admit-0001", 9n, hex("1"));
    expect(() => ledger.submitOrderCommitment("admit-0001", 9n, hex("2"))).toThrow(/different admission/);
    expect(() => ledger.closeEpoch("close-0001", 8n)).toThrow(/wrong epoch/);
  });

  it("consumes cancellation nullifiers once and preserves idempotent replay", () => {
    const ledger = new OrderCommitmentLedgerV1(9n);
    ledger.submitOrderCommitment("admit-0001", 9n, hex("1"));
    ledger.closeEpoch("close-0001", 9n);

    const receipt = ledger.cancelAtFrozenRoot("cancel-0001", 9n, 0, hex("1"), hex("a"));
    expect(ledger.cancelAtFrozenRoot("cancel-0001", 9n, 0, hex("1"), hex("a"))).toEqual(receipt);
    expect(ledger.isNullifierConsumed(hex("a"))).toBe(true);
    expect(() => ledger.cancelAtFrozenRoot("cancel-0002", 9n, 0, hex("1"), hex("a"))).toThrow(/already consumed/);
    expect(() => ledger.cancelAtFrozenRoot("cancel-0001", 9n, 0, hex("1"), hex("b"))).toThrow(/different cancellation/);
  });

  it("rejects cancellation before close or with wrong root membership data", () => {
    const ledger = new OrderCommitmentLedgerV1(9n);
    ledger.submitOrderCommitment("admit-0001", 9n, hex("1"));
    expect(() => ledger.cancelAtFrozenRoot("cancel-0001", 9n, 0, hex("1"), hex("a"))).toThrow(/not closed/);
    ledger.closeEpoch("close-0001", 9n);

    expect(() => ledger.cancelAtFrozenRoot("cancel-0002", 8n, 0, hex("1"), hex("b"))).toThrow(/wrong epoch/);
    expect(() => ledger.cancelAtFrozenRoot("cancel-0003", 9n, 1, hex("1"), hex("c"))).toThrow(/outside/);
    expect(() => ledger.cancelAtFrozenRoot("cancel-0004", 9n, 0, hex("2"), hex("d"))).toThrow(/not included/);
  });
});
