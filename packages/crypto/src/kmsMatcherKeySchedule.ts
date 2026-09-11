import {
  type MatcherDecryptionKeyV1,
  type MatcherEncryptionPublicKeyV1,
  matcherPublicKeyV1,
} from './orderEnvelope.js';

const PRIVATE_KEY_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export interface MatcherKeyRecordV1 extends MatcherEncryptionPublicKeyV1 {
  /** Opaque KMS/HSM locator, never private key material. */
  readonly privateKeyRef: string;
}

export interface MatcherPrivateKeyResolverV1 {
  /**
   * Resolves a non-extractable private CryptoKey inside the matcher process.
   * Implementations must not log, serialize, or cache key material durably.
   */
  resolvePrivateKey(input: {
    readonly keyId: string;
    readonly privateKeyRef: string;
  }): Promise<CryptoKey>;
}

export class KmsMatcherKeyScheduleError extends Error {
  constructor(readonly code:
    | 'DUPLICATE_KEY_ID'
    | 'KEY_SCHEDULE_OVERLAP'
    | 'NO_ACTIVE_MATCHER_KEY'
    | 'UNKNOWN_MATCHER_KEY'
    | 'INVALID_PRIVATE_KEY_REF'
    | 'KEY_RESOLUTION_FAILED'
    | 'KEY_NOT_EXPIRED'
    | 'OUTSTANDING_ENVELOPES') {
    super(code);
    this.name = 'KmsMatcherKeyScheduleError';
  }
}

function intervalsOverlap(
  left: Pick<MatcherEncryptionPublicKeyV1, 'activeFromMs' | 'expiresAtMs'>,
  right: Pick<MatcherEncryptionPublicKeyV1, 'activeFromMs' | 'expiresAtMs'>,
): boolean {
  return left.activeFromMs < right.expiresAtMs && right.activeFromMs < left.expiresAtMs;
}

function isUsableX25519PrivateKey(value: unknown): value is CryptoKey {
  if (typeof value !== 'object' || value === null) return false;
  const key = value as Partial<CryptoKey>;
  return key.type === 'private'
    && key.algorithm?.name === 'X25519'
    && key.usages?.includes('deriveBits') === true;
}

/**
 * Metadata-only matcher key schedule. It persists safe public metadata and an
 * opaque private-key reference; private material is resolved only for an
 * existing envelope and is never held by this schedule.
 */
export class KmsMatcherKeyScheduleV1 {
  private readonly keys = new Map<string, MatcherKeyRecordV1>();

  constructor(private readonly resolver: MatcherPrivateKeyResolverV1) {}

  register(record: MatcherKeyRecordV1): void {
    // This verifies version, algorithm, public-key encoding and lifetime.
    matcherPublicKeyV1(record);
    if (!PRIVATE_KEY_REFERENCE_PATTERN.test(record.privateKeyRef)) {
      throw new KmsMatcherKeyScheduleError('INVALID_PRIVATE_KEY_REF');
    }
    if (this.keys.has(record.keyId)) throw new KmsMatcherKeyScheduleError('DUPLICATE_KEY_ID');
    for (const existing of this.keys.values()) {
      if (intervalsOverlap(existing, record)) throw new KmsMatcherKeyScheduleError('KEY_SCHEDULE_OVERLAP');
    }
    this.keys.set(record.keyId, Object.freeze({ ...record }));
  }

  activePublicKey(nowMs: bigint): MatcherEncryptionPublicKeyV1 {
    const candidates = [...this.keys.values()].filter((key) => (
      key.activeFromMs <= nowMs && nowMs < key.expiresAtMs
    ));
    if (candidates.length !== 1) throw new KmsMatcherKeyScheduleError('NO_ACTIVE_MATCHER_KEY');
    return matcherPublicKeyV1(candidates[0]!);
  }

  /**
   * Intended for a previously selected envelope only. The resolved CryptoKey
   * exists solely in the returned value; callers must pass it directly to the
   * decryption boundary and discard it afterwards.
   */
  async decryptionKeyForExistingEnvelope(keyId: string): Promise<MatcherDecryptionKeyV1> {
    const record = this.keys.get(keyId);
    if (!record) throw new KmsMatcherKeyScheduleError('UNKNOWN_MATCHER_KEY');
    let privateKey: CryptoKey;
    try {
      privateKey = await this.resolver.resolvePrivateKey({
        keyId: record.keyId,
        privateKeyRef: record.privateKeyRef,
      });
    } catch {
      throw new KmsMatcherKeyScheduleError('KEY_RESOLUTION_FAILED');
    }
    if (!isUsableX25519PrivateKey(privateKey)) {
      throw new KmsMatcherKeyScheduleError('KEY_RESOLUTION_FAILED');
    }
    return {
      ...matcherPublicKeyV1(record),
      privateKey,
    };
  }

  retireExpired(keyId: string, nowMs: bigint, hasOutstandingEnvelope: (keyId: string) => boolean): void {
    const record = this.keys.get(keyId);
    if (!record) throw new KmsMatcherKeyScheduleError('UNKNOWN_MATCHER_KEY');
    if (nowMs < record.expiresAtMs) throw new KmsMatcherKeyScheduleError('KEY_NOT_EXPIRED');
    if (hasOutstandingEnvelope(keyId)) throw new KmsMatcherKeyScheduleError('OUTSTANDING_ENVELOPES');
    this.keys.delete(keyId);
  }

  size(): number {
    return this.keys.size;
  }
}
