import { describe, expect, it } from "vitest";

import {
  HistoricOrderCommitmentTree,
  ORDER_COMMITMENT_DOMAIN_V1,
  ORDER_NULLIFIER_DOMAIN_V1,
  OWNER_AUTHORIZATION_DOMAIN_V1,
  bytes32FromHex,
  bytesToHex,
  cloneOrderIntentV1,
  commitOrderIntentV1,
  deriveOrderNullifierV1,
  deriveOwnerAuthorizationV1,
  generateCommitmentBlinding,
  generateNullifierSecret,
  generateOrderNonce,
  type OrderIntentV1,
} from "./index.js";

const hex = (byte: string): Uint8Array => bytes32FromHex(byte.repeat(64));

function sampleOrder(overrides: Partial<OrderIntentV1> = {}): OrderIntentV1 {
  return {
    version: 1,
    marketId: hex("1"),
    epochSequence: 7n,
    ownerPublicKey: hex("2"),
    side: "BUY",
    orderType: "LIMIT",
    quantityLots: 125n,
    limitPriceTicks: 42_000n,
    minFillLots: 25n,
    tif: "GFE",
    allowPartial: true,
    nonce: hex("3"),
    createdAtMs: 1_800_000_000_000n,
    expiresAtMs: 1_800_000_060_000n,
    ...overrides,
  };
}

describe("Compact-compatible V1 commitments", () => {
  it("locks padded domain bytes", () => {
    expect(bytesToHex(ORDER_COMMITMENT_DOMAIN_V1)).toBe(
      "4c554e41525645494c5f4f524445525f56310000000000000000000000000000",
    );
    expect(bytesToHex(ORDER_NULLIFIER_DOMAIN_V1)).toBe(
      "4c554e41525645494c5f4e554c4c49464945525f563100000000000000000000",
    );
    expect(bytesToHex(OWNER_AUTHORIZATION_DOMAIN_V1)).toBe(
      "4c554e41525645494c5f4f574e45525f56310000000000000000000000000000",
    );
  });

  it("matches the pinned runtime commitment vector", () => {
    expect(bytesToHex(commitOrderIntentV1(sampleOrder(), hex("a")))).toBe(
      "5c9aa616a5b2c4d15076d8af9b3351184ddeb850486abaafccbdd14ddf420fa8",
    );
  });

  it("changes when any committed semantic field changes", () => {
    const base = bytesToHex(commitOrderIntentV1(sampleOrder(), hex("a")));
    const variants: OrderIntentV1[] = [
      sampleOrder({ marketId: hex("4") }),
      sampleOrder({ epochSequence: 8n }),
      sampleOrder({ ownerPublicKey: hex("5") }),
      sampleOrder({ side: "SELL" }),
      sampleOrder({ quantityLots: 126n }),
      sampleOrder({ limitPriceTicks: 42_001n }),
      sampleOrder({ minFillLots: 26n }),
      sampleOrder({ tif: "IOC" }),
      sampleOrder({ allowPartial: false }),
      sampleOrder({ nonce: hex("6") }),
      sampleOrder({ createdAtMs: 1_800_000_000_001n }),
      sampleOrder({ expiresAtMs: 1_800_000_060_001n }),
    ];

    for (const variant of variants) {
      expect(bytesToHex(commitOrderIntentV1(variant, hex("a")))).not.toBe(base);
    }
    expect(bytesToHex(commitOrderIntentV1(sampleOrder(), hex("b")))).not.toBe(base);
  });

  it("fails closed on malformed or invalid private inputs", () => {
    expect(() => commitOrderIntentV1(sampleOrder(), new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => commitOrderIntentV1(sampleOrder({ marketId: new Uint8Array(31) }), hex("a"))).toThrow(/marketId/);
    expect(() => commitOrderIntentV1(sampleOrder({ quantityLots: 0n }), hex("a"))).toThrow(/positive/);
    expect(() => commitOrderIntentV1(sampleOrder({ limitPriceTicks: 0n }), hex("a"))).toThrow(/positive/);
    expect(() => commitOrderIntentV1(sampleOrder({ minFillLots: 126n }), hex("a"))).toThrow(/exceed/);
    expect(() => commitOrderIntentV1(sampleOrder({ epochSequence: 1n << 64n }), hex("a"))).toThrow(/epochSequence/);
    expect(() => commitOrderIntentV1(sampleOrder({ expiresAtMs: 1_800_000_000_000n }), hex("a"))).toThrow(/greater/);
  });

  it("clones byte fields instead of aliasing private input", () => {
    const original = sampleOrder();
    const cloned = cloneOrderIntentV1(original);
    cloned.marketId[0] = 255;
    cloned.ownerPublicKey[0] = 255;
    cloned.nonce[0] = 255;
    expect(original.marketId[0]).toBe(17);
    expect(original.ownerPublicKey[0]).toBe(34);
    expect(original.nonce[0]).toBe(51);
  });
});

describe("logical order nullifiers", () => {
  it("derives a deterministic domain-separated owner authorization", () => {
    expect(bytesToHex(deriveOwnerAuthorizationV1(hex("c")))).toBe(
      "b77b6fcd85ac9a8dfc1da5390e0422519c1019332d3f0a76c69c500fc1680368",
    );
    expect(bytesToHex(deriveOwnerAuthorizationV1(hex("d")))).not.toBe(
      bytesToHex(deriveOwnerAuthorizationV1(hex("c"))),
    );
    expect(() => deriveOwnerAuthorizationV1(new Uint8Array(31))).toThrow(/ownerSecret/);
  });

  it("matches the pinned runtime vector and is domain-separated", () => {
    const commitment = commitOrderIntentV1(sampleOrder(), hex("a"));
    const nullifier = deriveOrderNullifierV1(commitment, hex("c"));
    expect(bytesToHex(nullifier)).toBe(
      "9d76225398cfaad401b39a1e5da36b5a8bd026c2dfc9be6dd3060bb6c732b2c7",
    );
    expect(bytesToHex(nullifier)).not.toBe(bytesToHex(commitment));
  });

  it("rejects malformed values and changes with either input", () => {
    const commitment = commitOrderIntentV1(sampleOrder(), hex("a"));
    const base = bytesToHex(deriveOrderNullifierV1(commitment, hex("c")));
    expect(bytesToHex(deriveOrderNullifierV1(commitment, hex("d")))).not.toBe(base);
    expect(bytesToHex(deriveOrderNullifierV1(hex("e"), hex("c")))).not.toBe(base);
    expect(() => deriveOrderNullifierV1(new Uint8Array(31), hex("c"))).toThrow(/orderCommitment/);
    expect(() => deriveOrderNullifierV1(commitment, new Uint8Array(31))).toThrow(/nullifierSecret/);
  });
});

describe("bounded historic order commitment tree", () => {
  it("retains old roots and verifies inclusion at an exact index", () => {
    const tree = new HistoricOrderCommitmentTree(2);
    const first = tree.append(hex("1"));
    const second = tree.append(hex("2"));

    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(first.root.toString()).toBe(
      "2304739976363195353239503522494333494478817612373517602076446812126654243204",
    );
    expect(second.root.toString()).toBe(
      "15906984212109734182360263182330093433028680099195770903181808287352314591201",
    );
    expect(tree.isKnownRoot(first.root)).toBe(true);
    expect(tree.verifyInclusion(hex("1"), 0, first.root)).toBe(true);
    expect(tree.verifyInclusion(hex("1"), 0, second.root)).toBe(true);
    expect(tree.verifyInclusion(hex("2"), 1, first.root)).toBe(false);
    expect(tree.verifyInclusion(hex("2"), 0, second.root)).toBe(false);
    expect(tree.verifyInclusion(hex("3"), 1, second.root)).toBe(false);
    expect(tree.verifyInclusion(hex("2"), 1, second.root + 1n)).toBe(false);
  });

  it("is append-only, bounded, and defensive about byte ownership", () => {
    const tree = new HistoricOrderCommitmentTree(2);
    const mutable = hex("1");
    tree.append(mutable);
    mutable[0] = 255;
    expect(tree.leaf(0)?.[0]).toBe(17);

    tree.append(hex("2"));
    tree.append(hex("3"));
    tree.append(hex("4"));
    expect(() => tree.append(hex("5"))).toThrow(/full/);
    expect(() => tree.append(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("private randomness helpers", () => {
  it("produce fresh 32-byte values", () => {
    const values = [generateCommitmentBlinding(), generateOrderNonce(), generateNullifierSecret()];
    expect(values.every((value) => value.length === 32)).toBe(true);
    expect(new Set(values.map(bytesToHex)).size).toBe(3);
  });
});
