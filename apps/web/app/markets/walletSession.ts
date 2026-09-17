import {
  buildSessionSigningMessageV1,
  type LunarveilApiClientV1,
  type SessionV1,
} from "@lunarveil/api-client";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";

import {
  connectSelectedWallet,
  discoverCompatibleWallets,
  signSessionMessageV1,
  walletIdentityFromAddressV1,
  type WalletDescriptor,
  type WalletRegistry,
} from "@lunarveil/midnight";

/** Base64url without padding, which is what the API's schema accepts. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function discoverWalletsV1(registry: WalletRegistry | undefined): readonly WalletDescriptor[] {
  return registry === undefined ? [] : discoverCompatibleWallets(registry);
}

export interface WalletSessionResultV1 {
  readonly walletIdentity: string;
  readonly session: SessionV1;
  /** Kept so later slices can ask the same wallet to sign again. */
  readonly connected: ConnectedAPI;
  readonly verifyingKey: string;
}

/**
 * The full wallet authentication round trip.
 *
 * 1. Connect to the chosen wallet on the expected network.
 * 2. Read its unshielded address — the identity the session will be bound to.
 * 3. Ask the API for a challenge.
 * 4. Have the wallet sign the canonical message built by
 *    `buildSessionSigningMessageV1`, the one definition both sides use.
 * 5. Exchange the signature for a session token.
 *
 * The token is returned to the caller and never written anywhere by this
 * function: no `localStorage`, no cookie, no log. Nothing here handles a seed,
 * a private key or a balance.
 */
export async function openWalletSessionV1(input: {
  readonly registry: WalletRegistry;
  readonly walletId: string;
  readonly networkId: string;
  readonly domain: string;
  readonly api: LunarveilApiClientV1;
  readonly signal?: AbortSignal;
}): Promise<WalletSessionResultV1> {
  const wallet = await connectSelectedWallet(input.registry, input.walletId, input.networkId);
  // Connector 4.0.1 lets the wallet ask for these permissions once, up front,
  // instead of interrupting each later call. Optional for older wallets.
  if (typeof wallet.hintUsage === "function") {
    await wallet.hintUsage(["getUnshieldedAddress", "signData"]);
  }
  const { unshieldedAddress } = await wallet.getUnshieldedAddress();
  if (typeof unshieldedAddress !== "string" || unshieldedAddress.length === 0) {
    throw new Error("WALLET_ADDRESS_UNAVAILABLE");
  }

  const init = input.signal === undefined ? {} : { signal: input.signal };
  const challenge = await input.api.createSessionChallenge(
    { domain: input.domain, walletIdentity: walletIdentityFromAddressV1(unshieldedAddress, input.networkId) },
    init,
  );

  const message = buildSessionSigningMessageV1({
    domain: challenge.domain,
    challengeId: challenge.id,
    nonce: challenge.nonce,
    walletIdentity: challenge.walletIdentity,
  });
  const signed = await signSessionMessageV1(wallet, message);

  const session = await input.api.verifySessionChallenge({
    challengeId: challenge.id,
    signature: base64Url(hexToBytes(signed.signature)),
    verifyingKey: signed.verifyingKey,
    signedData: base64Url(new TextEncoder().encode(signed.signedData)),
  }, init);

  return {
    walletIdentity: challenge.walletIdentity,
    session,
    connected: wallet,
    verifyingKey: signed.verifyingKey,
  };
}

/** Shows enough of an address to recognize it, never the whole thing. */
export function shortenIdentityV1(identity: string): string {
  if (identity.length <= 16) return identity;
  return `${identity.slice(0, 8)}…${identity.slice(-6)}`;
}
