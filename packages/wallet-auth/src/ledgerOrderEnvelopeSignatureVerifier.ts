import { orderSigningMessageBytesV1 } from '@lunarveil/api-client';
import { walletIdentityHashV1 } from '@lunarveil/matcher';

import type { LedgerSignatureApiV1 } from './ledgerWalletSignatureVerifier.js';

const HEX_PATTERN = /^[0-9a-f]+$/u;

export interface OrderEnvelopeSignatureEvidenceV1 {
  readonly walletIdentityHash: string;
  readonly envelope: {
    readonly version: number;
    readonly clientRequestId: string;
    readonly marketId: string;
    readonly epochId: string;
    readonly commitment: string;
    readonly traderTagHash: string;
    readonly encryptionKeyId: string;
    readonly algorithm: string;
    readonly ephemeralPublicKey: string;
    readonly salt: string;
    readonly nonce: string;
    readonly ciphertext: string;
  };
  readonly signature: Uint8Array;
  readonly verifyingKey?: string | undefined;
  readonly signedData?: Uint8Array | undefined;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function endsWith(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length > haystack.length) return false;
  const offset = haystack.length - needle.length;
  let mismatch = 0;
  for (let index = 0; index < needle.length; index += 1) {
    mismatch |= (haystack[offset + index] ?? 0) ^ (needle[index] ?? 0);
  }
  return mismatch === 0;
}

/**
 * Verifies a real wallet signature over an encrypted order envelope.
 *
 * Same two-part rule as the session verifier, for the same reason: a valid
 * signature proves possession of *a* key, so the key must also be shown to own
 * the authenticated session's identity. Here the session holds only
 * `walletIdentityHash`, so the derived address is hashed and compared to it.
 *
 * The signed bytes are transported rather than reconstructed, because
 * `signData` prepends an unspecified prefix, and the canonical order message
 * must be a **suffix** of them.
 *
 * The signature covers the ciphertext, not just the header: signing the header
 * alone would let an interceptor swap the ciphertext and still present a valid
 * signature, so the order admitted would not be the order approved.
 */
export class LedgerOrderEnvelopeSignatureVerifierV1 {
  constructor(
    private readonly ledger: LedgerSignatureApiV1,
    private readonly options: { readonly maxSignedDataBytes?: number } = {},
  ) {}

  async verify(input: OrderEnvelopeSignatureEvidenceV1): Promise<boolean> {
    const verifyingKey = typeof input.verifyingKey === 'string' ? input.verifyingKey.trim().toLowerCase() : undefined;
    if (verifyingKey === undefined || verifyingKey.length === 0 || verifyingKey.length > 512
      || verifyingKey.length % 2 !== 0 || !HEX_PATTERN.test(verifyingKey)) {
      return false;
    }
    if (!(input.signature instanceof Uint8Array) || input.signature.length === 0) return false;

    let expected: Uint8Array;
    try {
      expected = orderSigningMessageBytesV1(input.envelope);
    } catch {
      return false;
    }

    const signedData = input.signedData ?? expected;
    if (!(signedData instanceof Uint8Array) || signedData.length === 0) return false;
    if (signedData.length > (this.options.maxSignedDataBytes ?? 16_384)) return false;
    if (!endsWith(signedData, expected)) return false;

    let derivedIdentity: string;
    try {
      derivedIdentity = this.ledger.addressFromKey(verifyingKey);
    } catch {
      return false;
    }
    if (typeof derivedIdentity !== 'string' || derivedIdentity.length === 0) return false;
    // The session stores only a hash of the wallet identity, never the
    // address, so the derived address is hashed with the session service's own
    // function rather than a second copy of that derivation here.
    if (walletIdentityHashV1(derivedIdentity) !== input.walletIdentityHash) return false;

    try {
      return this.ledger.verifySignature(verifyingKey, signedData, toHex(input.signature)) === true;
    } catch {
      return false;
    }
  }
}
