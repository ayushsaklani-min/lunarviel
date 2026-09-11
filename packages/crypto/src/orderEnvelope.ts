const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM' as const;
const ENVELOPE_AAD_DOMAIN = 'LUNARVEIL_ORDER_ENVELOPE_AAD_V1';
const HEX_32_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OrderEnvelopeAlgorithmV1 = typeof ENVELOPE_ALGORITHM;

export interface MatcherEncryptionPublicKeyV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly algorithm: OrderEnvelopeAlgorithmV1;
  readonly publicKey: string;
  readonly activeFromMs: bigint;
  readonly expiresAtMs: bigint;
}

export interface MatcherDecryptionKeyV1 extends MatcherEncryptionPublicKeyV1 {
  readonly privateKey: CryptoKey;
}

export interface OrderEnvelopeHeaderV1 {
  readonly version: 1;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly traderTagHash: string;
  readonly encryptionKeyId: string;
}

export interface OrderEnvelopeV1 extends OrderEnvelopeHeaderV1 {
  readonly algorithm: OrderEnvelopeAlgorithmV1;
  readonly ephemeralPublicKey: string;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface SealOrderEnvelopeOptions {
  readonly header: Omit<OrderEnvelopeHeaderV1, 'version' | 'encryptionKeyId'>;
  readonly matcherKey: MatcherEncryptionPublicKeyV1;
  readonly plaintext: Uint8Array;
  readonly nowMs: bigint;
}

export class OrderEnvelopeCryptoError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OrderEnvelopeCryptoError';
  }
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new OrderEnvelopeCryptoError('WEBCRYPTO_UNAVAILABLE');
  }
  return globalThis.crypto.subtle;
}

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new OrderEnvelopeCryptoError(`INVALID_${name}`);
}

function assertHex32(value: string, name: string): void {
  if (!HEX_32_PATTERN.test(value)) throw new OrderEnvelopeCryptoError(`INVALID_${name}`);
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new OrderEnvelopeCryptoError('INVALID_CLIENT_REQUEST_ID');
}

function assertTimeRange(activeFromMs: bigint, expiresAtMs: bigint): void {
  if (activeFromMs < 0n || expiresAtMs <= activeFromMs) {
    throw new OrderEnvelopeCryptoError('INVALID_KEY_LIFETIME');
  }
}

function assertMatcherKey(key: MatcherEncryptionPublicKeyV1): void {
  if (key.version !== ENVELOPE_VERSION || key.algorithm !== ENVELOPE_ALGORITHM) {
    throw new OrderEnvelopeCryptoError('UNSUPPORTED_ENVELOPE_KEY');
  }
  assertIdentifier(key.keyId, 'KEY_ID');
  assertTimeRange(key.activeFromMs, key.expiresAtMs);
  const bytes = base64UrlToBytes(key.publicKey, 'PUBLIC_KEY');
  try {
    if (bytes.length !== 32) throw new OrderEnvelopeCryptoError('INVALID_PUBLIC_KEY');
  } finally {
    bytes.fill(0);
  }
}

function assertHeader(header: OrderEnvelopeHeaderV1): void {
  if (header.version !== ENVELOPE_VERSION) throw new OrderEnvelopeCryptoError('UNSUPPORTED_ENVELOPE_VERSION');
  assertUuid(header.clientRequestId);
  assertIdentifier(header.marketId, 'MARKET_ID');
  assertIdentifier(header.epochId, 'EPOCH_ID');
  assertHex32(header.commitment, 'COMMITMENT');
  assertHex32(header.traderTagHash, 'TRADER_TAG_HASH');
  assertIdentifier(header.encryptionKeyId, 'KEY_ID');
}

function base64UrlToBytes(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new OrderEnvelopeCryptoError(`INVALID_${name}`);
  }
  const padded = `${value.replace(/-/gu, '+').replace(/_/gu, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  try {
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new OrderEnvelopeCryptoError(`INVALID_${name}`);
  }
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Web Crypto's DOM typings accept ArrayBuffer but reject a generic typed-array
 * buffer that could theoretically be SharedArrayBuffer. Copy at the boundary:
 * neither caller-owned nor sensitive working buffers are handed to Web Crypto.
 */
function asOwnedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function canonicalAad(header: OrderEnvelopeHeaderV1): Uint8Array {
  assertHeader(header);
  return new TextEncoder().encode([
    ENVELOPE_AAD_DOMAIN,
    String(header.version),
    header.clientRequestId,
    header.marketId,
    header.epochId,
    header.commitment,
    header.traderTagHash,
    header.encryptionKeyId,
  ].join('\u0000'));
}

/**
 * Deterministic public/ciphertext transport representation for server-side
 * idempotency fingerprints. It deliberately excludes any raw order plaintext.
 */
export function canonicalOrderEnvelopeTransportV1(envelope: OrderEnvelopeV1): string {
  validateOrderEnvelopeV1(envelope);
  return [
    'LUNARVEIL_ORDER_ENVELOPE_REQUEST_V1',
    String(envelope.version),
    envelope.clientRequestId,
    envelope.marketId,
    envelope.epochId,
    envelope.commitment,
    envelope.traderTagHash,
    envelope.encryptionKeyId,
    envelope.algorithm,
    envelope.ephemeralPublicKey,
    envelope.salt,
    envelope.nonce,
    envelope.ciphertext,
  ].join('\u0000');
}

async function importMatcherPublicKey(publicKey: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(publicKey, 'PUBLIC_KEY');
  try {
    if (bytes.length !== 32) throw new OrderEnvelopeCryptoError('INVALID_PUBLIC_KEY');
    return await subtle().importKey('raw', asOwnedBuffer(bytes), { name: 'X25519' }, false, []);
  } catch (error) {
    if (error instanceof OrderEnvelopeCryptoError) throw error;
    throw new OrderEnvelopeCryptoError('X25519_UNAVAILABLE');
  } finally {
    bytes.fill(0);
  }
}

async function deriveCipherKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
  aad: Uint8Array,
): Promise<CryptoKey> {
  let sharedSecret: Uint8Array | undefined;
  try {
    const sharedBits = await subtle().deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256);
    sharedSecret = new Uint8Array(sharedBits);
    const hkdfKey = await subtle().importKey('raw', asOwnedBuffer(sharedSecret), 'HKDF', false, ['deriveKey']);
    return await subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: asOwnedBuffer(salt), info: asOwnedBuffer(aad) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    if (error instanceof OrderEnvelopeCryptoError) throw error;
    throw new OrderEnvelopeCryptoError('KEY_AGREEMENT_FAILED');
  } finally {
    sharedSecret?.fill(0);
  }
}

async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  try {
    const pair = await subtle().generateKey({ name: 'X25519' }, false, ['deriveBits']);
    if (!('privateKey' in pair) || !('publicKey' in pair)) throw new OrderEnvelopeCryptoError('X25519_UNAVAILABLE');
    return pair;
  } catch (error) {
    if (error instanceof OrderEnvelopeCryptoError) throw error;
    throw new OrderEnvelopeCryptoError('X25519_UNAVAILABLE');
  }
}

function headerFromEnvelope(envelope: OrderEnvelopeV1): OrderEnvelopeHeaderV1 {
  return {
    version: envelope.version,
    clientRequestId: envelope.clientRequestId,
    marketId: envelope.marketId,
    epochId: envelope.epochId,
    commitment: envelope.commitment,
    traderTagHash: envelope.traderTagHash,
    encryptionKeyId: envelope.encryptionKeyId,
  };
}

export function validateOrderEnvelopeV1(envelope: OrderEnvelopeV1): void {
  assertHeader(headerFromEnvelope(envelope));
  if (envelope.algorithm !== ENVELOPE_ALGORITHM) throw new OrderEnvelopeCryptoError('UNSUPPORTED_ENVELOPE_ALGORITHM');
  for (const [name, value, length] of [
    ['EPHEMERAL_PUBLIC_KEY', envelope.ephemeralPublicKey, 32],
    ['SALT', envelope.salt, 16],
    ['NONCE', envelope.nonce, 12],
  ] as const) {
    const bytes = base64UrlToBytes(value, name);
    try {
      if (bytes.length !== length) throw new OrderEnvelopeCryptoError(`INVALID_${name}`);
    } finally {
      bytes.fill(0);
    }
  }
  const ciphertext = base64UrlToBytes(envelope.ciphertext, 'CIPHERTEXT');
  try {
    if (ciphertext.length < 16) throw new OrderEnvelopeCryptoError('INVALID_CIPHERTEXT');
  } finally {
    ciphertext.fill(0);
  }
}

export async function generateMatcherDecryptionKeyV1(input: {
  readonly keyId: string;
  readonly activeFromMs: bigint;
  readonly expiresAtMs: bigint;
}): Promise<MatcherDecryptionKeyV1> {
  assertIdentifier(input.keyId, 'KEY_ID');
  assertTimeRange(input.activeFromMs, input.expiresAtMs);
  const pair = await generateEphemeralKeyPair();
  let publicKeyBytes: Uint8Array | undefined;
  try {
    publicKeyBytes = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    if (publicKeyBytes.length !== 32) throw new OrderEnvelopeCryptoError('X25519_UNAVAILABLE');
    return {
      version: ENVELOPE_VERSION,
      keyId: input.keyId,
      algorithm: ENVELOPE_ALGORITHM,
      publicKey: bytesToBase64Url(publicKeyBytes),
      activeFromMs: input.activeFromMs,
      expiresAtMs: input.expiresAtMs,
      privateKey: pair.privateKey,
    };
  } finally {
    publicKeyBytes?.fill(0);
  }
}

/** Validates and copies only the public half of a matcher encryption key. */
export function matcherPublicKeyV1(key: MatcherEncryptionPublicKeyV1): MatcherEncryptionPublicKeyV1 {
  assertMatcherKey(key);
  return {
    version: key.version,
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKey: key.publicKey,
    activeFromMs: key.activeFromMs,
    expiresAtMs: key.expiresAtMs,
  };
}

export async function sealOrderEnvelopeV1(options: SealOrderEnvelopeOptions): Promise<OrderEnvelopeV1> {
  assertMatcherKey(options.matcherKey);
  if (options.nowMs < options.matcherKey.activeFromMs || options.nowMs >= options.matcherKey.expiresAtMs) {
    throw new OrderEnvelopeCryptoError('MATCHER_KEY_INACTIVE');
  }
  if (!(options.plaintext instanceof Uint8Array) || options.plaintext.length === 0) {
    throw new OrderEnvelopeCryptoError('INVALID_PLAINTEXT');
  }

  const header: OrderEnvelopeHeaderV1 = {
    version: ENVELOPE_VERSION,
    ...options.header,
    encryptionKeyId: options.matcherKey.keyId,
  };
  const aad = canonicalAad(header);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const matcherPublicKey = await importMatcherPublicKey(options.matcherKey.publicKey);
  const ephemeral = await generateEphemeralKeyPair();
  let ephemeralPublicKey: Uint8Array | undefined;
  try {
    ephemeralPublicKey = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
    const cipherKey = await deriveCipherKey(ephemeral.privateKey, matcherPublicKey, salt, aad);
    const ciphertext = new Uint8Array(await subtle().encrypt(
      {
        name: 'AES-GCM',
        iv: asOwnedBuffer(nonce),
        additionalData: asOwnedBuffer(aad),
        tagLength: 128,
      },
      cipherKey,
      asOwnedBuffer(options.plaintext),
    ));
    try {
      return {
        ...header,
        algorithm: ENVELOPE_ALGORITHM,
        ephemeralPublicKey: bytesToBase64Url(ephemeralPublicKey),
        salt: bytesToBase64Url(salt),
        nonce: bytesToBase64Url(nonce),
        ciphertext: bytesToBase64Url(ciphertext),
      };
    } finally {
      ciphertext.fill(0);
    }
  } catch (error) {
    if (error instanceof OrderEnvelopeCryptoError) throw error;
    throw new OrderEnvelopeCryptoError('ENVELOPE_SEAL_FAILED');
  } finally {
    aad.fill(0);
    salt.fill(0);
    nonce.fill(0);
    ephemeralPublicKey?.fill(0);
  }
}

export async function withOpenedOrderEnvelopeV1<T>(
  envelope: OrderEnvelopeV1,
  matcherKey: MatcherDecryptionKeyV1,
  consume: (plaintext: Uint8Array) => Promise<T> | T,
): Promise<T> {
  validateOrderEnvelopeV1(envelope);
  assertMatcherKey(matcherKey);
  if (envelope.encryptionKeyId !== matcherKey.keyId) throw new OrderEnvelopeCryptoError('UNKNOWN_MATCHER_KEY');

  const aad = canonicalAad(headerFromEnvelope(envelope));
  const salt = base64UrlToBytes(envelope.salt, 'SALT');
  const nonce = base64UrlToBytes(envelope.nonce, 'NONCE');
  const ephemeralBytes = base64UrlToBytes(envelope.ephemeralPublicKey, 'EPHEMERAL_PUBLIC_KEY');
  const ciphertext = base64UrlToBytes(envelope.ciphertext, 'CIPHERTEXT');
  let plaintext: Uint8Array | undefined;
  try {
    const ephemeralPublicKey = await subtle().importKey(
      'raw',
      asOwnedBuffer(ephemeralBytes),
      { name: 'X25519' },
      false,
      [],
    );
    const cipherKey = await deriveCipherKey(matcherKey.privateKey, ephemeralPublicKey, salt, aad);
    try {
      plaintext = new Uint8Array(await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: asOwnedBuffer(nonce),
          additionalData: asOwnedBuffer(aad),
          tagLength: 128,
        },
        cipherKey,
        asOwnedBuffer(ciphertext),
      ));
    } catch {
      throw new OrderEnvelopeCryptoError('ENVELOPE_AUTH_FAILED');
    }
    return await consume(plaintext);
  } finally {
    aad.fill(0);
    salt.fill(0);
    nonce.fill(0);
    ephemeralBytes.fill(0);
    ciphertext.fill(0);
    plaintext?.fill(0);
  }
}
