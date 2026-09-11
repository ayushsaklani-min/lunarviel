import { describe, expect, it } from 'vitest';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  OrderEnvelopeCryptoError,
  sealOrderEnvelopeV1,
  withOpenedOrderEnvelopeV1,
} from './orderEnvelope.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nowMs = 1_800_000_000_000n;

function header() {
  return {
    clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
    marketId: 'NIGHT-USDCX',
    epochId: 'epoch-7',
    commitment: '11'.repeat(32),
    traderTagHash: '22'.repeat(32),
  };
}

async function activeKey(keyId = 'matcher-2026-09-a') {
  return generateMatcherDecryptionKeyV1({
    keyId,
    activeFromMs: nowMs - 1n,
    expiresAtMs: nowMs + 60_000n,
  });
}

describe('OrderEnvelopeV1', () => {
  it('round-trips only through matcher in-memory consumption and clears the plaintext buffer', async () => {
    const matcherKey = await activeKey();
    const rawIntent = encoder.encode('{"side":"BUY","quantityLots":"7","limitPriceTicks":"42000"}');
    const envelope = await sealOrderEnvelopeV1({
      header: header(),
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: rawIntent,
      nowMs,
    });
    const serialized = JSON.stringify(envelope);
    let consumed: Uint8Array | undefined;

    const decoded = await withOpenedOrderEnvelopeV1(envelope, matcherKey, (plaintext) => {
      consumed = plaintext;
      return decoder.decode(plaintext);
    });

    expect(decoded).toContain('limitPriceTicks');
    expect(serialized).not.toContain('limitPriceTicks');
    expect(consumed).toBeDefined();
    expect([...consumed ?? []].every((value) => value === 0)).toBe(true);
  });

  it('rejects tampered authenticated routing metadata without exposing plaintext', async () => {
    const matcherKey = await activeKey();
    const envelope = await sealOrderEnvelopeV1({
      header: header(),
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: encoder.encode('private order'),
      nowMs,
    });

    await expect(withOpenedOrderEnvelopeV1(
      { ...envelope, epochId: 'epoch-8' },
      matcherKey,
      () => 'unexpected',
    )).rejects.toMatchObject({ code: 'ENVELOPE_AUTH_FAILED' });
  });

  it('rejects a different matcher key', async () => {
    const matcherKey = await activeKey();
    const wrongMatcherKey = await activeKey('matcher-2026-09-b');
    const envelope = await sealOrderEnvelopeV1({
      header: header(),
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: encoder.encode('private order'),
      nowMs,
    });

    await expect(withOpenedOrderEnvelopeV1(envelope, wrongMatcherKey, () => 'unexpected'))
      .rejects.toMatchObject({ code: 'UNKNOWN_MATCHER_KEY' });
  });

  it('rejects inactive keys before encrypting', async () => {
    const matcherKey = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-future',
      activeFromMs: nowMs + 1n,
      expiresAtMs: nowMs + 60_000n,
    });

    await expect(sealOrderEnvelopeV1({
      header: header(),
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: encoder.encode('private order'),
      nowMs,
    })).rejects.toMatchObject({ code: 'MATCHER_KEY_INACTIVE' });
  });

  it('clears plaintext if the matcher consumer fails', async () => {
    const matcherKey = await activeKey();
    const envelope = await sealOrderEnvelopeV1({
      header: header(),
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: encoder.encode('private order'),
      nowMs,
    });
    let consumed: Uint8Array | undefined;

    await expect(withOpenedOrderEnvelopeV1(envelope, matcherKey, (plaintext) => {
      consumed = plaintext;
      throw new Error('consumer failed');
    })).rejects.toThrow('consumer failed');

    expect(consumed).toBeDefined();
    expect([...consumed ?? []].every((value) => value === 0)).toBe(true);
  });
});
