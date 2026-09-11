import { createPrivateKey, createPublicKey, webcrypto } from 'node:crypto';

import type { MatcherEncryptionPublicKeyV1 } from '@lunarveil/crypto';

/**
 * PKCS#8 prefix for a raw X25519 private scalar. Fixed by RFC 8410: the
 * SEQUENCE, version, the `id-X25519` OID (1.3.101.110) and the OCTET STRING
 * headers, followed by the 32 key bytes.
 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SEED_PATTERN = /^(?:[0-9a-fA-F]{2}){32}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class SharedDevelopmentMatcherKeyError extends Error {
  constructor(readonly code:
    | 'PRODUCTION_REFUSED'
    | 'INVALID_SEED'
    | 'INVALID_KEY_ID'
    | 'INVALID_TIME_RANGE'
    | 'KEY_UNAVAILABLE'
    | 'UNKNOWN_MATCHER_KEY') {
    super(code);
    this.name = 'SharedDevelopmentMatcherKeyError';
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * A matcher encryption key every process derives identically from one seed.
 *
 * ## Why this exists
 *
 * The per-process development key store generates a fresh random key at
 * startup. That is fine while only the API server touches it, but the matcher
 * runs in a **separate process**: it would generate a different key and be
 * unable to decrypt a single order sealed to the API server's. Matching could
 * not run in any configuration — not merely in production. A shared key is
 * the minimum needed for the pipeline to work at all.
 *
 * ## What it is not
 *
 * It is not a key-management solution. The seed is operator-supplied plaintext
 * material, so anyone who can read the configuration can decrypt every order
 * in the system. That is acceptable only for local development, and the
 * constructor refuses to run outside a `development` environment. Production
 * needs the KMS-backed `MatcherPrivateKeyResolverV1` path, where the private
 * half never leaves the KMS boundary and only a `privateKeyRef` is stored.
 *
 * The derived private key is imported as non-extractable, and the seed is
 * zeroed once the key exists, so the material cannot be read back out of this
 * object even in development.
 */
export class SharedDevelopmentMatcherKeyStoreV1 {
  private constructor(
    private readonly publicMetadata: MatcherEncryptionPublicKeyV1,
    private readonly privateKey: CryptoKey,
    readonly privateKeyRef: string,
  ) {}

  static async create(input: {
    readonly environment: string;
    /** 32 bytes of hex. Shared by every process that must agree on the key. */
    readonly seedHex: string;
    readonly keyId: string;
    readonly activeFromMs: bigint;
    readonly expiresAtMs: bigint;
  }): Promise<SharedDevelopmentMatcherKeyStoreV1> {
    if (input.environment !== 'development') {
      throw new SharedDevelopmentMatcherKeyError('PRODUCTION_REFUSED');
    }
    if (typeof input.seedHex !== 'string' || !SEED_PATTERN.test(input.seedHex)) {
      throw new SharedDevelopmentMatcherKeyError('INVALID_SEED');
    }
    if (typeof input.keyId !== 'string' || !KEY_ID_PATTERN.test(input.keyId)) {
      throw new SharedDevelopmentMatcherKeyError('INVALID_KEY_ID');
    }
    if (typeof input.activeFromMs !== 'bigint' || typeof input.expiresAtMs !== 'bigint'
      || input.activeFromMs < 0n || input.expiresAtMs <= input.activeFromMs) {
      throw new SharedDevelopmentMatcherKeyError('INVALID_TIME_RANGE');
    }

    const seed = Buffer.from(input.seedHex, 'hex');
    const der = Buffer.concat([X25519_PKCS8_PREFIX, seed]);
    try {
      const nodePrivate = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      // SPKI for X25519 is a 12-byte header followed by the 32 raw bytes.
      const publicKeyBytes = new Uint8Array(
        createPublicKey(nodePrivate).export({ format: 'der', type: 'spki' }).subarray(12),
      );
      if (publicKeyBytes.length !== 32) throw new SharedDevelopmentMatcherKeyError('INVALID_SEED');

      const privateKey = await webcrypto.subtle.importKey(
        'pkcs8', der, 'X25519', false, ['deriveBits'],
      ) as CryptoKey;

      return new SharedDevelopmentMatcherKeyStoreV1(
        {
          version: 1,
          keyId: input.keyId,
          algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
          publicKey: base64Url(publicKeyBytes),
          activeFromMs: input.activeFromMs,
          expiresAtMs: input.expiresAtMs,
        },
        privateKey,
        `dev-shared:${input.keyId}`,
      );
    } finally {
      // The imported key is non-extractable; nothing else needs the seed.
      seed.fill(0);
      der.fill(0);
    }
  }

  /** Public metadata only. The private half never leaves this object. */
  activePublicKey(nowMs: bigint): MatcherEncryptionPublicKeyV1 {
    if (nowMs < this.publicMetadata.activeFromMs || nowMs >= this.publicMetadata.expiresAtMs) {
      throw new SharedDevelopmentMatcherKeyError('KEY_UNAVAILABLE');
    }
    return { ...this.publicMetadata };
  }

  async resolvePrivateKey(input: {
    readonly keyId: string;
    readonly privateKeyRef: string;
  }): Promise<CryptoKey> {
    if (input.keyId !== this.publicMetadata.keyId || input.privateKeyRef !== this.privateKeyRef) {
      throw new SharedDevelopmentMatcherKeyError('UNKNOWN_MATCHER_KEY');
    }
    return this.privateKey;
  }
}
