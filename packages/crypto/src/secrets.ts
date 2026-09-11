/**
 * Fresh per-order secrets.
 *
 * These use the Web Crypto CSPRNG (`globalThis.crypto`), which Node 22 and
 * every supported browser provide, rather than `node:crypto`. The previous
 * `randomBytes` import made this module — and therefore the whole package —
 * unloadable in a browser bundle, even though `@lunarveil/crypto` is a frozen
 * frontend package. See ADR-0039.
 */

function randomBytes32(): Uint8Array {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function generateCommitmentBlinding(): Uint8Array {
  return randomBytes32();
}

export function generateOrderNonce(): Uint8Array {
  return randomBytes32();
}

export function generateNullifierSecret(): Uint8Array {
  return randomBytes32();
}
