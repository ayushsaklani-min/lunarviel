import { sessionSigningMessageBytesV1 } from '@lunarveil/api-client';

const HEX_PATTERN = /^[0-9a-f]+$/u;

/**
 * The three ledger primitives this verifier needs, injected so the whole
 * decision is unit-testable and so the WASM module is loaded once at the
 * composition root rather than at import time here.
 */
export interface LedgerSignatureApiV1 {
  verifySignature(verifyingKey: string, data: Uint8Array, signature: string): boolean;
  addressFromKey(verifyingKey: string): string;
}

export interface WalletSignatureEvidenceV1 {
  readonly domain: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly walletIdentity: string;
  readonly signature: Uint8Array;
  /** Hex verifying key the wallet returned alongside the signature. */
  readonly verifyingKey?: string | undefined;
  /** The exact bytes the wallet reported signing, prefix included. */
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
 * Verifies a real Midnight wallet signature over a session challenge.
 *
 * ## Two independent checks, both required
 *
 * 1. **The signature is valid** over the exact bytes the wallet reports having
 *    signed, under the verifying key it supplied.
 * 2. **The verifying key owns the claimed identity.** `addressFromKey` derives
 *    the unshielded address from the verifying key, and it must equal the
 *    `walletIdentity` the challenge was issued for. Without this a caller
 *    could present any valid signature from any key and claim someone else's
 *    identity — check 1 alone proves possession of *a* key, not of *this*
 *    wallet.
 *
 * ## Why the signed bytes are transported rather than reconstructed
 *
 * The connector's `signData` JSDoc states the data to sign "will be prepended
 * with right prefix", and the installed `4.0.1` declarations do not say what
 * that prefix is. So this verifier does not reconstruct the signed bytes. It
 * verifies the signature over the bytes the wallet reports, and separately
 * requires the canonical session message to be a **suffix** of those bytes.
 * A wallet-chosen prefix is then harmless: the domain, challenge id, nonce and
 * identity are still bound, and the canonical message is domain-separated and
 * terminal, so no prefix can reinterpret it.
 *
 * **Not yet validated against a real wallet.** No Midnight browser wallet was
 * available in the session that wrote this, so the prefix behaviour above is
 * read from the declarations, not observed. The cryptography itself is real
 * and tested against genuine ledger keys and signatures.
 */
export class LedgerWalletSignatureVerifierV1 {
  constructor(
    private readonly ledger: LedgerSignatureApiV1,
    private readonly options: { readonly maxSignedDataBytes?: number } = {},
  ) {}

  async verify(input: WalletSignatureEvidenceV1): Promise<boolean> {
    const verifyingKey = typeof input.verifyingKey === 'string' ? input.verifyingKey.trim().toLowerCase() : undefined;
    if (verifyingKey === undefined || verifyingKey.length === 0 || verifyingKey.length > 512
      || verifyingKey.length % 2 !== 0 || !HEX_PATTERN.test(verifyingKey)) {
      return false;
    }
    if (!(input.signature instanceof Uint8Array) || input.signature.length === 0) return false;

    const expected = sessionSigningMessageBytesV1({
      domain: input.domain,
      challengeId: input.challengeId,
      nonce: input.nonce,
      walletIdentity: input.walletIdentity,
    });

    // Absent an explicit report, the wallet signed exactly the canonical
    // message: no prefix to account for.
    const signedData = input.signedData ?? expected;
    if (!(signedData instanceof Uint8Array) || signedData.length === 0) return false;
    const maxSignedDataBytes = this.options.maxSignedDataBytes ?? 4_096;
    if (signedData.length > maxSignedDataBytes) return false;
    if (!endsWith(signedData, expected)) return false;

    // The identity must belong to the key, not merely be asserted next to it.
    let derived: string;
    try {
      derived = this.ledger.addressFromKey(verifyingKey);
    } catch {
      return false;
    }
    if (typeof derived !== 'string' || derived.trim().toLowerCase() !== input.walletIdentity.trim().toLowerCase()) {
      return false;
    }

    try {
      return this.ledger.verifySignature(verifyingKey, signedData, toHex(input.signature)) === true;
    } catch {
      return false;
    }
  }
}
