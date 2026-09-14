import { describe, expect, it } from "vitest";

import type { EpochV1, MarketV1, MatcherKeyV1 } from "@lunarveil/api-client";

import { validateOrderDraftV1, type OrderDraftV1 } from "./orderDraft";
import { buildSealedOrderV1, ownerSecretForCancellationV1 } from "./sealOrder";

const market: MarketV1 = {
  id: "market-1",
  marketKey: "NIGHT-USDCX",
  baseAssetId: "night",
  quoteAssetId: "usdcx",
  tickSizeAtomic: "5",
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
  orderCount: 1,
  maxOrders: 4,
  scheduledCloseAtMs: "1800000060000",
  ruleVersion: "rules-v1",
  configHash: "ab".repeat(32),
};

const draft: OrderDraftV1 = {
  side: "BUY",
  quantityLots: "500",
  limitPriceTicks: "105",
  minFillLots: "",
  tif: "GFE",
  allowPartial: true,
};

describe("validateOrderDraftV1", () => {
  it("accepts a draft that respects the market's tick and lot sizes", () => {
    expect(validateOrderDraftV1(draft, market, epoch)).toEqual([]);
  });

  it("reports every problem at once rather than one at a time", () => {
    // An order is irreversible once admitted; making a user discover problems
    // one resubmission at a time is the wrong interaction for that.
    const problems = validateOrderDraftV1(
      { ...draft, quantityLots: "150", limitPriceTicks: "103" },
      market,
      epoch,
    );
    expect(problems).toContain("QUANTITY_NOT_LOT_MULTIPLE");
    expect(problems).toContain("PRICE_NOT_TICK_MULTIPLE");
    expect(problems).toHaveLength(2);
  });

  it("rejects empty, non-integer, zero and negative amounts", () => {
    expect(validateOrderDraftV1({ ...draft, quantityLots: "" }, market, epoch))
      .toContain("QUANTITY_REQUIRED");
    expect(validateOrderDraftV1({ ...draft, quantityLots: "1.5" }, market, epoch))
      .toContain("QUANTITY_NOT_INTEGER");
    expect(validateOrderDraftV1({ ...draft, quantityLots: "0" }, market, epoch))
      .toContain("QUANTITY_NOT_INTEGER");
    expect(validateOrderDraftV1({ ...draft, limitPriceTicks: "-5" }, market, epoch))
      .toContain("PRICE_NOT_INTEGER");
  });

  it("keeps integer validation exact and rejects values outside M3's Uint64 proof bound", () => {
    // Deliberately not a lot multiple, and far past what a double can hold.
    const huge = (BigInt(Number.MAX_SAFE_INTEGER) * 1000n + 50n).toString();
    expect(validateOrderDraftV1({ ...draft, quantityLots: huge }, market, epoch))
      .toContain("QUANTITY_NOT_LOT_MULTIPLE");
    const hugeMultiple = ((BigInt(huge) - 50n) * 100n).toString();
    expect(validateOrderDraftV1({ ...draft, quantityLots: hugeMultiple }, market, epoch))
      .toContain("M3_UINT64_BOUND");
  });

  it("rejects a minimum fill above the quantity", () => {
    expect(validateOrderDraftV1({ ...draft, minFillLots: "600" }, market, epoch))
      .toContain("MIN_FILL_ABOVE_QUANTITY");
  });

  it("rejects the M3a features the deployed proof circuit cannot prove", () => {
    expect(validateOrderDraftV1({ ...draft, minFillLots: "1" }, market, epoch))
      .toContain("M3_MIN_FILL_UNSUPPORTED");
    expect(validateOrderDraftV1({ ...draft, tif: "FOK" }, market, epoch))
      .toContain("M3_TIF_UNSUPPORTED");
    expect(validateOrderDraftV1({ ...draft, allowPartial: false }, market, epoch))
      .toContain("M3_PARTIAL_FILL_REQUIRED");
  });

  it("refuses a market or epoch that cannot accept the order", () => {
    expect(validateOrderDraftV1(draft, { ...market, status: "ADMISSION_PAUSED" }, epoch))
      .toContain("MARKET_NOT_ACCEPTING_ORDERS");
    expect(validateOrderDraftV1(draft, market, { ...epoch, state: "CLOSED" }))
      .toContain("EPOCH_NOT_OPEN");
    expect(validateOrderDraftV1(draft, market, undefined)).toContain("EPOCH_NOT_OPEN");
    expect(validateOrderDraftV1(draft, market, { ...epoch, orderCount: 4 })).toContain("EPOCH_FULL");
  });
});

describe("buildSealedOrderV1", () => {
  const matcherKey: MatcherKeyV1 = {
    version: 1,
    keyId: "matcher-ticket-test",
    algorithm: "X25519-HKDF-SHA256-AES-256-GCM",
    publicKey: "",
    activeFromMs: "1799999999999",
    expiresAtMs: "1800000600000",
  };

  async function withRealMatcherKey() {
    const { generateMatcherDecryptionKeyV1, matcherPublicKeyV1 } = await import("@lunarveil/crypto");
    const key = await generateMatcherDecryptionKeyV1({
      keyId: matcherKey.keyId,
      activeFromMs: 1_799_999_999_999n,
      expiresAtMs: 1_800_000_600_000n,
    });
    const published = matcherPublicKeyV1(key);
    return { key, published: { ...matcherKey, publicKey: published.publicKey } };
  }

  it("seals the order so no plaintext field survives on the wire", async () => {
    const { published } = await withRealMatcherKey();
    const sealed = await buildSealedOrderV1({
      draft, market, epoch,
      matcherKey: published,
      traderTagHash: "cd".repeat(32),
      clientRequestId: crypto.randomUUID(),
      nowMs: 1_800_000_000_000n,
      lifetimeMs: 3_600_000n,
    });

    const wire = JSON.stringify(sealed.envelope);
    // Side, price and quantity must not appear anywhere in the request body.
    expect(wire).not.toContain("BUY");
    expect(wire).not.toContain("500");
    expect(wire).not.toContain("105");
    expect(sealed.commitment).toMatch(/^[0-9a-f]{64}$/u);
    expect(sealed.envelope.marketId).toBe("market-1");
    expect(sealed.envelope.traderTagHash).toBe("cd".repeat(32));
  });

  it("produces a different commitment for every order, on identical input", async () => {
    // A fresh blinding and nonce per order: two identical drafts must not be
    // linkable by their commitments.
    const { published } = await withRealMatcherKey();
    const build = async () => buildSealedOrderV1({
      draft, market, epoch,
      matcherKey: published,
      traderTagHash: "cd".repeat(32),
      clientRequestId: crypto.randomUUID(),
      nowMs: 1_800_000_000_000n,
      lifetimeMs: 3_600_000n,
    });

    const [first, second] = await Promise.all([build(), build()]);
    expect(first.commitment).not.toBe(second.commitment);
    expect(first.envelope.ciphertext).not.toBe(second.envelope.ciphertext);
  });

  it("round-trips the order back to the matcher's key", async () => {
    const { key, published } = await withRealMatcherKey();
    const { withOpenedOrderEnvelopeV1 } = await import("@lunarveil/crypto");

    const sealed = await buildSealedOrderV1({
      draft, market, epoch,
      matcherKey: published,
      traderTagHash: "cd".repeat(32),
      clientRequestId: crypto.randomUUID(),
      nowMs: 1_800_000_000_000n,
      lifetimeMs: 3_600_000n,
    });

    const opened = await withOpenedOrderEnvelopeV1(
      sealed.envelope as never,
      key,
      plain => JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>,
    );
    expect(opened.side).toBe("BUY");
    expect(opened.quantityLots).toBe("500");
    // Integers stay decimal strings through the plaintext too.
    expect(typeof opened.limitPriceTicks).toBe("string");
    const { deriveOwnerAuthorizationV1 } = await import("@lunarveil/crypto");
    const ownerSecret = await ownerSecretForCancellationV1(sealed.commitment);
    expect(ownerSecret).toBeDefined();
    expect(Array.from(deriveOwnerAuthorizationV1(ownerSecret!))).toEqual(
      Array.from(Buffer.from(opened.ownerPublicKey as string, "hex")),
    );
    ownerSecret!.fill(0);
  });
});
