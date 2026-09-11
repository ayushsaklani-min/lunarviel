const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM' as const;
const ENVELOPE_AAD_DOMAIN = 'LUNARVEIL_ALLOCATION_ENVELOPE_AAD_V1';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_32_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;

export type AllocationEnvelopeAlgorithmV1 = typeof ENVELOPE_ALGORITHM;

export interface AllocationRecipientEncryptionPublicKeyV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly algorithm: AllocationEnvelopeAlgorithmV1;
  readonly publicKey: string;
}

export interface AllocationRecipientDecryptionKeyV1 extends AllocationRecipientEncryptionPublicKeyV1 {
  readonly privateKey: CryptoKey;
}

export interface AllocationEnvelopeHeaderV1 {
  readonly version: 1;
  readonly allocationId: string;
  readonly batchId: string;
  readonly traderTagHash: string;
  readonly encryptionKeyId: string;
}

export interface AllocationEnvelopeV1 extends AllocationEnvelopeHeaderV1 {
  readonly algorithm: AllocationEnvelopeAlgorithmV1;
  readonly ephemeralPublicKey: string;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface SealAllocationEnvelopeOptionsV1 {
  readonly header: Omit<AllocationEnvelopeHeaderV1, 'version' | 'encryptionKeyId'>;
  readonly recipientKey: AllocationRecipientEncryptionPublicKeyV1;
  readonly plaintext: Uint8Array;
}

export class AllocationEnvelopeCryptoError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AllocationEnvelopeCryptoError';
  }
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new AllocationEnvelopeCryptoError('WEBCRYPTO_UNAVAILABLE');
  }
  return globalThis.crypto.subtle;
}

function asOwnedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function bytesToBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new AllocationEnvelopeCryptoError(`INVALID_${name}`);
  }
  const padded = `${value.replace(/-/gu, '+').replace(/_/gu, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  try {
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new AllocationEnvelopeCryptoError(`INVALID_${name}`);
  }
}

function assertIdentifier(value: string, name: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new AllocationEnvelopeCryptoError(`INVALID_${name}`);
}

function assertHeader(header: AllocationEnvelopeHeaderV1): void {
  if (header.version !== ENVELOPE_VERSION) throw new AllocationEnvelopeCryptoError('UNSUPPORTED_ENVELOPE_VERSION');
  if (!UUID_PATTERN.test(header.allocationId)) throw new AllocationEnvelopeCryptoError('INVALID_ALLOCATION_ID');
  assertIdentifier(header.batchId, 'BATCH_ID');
  if (!HEX_32_PATTERN.test(header.traderTagHash)) throw new AllocationEnvelopeCryptoError('INVALID_TRADER_TAG_HASH');
  assertIdentifier(header.encryptionKeyId, 'KEY_ID');
}

function assertRecipientKey(key: AllocationRecipientEncryptionPublicKeyV1): void {
  if (key.version !== ENVELOPE_VERSION || key.algorithm !== ENVELOPE_ALGORITHM) {
    throw new AllocationEnvelopeCryptoError('UNSUPPORTED_RECIPIENT_KEY');
  }
  assertIdentifier(key.keyId, 'KEY_ID');
  const bytes = base64UrlToBytes(key.publicKey, 'PUBLIC_KEY');
  try {
    if (bytes.length !== 32) throw new AllocationEnvelopeCryptoError('INVALID_PUBLIC_KEY');
  } finally {
    bytes.fill(0);
  }
}

function canonicalAad(header: AllocationEnvelopeHeaderV1): Uint8Array {
  assertHeader(header);
  return new TextEncoder().encode([
    ENVELOPE_AAD_DOMAIN,
    String(header.version),
    header.allocationId,
    header.batchId,
    header.traderTagHash,
    header.encryptionKeyId,
  ].join('\u0000'));
}

function headerFromEnvelope(envelope: AllocationEnvelopeV1): AllocationEnvelopeHeaderV1 {
  return {
    version: envelope.version,
    allocationId: envelope.allocationId,
    batchId: envelope.batchId,
    traderTagHash: envelope.traderTagHash,
    encryptionKeyId: envelope.encryptionKeyId,
  };
}

async function generateEphemeralKeyPair(): Promise<CryptoKeyPair> {
  try {
    const pair = await subtle().generateKey({ name: 'X25519' }, false, ['deriveBits']);
    if (!('privateKey' in pair) || !('publicKey' in pair)) throw new AllocationEnvelopeCryptoError('X25519_UNAVAILABLE');
    return pair;
  } catch (error) {
    if (error instanceof AllocationEnvelopeCryptoError) throw error;
    throw new AllocationEnvelopeCryptoError('X25519_UNAVAILABLE');
  }
}

async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(publicKey, 'PUBLIC_KEY');
  try {
    if (bytes.length !== 32) throw new AllocationEnvelopeCryptoError('INVALID_PUBLIC_KEY');
    return await subtle().importKey('raw', asOwnedBuffer(bytes), { name: 'X25519' }, false, []);
  } catch (error) {
    if (error instanceof AllocationEnvelopeCryptoError) throw error;
    throw new AllocationEnvelopeCryptoError('X25519_UNAVAILABLE');
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
    sharedSecret = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256));
    const hkdfKey = await subtle().importKey('raw', asOwnedBuffer(sharedSecret), 'HKDF', false, ['deriveKey']);
    return await subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: asOwnedBuffer(salt), info: asOwnedBuffer(aad) },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    if (error instanceof AllocationEnvelopeCryptoError) throw error;
    throw new AllocationEnvelopeCryptoError('KEY_AGREEMENT_FAILED');
  } finally {
    sharedSecret?.fill(0);
  }
}

/** Generate an in-memory recipient key. Persist private keys only through an approved wallet/KMS boundary. */
export async function generateAllocationRecipientDecryptionKeyV1(keyId: string): Promise<AllocationRecipientDecryptionKeyV1> {
  assertIdentifier(keyId, 'KEY_ID');
  const pair = await generateEphemeralKeyPair();
  let publicKey: Uint8Array | undefined;
  try {
    publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    if (publicKey.length !== 32) throw new AllocationEnvelopeCryptoError('X25519_UNAVAILABLE');
    return { version: ENVELOPE_VERSION, keyId, algorithm: ENVELOPE_ALGORITHM, publicKey: bytesToBase64Url(publicKey), privateKey: pair.privateKey };
  } finally {
    publicKey?.fill(0);
  }
}

/** Validates and copies only the shareable public half of a recipient key. */
export function allocationRecipientPublicKeyV1(
  key: AllocationRecipientEncryptionPublicKeyV1,
): AllocationRecipientEncryptionPublicKeyV1 {
  assertRecipientKey(key);
  return { version: key.version, keyId: key.keyId, algorithm: key.algorithm, publicKey: key.publicKey };
}

export function validateAllocationEnvelopeV1(envelope: AllocationEnvelopeV1): void {
  assertHeader(headerFromEnvelope(envelope));
  if (envelope.algorithm !== ENVELOPE_ALGORITHM) throw new AllocationEnvelopeCryptoError('UNSUPPORTED_ENVELOPE_ALGORITHM');
  for (const [name, value, length] of [
    ['EPHEMERAL_PUBLIC_KEY', envelope.ephemeralPublicKey, 32],
    ['SALT', envelope.salt, 16],
    ['NONCE', envelope.nonce, 12],
  ] as const) {
    const bytes = base64UrlToBytes(value, name);
    try {
      if (bytes.length !== length) throw new AllocationEnvelopeCryptoError(`INVALID_${name}`);
    } finally {
      bytes.fill(0);
    }
  }
  const ciphertext = base64UrlToBytes(envelope.ciphertext, 'CIPHERTEXT');
  try {
    if (ciphertext.length < 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 16) {
      throw new AllocationEnvelopeCryptoError('INVALID_CIPHERTEXT');
    }
  } finally {
    ciphertext.fill(0);
  }
}

export async function sealAllocationEnvelopeV1(options: SealAllocationEnvelopeOptionsV1): Promise<AllocationEnvelopeV1> {
  assertRecipientKey(options.recipientKey);
  if (!(options.plaintext instanceof Uint8Array) || options.plaintext.length === 0 || options.plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new AllocationEnvelopeCryptoError('INVALID_PLAINTEXT');
  }
  const header: AllocationEnvelopeHeaderV1 = { version: ENVELOPE_VERSION, ...options.header, encryptionKeyId: options.recipientKey.keyId };
  const aad = canonicalAad(header);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const recipientPublicKey = await importPublicKey(options.recipientKey.publicKey);
  const ephemeral = await generateEphemeralKeyPair();
  let ephemeralPublicKey: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  try {
    ephemeralPublicKey = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
    const cipherKey = await deriveCipherKey(ephemeral.privateKey, recipientPublicKey, salt, aad);
    ciphertext = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv: asOwnedBuffer(nonce), additionalData: asOwnedBuffer(aad), tagLength: 128 },
      cipherKey,
      asOwnedBuffer(options.plaintext),
    ));
    return {
      ...header, algorithm: ENVELOPE_ALGORITHM, ephemeralPublicKey: bytesToBase64Url(ephemeralPublicKey),
      salt: bytesToBase64Url(salt), nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ciphertext),
    };
  } catch (error) {
    if (error instanceof AllocationEnvelopeCryptoError) throw error;
    throw new AllocationEnvelopeCryptoError('ENVELOPE_ENCRYPT_FAILED');
  } finally {
    aad.fill(0);
    salt.fill(0);
    nonce.fill(0);
    ephemeralPublicKey?.fill(0);
    ciphertext?.fill(0);
  }
}

/** Opens an allocation only in the recipient context and zeroes plaintext after the callback returns. */
export async function withOpenedAllocationEnvelopeV1<Result>(
  envelope: AllocationEnvelopeV1,
  recipientKey: AllocationRecipientDecryptionKeyV1,
  consume: (plaintext: Uint8Array) => Result | Promise<Result>,
): Promise<Result> {
  validateAllocationEnvelopeV1(envelope);
  assertRecipientKey(recipientKey);
  if (envelope.encryptionKeyId !== recipientKey.keyId) throw new AllocationEnvelopeCryptoError('UNKNOWN_RECIPIENT_KEY');
  const aad = canonicalAad(headerFromEnvelope(envelope));
  const ephemeralPublicKey = await importPublicKey(envelope.ephemeralPublicKey);
  const salt = base64UrlToBytes(envelope.salt, 'SALT');
  const nonce = base64UrlToBytes(envelope.nonce, 'NONCE');
  const ciphertext = base64UrlToBytes(envelope.ciphertext, 'CIPHERTEXT');
  let plaintext: Uint8Array | undefined;
  try {
    const cipherKey = await deriveCipherKey(recipientKey.privateKey, ephemeralPublicKey, salt, aad);
    try {
      plaintext = new Uint8Array(await subtle().decrypt(
        { name: 'AES-GCM', iv: asOwnedBuffer(nonce), additionalData: asOwnedBuffer(aad), tagLength: 128 },
        cipherKey,
        asOwnedBuffer(ciphertext),
      ));
    } catch {
      throw new AllocationEnvelopeCryptoError('ENVELOPE_AUTH_FAILED');
    }
    return await consume(plaintext);
  } finally {
    aad.fill(0);
    salt.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    plaintext?.fill(0);
  }
}
