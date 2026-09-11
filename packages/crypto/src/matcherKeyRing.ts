import {
  type MatcherDecryptionKeyV1,
  type MatcherEncryptionPublicKeyV1,
  matcherPublicKeyV1,
  OrderEnvelopeCryptoError,
} from './orderEnvelope.js';

export class MatcherKeyRingError extends Error {
  constructor(readonly code: 'DUPLICATE_KEY_ID' | 'KEY_SCHEDULE_OVERLAP' | 'NO_ACTIVE_MATCHER_KEY' | 'UNKNOWN_MATCHER_KEY' | 'KEY_NOT_EXPIRED' | 'OUTSTANDING_ENVELOPES') {
    super(code);
    this.name = 'MatcherKeyRingError';
  }
}

function intervalsOverlap(
  left: Pick<MatcherEncryptionPublicKeyV1, 'activeFromMs' | 'expiresAtMs'>,
  right: Pick<MatcherEncryptionPublicKeyV1, 'activeFromMs' | 'expiresAtMs'>,
): boolean {
  return left.activeFromMs < right.expiresAtMs && right.activeFromMs < left.expiresAtMs;
}

/**
 * In-memory matcher key schedule. Private CryptoKeys are intentionally never
 * serialized; a production adapter must resolve them from a KMS/HSM reference.
 */
export class MatcherKeyRingV1 {
  private readonly keys = new Map<string, MatcherDecryptionKeyV1>();

  register(key: MatcherDecryptionKeyV1): void {
    try {
      matcherPublicKeyV1(key);
    } catch (error) {
      if (error instanceof OrderEnvelopeCryptoError) throw error;
      throw new MatcherKeyRingError('UNKNOWN_MATCHER_KEY');
    }
    if (this.keys.has(key.keyId)) throw new MatcherKeyRingError('DUPLICATE_KEY_ID');
    for (const existing of this.keys.values()) {
      if (intervalsOverlap(existing, key)) throw new MatcherKeyRingError('KEY_SCHEDULE_OVERLAP');
    }
    this.keys.set(key.keyId, key);
  }

  activePublicKey(nowMs: bigint): MatcherEncryptionPublicKeyV1 {
    const candidates = [...this.keys.values()].filter((key) => (
      key.activeFromMs <= nowMs && nowMs < key.expiresAtMs
    ));
    if (candidates.length !== 1) throw new MatcherKeyRingError('NO_ACTIVE_MATCHER_KEY');
    return matcherPublicKeyV1(candidates[0]!);
  }

  /**
   * Existing envelopes may need an expired key during their documented
   * retention window. The caller must have already selected a stored envelope
   * by its exact key ID; this method is not an encryption-key selector.
   */
  decryptionKeyForExistingEnvelope(keyId: string): MatcherDecryptionKeyV1 {
    const key = this.keys.get(keyId);
    if (!key) throw new MatcherKeyRingError('UNKNOWN_MATCHER_KEY');
    return key;
  }

  retireExpired(keyId: string, nowMs: bigint, hasOutstandingEnvelope: (keyId: string) => boolean): void {
    const key = this.keys.get(keyId);
    if (!key) throw new MatcherKeyRingError('UNKNOWN_MATCHER_KEY');
    if (nowMs < key.expiresAtMs) throw new MatcherKeyRingError('KEY_NOT_EXPIRED');
    if (hasOutstandingEnvelope(keyId)) throw new MatcherKeyRingError('OUTSTANDING_ENVELOPES');
    this.keys.delete(keyId);
  }

  size(): number {
    return this.keys.size;
  }
}
