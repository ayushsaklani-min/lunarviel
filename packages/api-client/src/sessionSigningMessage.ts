import { LunarveilApiError } from './errors.js';

/**
 * The canonical string a wallet signs to prove control of an identity.
 *
 * It lives in this package, not in the server, because both sides must build
 * it from one definition. The browser signs what this returns; the server
 * verifies against what this returns. A second copy would drift, and a drifted
 * session message is an authentication bypass waiting to happen.
 *
 * The encoding is injective: every field is rejected if it contains a newline
 * or a control character, so no field value can fake a following line and
 * shift the meaning of the message.
 */
export const SESSION_MESSAGE_PREFIX_V1 = 'lunarveil-session-v1';

export interface SessionSigningMessageInputV1 {
  readonly domain: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly walletIdentity: string;
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

export function buildSessionSigningMessageV1(input: SessionSigningMessageInputV1): string {
  const domain = field(input.domain, 255);
  const challengeId = field(input.challengeId, 128);
  const nonce = field(input.nonce, 512);
  const walletIdentity = field(input.walletIdentity, 256);
  return [
    SESSION_MESSAGE_PREFIX_V1,
    `domain=${domain}`,
    `challenge=${challengeId}`,
    `nonce=${nonce}`,
    `wallet=${walletIdentity}`,
  ].join('\n');
}

/** The exact bytes a signature must cover. */
export function sessionSigningMessageBytesV1(input: SessionSigningMessageInputV1): Uint8Array {
  return new TextEncoder().encode(buildSessionSigningMessageV1(input));
}
