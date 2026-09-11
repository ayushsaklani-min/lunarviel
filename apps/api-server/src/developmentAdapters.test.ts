import { describe, expect, it } from 'vitest';

import {
  DevelopmentAdapterError,
  DevelopmentEnvelopeSignatureVerifierV1,
  DevelopmentMatcherKeyStoreV1,
  DevelopmentTraderBindingVerifierV1,
  DevelopmentWalletSignatureVerifierV1,
  developmentEnvelopeSignatureV1,
  developmentTraderTagHashV1,
  developmentWalletSignatureV1,
} from './developmentAdapters.js';

const nowMs = 1_800_000_000_000n;
const secret = new Uint8Array(32).fill(5);
const otherSecret = new Uint8Array(32).fill(6);

describe('development adapters refuse anything but development', () => {
  it('refuses to construct a key store outside development', async () => {
    for (const environment of ['staging', 'production'] as const) {
      await expect(DevelopmentMatcherKeyStoreV1.create({ environment, nowMs }))
        .rejects.toThrow(DevelopmentAdapterError);
    }
    await expect(DevelopmentMatcherKeyStoreV1.create({ environment: 'development', nowMs }))
      .resolves.toBeInstanceOf(DevelopmentMatcherKeyStoreV1);
  });

  it('refuses to construct stub verifiers outside development', () => {
    for (const environment of ['staging', 'production'] as const) {
      expect(() => new DevelopmentWalletSignatureVerifierV1(secret, environment)).toThrow(DevelopmentAdapterError);
      expect(() => new DevelopmentTraderBindingVerifierV1(secret, environment)).toThrow(DevelopmentAdapterError);
      expect(() => new DevelopmentEnvelopeSignatureVerifierV1(secret, environment)).toThrow(DevelopmentAdapterError);
    }
  });
});

describe('DevelopmentMatcherKeyStoreV1', () => {
  it('publishes only public metadata and resolves the private key for its own reference', async () => {
    const store = await DevelopmentMatcherKeyStoreV1.create({ environment: 'development', nowMs });
    const publicKey = store.activePublicKey(nowMs);
    expect(Object.keys(publicKey).sort()).toEqual([
      'activeFromMs', 'algorithm', 'expiresAtMs', 'keyId', 'publicKey', 'version',
    ]);
    expect(publicKey).not.toHaveProperty('privateKey');

    const resolved = await store.resolvePrivateKey({ keyId: publicKey.keyId, privateKeyRef: store.privateKeyRef });
    expect(resolved.type).toBe('private');
    expect(resolved.extractable).toBe(false);

    await expect(store.resolvePrivateKey({ keyId: 'other', privateKeyRef: store.privateKeyRef }))
      .rejects.toThrow(DevelopmentAdapterError);
    await expect(store.resolvePrivateKey({ keyId: publicKey.keyId, privateKeyRef: 'dev-local:other' }))
      .rejects.toThrow(DevelopmentAdapterError);
  });

  it('refuses to publish a key outside its own validity window', async () => {
    const store = await DevelopmentMatcherKeyStoreV1.create({ environment: 'development', nowMs, lifetimeMs: 1_000n });
    expect(() => store.activePublicKey(nowMs - 1n)).toThrow(DevelopmentAdapterError);
    expect(() => store.activePublicKey(nowMs + 1_000n)).toThrow(DevelopmentAdapterError);
    expect(store.activePublicKey(nowMs + 999n).keyId).toBe(store.activePublicKey(nowMs).keyId);
  });
});

describe('development verifiers', () => {
  it('accepts only the trader tag derivable from the authenticated wallet', async () => {
    const verifier = new DevelopmentTraderBindingVerifierV1(secret, 'development');
    const walletIdentityHash = 'aa'.repeat(32);
    const traderTagHash = developmentTraderTagHashV1(walletIdentityHash, secret);

    expect(await verifier.verify({ walletIdentityHash, traderTagHash })).toBe(true);
    expect(await verifier.verify({ walletIdentityHash, traderTagHash: 'bb'.repeat(32) })).toBe(false);
    expect(await verifier.verify({ walletIdentityHash: 'cc'.repeat(32), traderTagHash })).toBe(false);
    expect(await verifier.verify({
      walletIdentityHash,
      traderTagHash: developmentTraderTagHashV1(walletIdentityHash, otherSecret),
    })).toBe(false);
  });

  it('accepts only a session signature bound to every challenge field', async () => {
    const verifier = new DevelopmentWalletSignatureVerifierV1(secret, 'development');
    const base = {
      domain: 'https://app.lunarveil.test', challengeId: 'challenge-1',
      nonce: 'nonce-1', walletIdentity: 'wallet-1',
    };
    const signature = developmentWalletSignatureV1({ ...base, secret });
    expect(await verifier.verify({ ...base, signature })).toBe(true);

    for (const field of ['domain', 'challengeId', 'nonce', 'walletIdentity'] as const) {
      expect(await verifier.verify({ ...base, [field]: 'tampered', signature })).toBe(false);
    }
    expect(await verifier.verify({ ...base, signature: developmentWalletSignatureV1({ ...base, secret: otherSecret }) })).toBe(false);
    expect(await verifier.verify({ ...base, signature: new Uint8Array(0) })).toBe(false);
    expect(await verifier.verify({ ...base, signature: new Uint8Array(31) })).toBe(false);
  });

  it('accepts only an envelope signature bound to wallet, commitment and request id', async () => {
    const verifier = new DevelopmentEnvelopeSignatureVerifierV1(secret, 'development');
    const walletIdentityHash = 'aa'.repeat(32);
    const envelope = { commitment: '11'.repeat(32), clientRequestId: 'request-1' };
    const signature = developmentEnvelopeSignatureV1({
      walletIdentityHash, commitment: envelope.commitment, clientRequestId: envelope.clientRequestId, secret,
    });

    expect(await verifier.verify({ walletIdentityHash, envelope, signature })).toBe(true);
    expect(await verifier.verify({ walletIdentityHash: 'bb'.repeat(32), envelope, signature })).toBe(false);
    expect(await verifier.verify({
      walletIdentityHash, envelope: { ...envelope, commitment: '22'.repeat(32) }, signature,
    })).toBe(false);
    expect(await verifier.verify({
      walletIdentityHash, envelope: { ...envelope, clientRequestId: 'request-2' }, signature,
    })).toBe(false);
    expect(await verifier.verify({ walletIdentityHash, envelope, signature: new Uint8Array(32) })).toBe(false);
  });
});
