import type { EpochV1, MarketV1, MatcherKeyV1, OrderEnvelopeWireV1 } from "@lunarveil/api-client";
import {
  commitOrderIntentV1,
  deriveOwnerAuthorizationV1,
  generateCommitmentBlinding,
  sealOrderEnvelopeV1,
  type OrderIntentV1,
} from "@lunarveil/crypto";

import type { OrderDraftV1 } from "./orderDraft";
import { ownerSecretForCancellationV1, retainOwnerSecretV1 } from "./ownerSecretVault";

/**
 * Commitment and envelope sealing.
 *
 * Kept apart from draft validation because importing `@lunarveil/crypto`
 * loads the Compact runtime's WebAssembly, which fails during server-side
 * rendering. Import this module dynamically, from a browser event handler
 * only.
 */

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export interface SealedOrderV1 {
  readonly envelope: OrderEnvelopeWireV1;
  readonly commitment: string;
}

// Cancellation witnesses are browser-private. The vault persists only
// AES-GCM ciphertext plus a non-extractable browser CryptoKey; raw secrets
// never enter localStorage, the API, matcher, database, logs or chain state.
export { ownerSecretForCancellationV1 } from "./ownerSecretVault";

/**
 * Builds the commitment and the sealed envelope for one order.
 *
 * The commitment uses `@lunarveil/crypto`'s compiler-matching implementation,
 * so the value here is the one the Compact circuit would derive. The
 * plaintext buffer is zeroed as soon as it is sealed; the blinding and nonce
 * are fresh per order.
 *
 * The matcher can decrypt this envelope — that is the V1 trust model, and the
 * UI must never claim otherwise.
 */
export async function buildSealedOrderV1(input: {
  readonly draft: OrderDraftV1;
  readonly market: MarketV1;
  readonly epoch: EpochV1;
  readonly matcherKey: MatcherKeyV1;
  readonly traderTagHash: string;
  readonly clientRequestId: string;
  readonly nowMs: bigint;
  readonly lifetimeMs: bigint;
}): Promise<SealedOrderV1> {
  const quantityLots = BigInt(input.draft.quantityLots.trim());
  const limitPriceTicks = BigInt(input.draft.limitPriceTicks.trim());
  const minFillText = input.draft.minFillLots.trim();

  const nonce = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const blinding = generateCommitmentBlinding();
  const ownerSecret = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const ownerAuthorization = deriveOwnerAuthorizationV1(ownerSecret);
  let retainedOwnerSecret = false;
  const order: OrderIntentV1 = {
    version: 1,
    marketId: Uint8Array.from(await sha256(input.market.id)),
    epochSequence: BigInt(input.epoch.sequence),
    ownerPublicKey: ownerAuthorization,
    side: input.draft.side,
    orderType: "LIMIT",
    quantityLots,
    limitPriceTicks,
    minFillLots: minFillText === "" ? 0n : BigInt(minFillText),
    tif: input.draft.tif,
    allowPartial: input.draft.allowPartial,
    nonce,
    createdAtMs: input.nowMs,
    expiresAtMs: input.nowMs + input.lifetimeMs,
  };

  const commitmentBytes = commitOrderIntentV1(order, blinding);
  let commitment = "";
  for (const byte of commitmentBytes) commitment += byte.toString(16).padStart(2, "0");

  // The blinding travels inside the sealed plaintext so the matcher can check
  // the commitment against the order it decrypts. That is the V1 trust model
  // stated plainly: the matcher sees decrypted orders. The local copy is
  // zeroed below once the envelope exists.
  // Copied through this realm's constructor: a jsdom `TextEncoder` can return
  // a typed array from another realm, which fails `instanceof` checks in the
  // crypto package.
  const plaintext = Uint8Array.from(new TextEncoder().encode(JSON.stringify({
    version: 1,
    // The matcher must reconstruct the compiler-locked commitment before it
    // considers an opening. This public key stays inside the encrypted order
    // payload; the database and chain never receive it in plaintext.
    ownerPublicKey: commitmentBytesToHex(order.ownerPublicKey),
    side: order.side,
    orderType: order.orderType,
    quantityLots: order.quantityLots.toString(),
    limitPriceTicks: order.limitPriceTicks.toString(),
    minFillLots: order.minFillLots.toString(),
    tif: order.tif,
    allowPartial: order.allowPartial,
    blinding: Array.from(blinding),
    nonce: Array.from(order.nonce),
    createdAtMs: order.createdAtMs.toString(),
    expiresAtMs: order.expiresAtMs.toString(),
  })));

  try {
    const envelope = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: input.clientRequestId,
        marketId: input.market.id,
        epochId: input.epoch.id,
        commitment,
        traderTagHash: input.traderTagHash,
      },
      matcherKey: {
        version: 1,
        keyId: input.matcherKey.keyId,
        algorithm: input.matcherKey.algorithm as never,
        publicKey: input.matcherKey.publicKey,
        activeFromMs: BigInt(input.matcherKey.activeFromMs),
        expiresAtMs: BigInt(input.matcherKey.expiresAtMs),
      },
      plaintext,
      nowMs: input.nowMs,
    });
    await retainOwnerSecretV1(commitment, ownerSecret);
    retainedOwnerSecret = true;
    return { envelope: envelope as unknown as OrderEnvelopeWireV1, commitment };
  } finally {
    plaintext.fill(0);
    blinding.fill(0);
    ownerAuthorization.fill(0);
    if (!retainedOwnerSecret) ownerSecret.fill(0);
  }
}

function commitmentBytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}
