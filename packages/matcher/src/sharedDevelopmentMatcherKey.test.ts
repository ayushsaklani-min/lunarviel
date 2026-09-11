import { describe, expect, it } from 'vitest';

import {
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
  withOpenedOrderEnvelopeV1,
  type MatcherDecryptionKeyV1,
} from '@lunarveil/crypto';

import {
  SharedDevelopmentMatcherKeyError,
  SharedDevelopmentMatcherKeyStoreV1,
} from './sharedDevelopmentMatcherKey.js';

const SEED = 'a7'.repeat(32);
const OTHER_SEED = 'b3'.repeat(32);
const NOW = 1_800_000_000_000n;

function options(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'development',
    seedHex: SEED,
    keyId: 'matcher-shared-dev',
    activeFromMs: NOW - 1n,
    expiresAtMs: NOW + 600_000n,
    ...overrides,
  } as Parameters<typeof SharedDevelopmentMatcherKeyStoreV1.create>[0];
}

describe('SharedDevelopmentMatcherKeyStoreV1', () => {
  it('derives the same public key in every process from one seed', async () => {
    // This is the whole point: the API server and the matcher run in separate
    // processes and must agree on the key, or nothing can ever be decrypted.
    const first = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    const second = await SharedDevelopmentMatcherKeyStoreV1.create(options());

    expect(first.activePublicKey(NOW).publicKey).toBe(second.activePublicKey(NOW).publicKey);
    expect(first.privateKeyRef).toBe(second.privateKeyRef);
  });

  it('derives a different key from a different seed', async () => {
    const first = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    const other = await SharedDevelopmentMatcherKeyStoreV1.create(options({ seedHex: OTHER_SEED }));
    expect(first.activePublicKey(NOW).publicKey).not.toBe(other.activePublicKey(NOW).publicKey);
  });

  it('decrypts an envelope sealed by a separately constructed store', async () => {
    // The end-to-end property, across two independent store instances.
    const sealer = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    const opener = await SharedDevelopmentMatcherKeyStoreV1.create(options());

    const plaintext = new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}');
    const envelope = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: '4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c',
        marketId: 'market-1',
        epochId: 'epoch-1',
        commitment: 'ab'.repeat(32),
        traderTagHash: 'cd'.repeat(32),
      },
      matcherKey: sealer.activePublicKey(NOW),
      plaintext,
      nowMs: NOW,
    });

    const decryptionKey: MatcherDecryptionKeyV1 = {
      ...opener.activePublicKey(NOW),
      privateKey: await opener.resolvePrivateKey({
        keyId: 'matcher-shared-dev', privateKeyRef: opener.privateKeyRef,
      }),
    };
    const side = await withOpenedOrderEnvelopeV1(
      envelope,
      decryptionKey,
      opened => (JSON.parse(new TextDecoder().decode(opened)) as { side: string }).side,
    );
    expect(side).toBe('BUY');
  });

  it('publishes a key the envelope layer accepts unchanged', async () => {
    const store = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    const published = store.activePublicKey(NOW);
    expect(matcherPublicKeyV1(published)).toEqual(published);
    expect(published.algorithm).toBe('X25519-HKDF-SHA256-AES-256-GCM');
  });

  it('refuses to exist outside a development environment', async () => {
    // The seed is plaintext configuration: anyone who can read it can decrypt
    // every order. It must never be reachable in production.
    for (const environment of ['production', 'staging', 'test', '']) {
      await expect(SharedDevelopmentMatcherKeyStoreV1.create(options({ environment })))
        .rejects.toThrow(new SharedDevelopmentMatcherKeyError('PRODUCTION_REFUSED'));
    }
  });

  it('refuses a malformed seed, key id or validity window', async () => {
    await expect(SharedDevelopmentMatcherKeyStoreV1.create(options({ seedHex: 'ab' })))
      .rejects.toThrow(new SharedDevelopmentMatcherKeyError('INVALID_SEED'));
    await expect(SharedDevelopmentMatcherKeyStoreV1.create(options({ seedHex: 'zz'.repeat(32) })))
      .rejects.toThrow(new SharedDevelopmentMatcherKeyError('INVALID_SEED'));
    await expect(SharedDevelopmentMatcherKeyStoreV1.create(options({ keyId: '-bad' })))
      .rejects.toThrow(new SharedDevelopmentMatcherKeyError('INVALID_KEY_ID'));
    await expect(SharedDevelopmentMatcherKeyStoreV1.create(options({ expiresAtMs: NOW - 10n })))
      .rejects.toThrow(new SharedDevelopmentMatcherKeyError('INVALID_TIME_RANGE'));
  });

  it('refuses to publish a key outside its validity window', async () => {
    const store = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    expect(() => store.activePublicKey(NOW - 10n))
      .toThrow(new SharedDevelopmentMatcherKeyError('KEY_UNAVAILABLE'));
    expect(() => store.activePublicKey(NOW + 600_000n))
      .toThrow(new SharedDevelopmentMatcherKeyError('KEY_UNAVAILABLE'));
  });

  it('resolves only its own key id and reference', async () => {
    const store = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    await expect(store.resolvePrivateKey({ keyId: 'other', privateKeyRef: store.privateKeyRef }))
      .rejects.toThrow(new SharedDevelopmentMatcherKeyError('UNKNOWN_MATCHER_KEY'));
    await expect(store.resolvePrivateKey({ keyId: 'matcher-shared-dev', privateKeyRef: 'kms:other' }))
      .rejects.toThrow(new SharedDevelopmentMatcherKeyError('UNKNOWN_MATCHER_KEY'));
  });

  it('hands out a non-extractable private key', async () => {
    const store = await SharedDevelopmentMatcherKeyStoreV1.create(options());
    const key = await store.resolvePrivateKey({
      keyId: 'matcher-shared-dev', privateKeyRef: store.privateKeyRef,
    });
    expect(key.extractable).toBe(false);
    expect(key.type).toBe('private');
    expect(key.algorithm.name).toBe('X25519');
  });
});
