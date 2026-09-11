import { LunarveilApiError } from './errors.js';

/**
 * The canonical string a wallet signs to authorize one encrypted order.
 *
 * Like the session message, it lives here so the browser and the server build
 * it from one definition rather than two that can drift.
 *
 * Every public envelope field is covered, including the ciphertext. Signing
 * only the header would let an attacker who intercepts a submission swap the
 * ciphertext while keeping a valid signature — the order actually admitted
 * would then not be the order the user approved.
 *
 * Nothing here reveals order contents: every field is already public envelope
 * metadata or ciphertext.
 */
export const ORDER_MESSAGE_PREFIX_V1 = 'lunarveil-order-v1';

export interface OrderSigningMessageInputV1 {
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
}

function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function field(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasUnsafeCharacter(value)) {
    throw new LunarveilApiError('INVALID_ARGUMENT');
  }
  return value;
}

export function buildOrderSigningMessageV1(input: OrderSigningMessageInputV1): string {
  if (input.version !== 1) throw new LunarveilApiError('INVALID_ARGUMENT');
  return [
    ORDER_MESSAGE_PREFIX_V1,
    'version=1',
    `request=${field(input.clientRequestId, 64)}`,
    `market=${field(input.marketId, 128)}`,
    `epoch=${field(input.epochId, 128)}`,
    `commitment=${field(input.commitment, 64)}`,
    `trader=${field(input.traderTagHash, 64)}`,
    `key=${field(input.encryptionKeyId, 128)}`,
    `alg=${field(input.algorithm, 64)}`,
    `epk=${field(input.ephemeralPublicKey, 512)}`,
    `salt=${field(input.salt, 512)}`,
    `nonce=${field(input.nonce, 512)}`,
    `ciphertext=${field(input.ciphertext, 8_192)}`,
  ].join('\n');
}

/** The exact bytes an order signature must cover. */
export function orderSigningMessageBytesV1(input: OrderSigningMessageInputV1): Uint8Array {
  return new TextEncoder().encode(buildOrderSigningMessageV1(input));
}
