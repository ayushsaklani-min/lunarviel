export async function fingerprintOpaquePayload(payload: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`LUNARVEIL_SETTLEMENT_PAYLOAD_V1\0${payload}`),
  );
  return Buffer.from(digest).toString('hex');
}
