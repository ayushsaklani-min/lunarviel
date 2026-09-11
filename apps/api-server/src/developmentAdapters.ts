import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  type MatcherEncryptionPublicKeyV1,
  type MatcherPrivateKeyResolverV1,
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
} from '@lunarveil/crypto';
import type {
  OrderEnvelopeSignatureVerifier,
  TraderSessionBindingVerifier,
  WalletSignatureVerifier,
} from '@lunarveil/matcher';
import type { LunarveilRuntimeEnvironmentV1 } from '@lunarveil/api';

/**
 * Development-grade stand-ins for capabilities that do not exist yet.
 *
 * Two production dependencies are genuinely unavailable, not merely unwritten:
 * a KMS/HSM has not been provisioned, and DApp Connector 4.0.1 exposes no
 * message-signing method, so a real wallet signature cannot be verified.
 * These adapters make a local end-to-end path runnable without pretending
 * either capability exists. Every one of them refuses to construct outside a
 * development environment, so no deployment can silently inherit them.
 */
export class DevelopmentAdapterError extends Error {
  constructor(readonly code: 'PRODUCTION_REFUSED' | 'KEY_UNAVAILABLE') {
    super(code);
    this.name = 'DevelopmentAdapterError';
  }
}

function assertDevelopmentOnly(environment: LunarveilRuntimeEnvironmentV1): void {
  // Staging is refused too: a shared environment must not accept a stub verifier.
  if (environment !== 'development') throw new DevelopmentAdapterError('PRODUCTION_REFUSED');
}

/**
 * Holds one non-extractable X25519 matcher key for the life of the process.
 * A real KMS/HSM keeps the private half outside the process; this does not, so
 * it is a local development convenience and never a production key store.
 */
export class DevelopmentMatcherKeyStoreV1 implements MatcherPrivateKeyResolverV1 {
  private constructor(
    private readonly publicMetadata: MatcherEncryptionPublicKeyV1,
    private readonly privateKey: CryptoKey,
    readonly privateKeyRef: string,
  ) {}

  static async create(input: {
    readonly environment: LunarveilRuntimeEnvironmentV1;
    readonly nowMs: bigint;
    readonly lifetimeMs?: bigint;
  }): Promise<DevelopmentMatcherKeyStoreV1> {
    assertDevelopmentOnly(input.environment);
    const keyId = `dev-matcher-${randomUUID()}`;
    const key = await generateMatcherDecryptionKeyV1({
      keyId,
      activeFromMs: input.nowMs,
      expiresAtMs: input.nowMs + (input.lifetimeMs ?? 86_400_000n),
    });
    return new DevelopmentMatcherKeyStoreV1(matcherPublicKeyV1(key), key.privateKey, `dev-local:${keyId}`);
  }

  /** Public metadata only. The private half never leaves this object. */
  activePublicKey(nowMs: bigint): MatcherEncryptionPublicKeyV1 {
    if (nowMs < this.publicMetadata.activeFromMs || nowMs >= this.publicMetadata.expiresAtMs) {
      throw new DevelopmentAdapterError('KEY_UNAVAILABLE');
    }
    return matcherPublicKeyV1(this.publicMetadata);
  }

  async resolvePrivateKey(input: { readonly keyId: string; readonly privateKeyRef: string }): Promise<CryptoKey> {
    if (input.keyId !== this.publicMetadata.keyId || input.privateKeyRef !== this.privateKeyRef) {
      throw new DevelopmentAdapterError('KEY_UNAVAILABLE');
    }
    return this.privateKey;
  }
}

function sameHash(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Derives the trader tag a wallet identity is allowed to claim. Production must
 * replace this with the Connector-bound derivation the circuits agree on.
 */
export function developmentTraderTagHashV1(walletIdentityHash: string, secret: Uint8Array): string {
  return createHmac('sha256', Buffer.from(secret)).update(walletIdentityHash).digest('hex');
}

/** Accepts only the one trader tag derivable from the authenticated wallet. */
export class DevelopmentTraderBindingVerifierV1 implements TraderSessionBindingVerifier {
  constructor(
    private readonly secret: Uint8Array,
    environment: LunarveilRuntimeEnvironmentV1,
  ) {
    assertDevelopmentOnly(environment);
  }

  async verify(input: { readonly walletIdentityHash: string; readonly traderTagHash: string }): Promise<boolean> {
    return sameHash(developmentTraderTagHashV1(input.walletIdentityHash, this.secret), input.traderTagHash);
  }
}

/**
 * Stands in for the missing Connector signing capability. It proves the caller
 * holds the session-bound development secret; it proves nothing about a wallet.
 * It must never be mistaken for wallet authentication.
 */
export class DevelopmentWalletSignatureVerifierV1 implements WalletSignatureVerifier {
  constructor(
    private readonly secret: Uint8Array,
    environment: LunarveilRuntimeEnvironmentV1,
  ) {
    assertDevelopmentOnly(environment);
  }

  async verify(input: {
    readonly domain: string;
    readonly challengeId: string;
    readonly nonce: string;
    readonly walletIdentity: string;
    readonly signature: Uint8Array;
  }): Promise<boolean> {
    if (!(input.signature instanceof Uint8Array) || input.signature.length !== 32) return false;
    const expected = createHmac('sha256', Buffer.from(this.secret))
      .update(`${input.domain}\n${input.challengeId}\n${input.nonce}\n${input.walletIdentity}`)
      .digest();
    return expected.length === input.signature.length && timingSafeEqual(expected, Buffer.from(input.signature));
  }
}

/** Produces the signature the development verifier above accepts. */
export function developmentWalletSignatureV1(input: {
  readonly domain: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly walletIdentity: string;
  readonly secret: Uint8Array;
}): Uint8Array {
  return new Uint8Array(createHmac('sha256', Buffer.from(input.secret))
    .update(`${input.domain}\n${input.challengeId}\n${input.nonce}\n${input.walletIdentity}`)
    .digest());
}

/** Stands in for the missing canonical envelope-signature capability. */
export class DevelopmentEnvelopeSignatureVerifierV1 implements OrderEnvelopeSignatureVerifier {
  constructor(
    private readonly secret: Uint8Array,
    environment: LunarveilRuntimeEnvironmentV1,
  ) {
    assertDevelopmentOnly(environment);
  }

  async verify(input: {
    readonly walletIdentityHash: string;
    readonly envelope: { readonly commitment: string; readonly clientRequestId: string };
    readonly signature: Uint8Array;
  }): Promise<boolean> {
    if (!(input.signature instanceof Uint8Array) || input.signature.length !== 32) return false;
    const expected = developmentEnvelopeSignatureV1({
      walletIdentityHash: input.walletIdentityHash,
      commitment: input.envelope.commitment,
      clientRequestId: input.envelope.clientRequestId,
      secret: this.secret,
    });
    return timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
  }
}

/** Produces the signature the development envelope verifier above accepts. */
export function developmentEnvelopeSignatureV1(input: {
  readonly walletIdentityHash: string;
  readonly commitment: string;
  readonly clientRequestId: string;
  readonly secret: Uint8Array;
}): Uint8Array {
  return new Uint8Array(createHmac('sha256', Buffer.from(input.secret))
    .update(`${input.walletIdentityHash}\n${input.commitment}\n${input.clientRequestId}`)
    .digest());
}
