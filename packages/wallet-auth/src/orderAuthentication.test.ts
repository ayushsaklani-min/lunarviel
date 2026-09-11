import { describe, expect, it } from 'vitest';

import { buildOrderSigningMessageV1, orderSigningMessageBytesV1 } from '@lunarveil/api-client';
import { walletIdentityHashV1 } from '@lunarveil/matcher';
import {
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
  verifySignature,
} from '@midnight-ntwrk/ledger-v8';

import { LedgerOrderEnvelopeSignatureVerifierV1 } from './ledgerOrderEnvelopeSignatureVerifier.js';
import { HmacTraderSessionBindingVerifierV1, TraderTagError, deriveTraderTagHashV1 } from './traderTag.js';

const ledger = { verifySignature, addressFromKey };
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function wallet() {
  const signingKey = sampleSigningKey();
  const verifyingKey = signatureVerifyingKey(signingKey);
  const identity = addressFromKey(verifyingKey);
  return { signingKey, verifyingKey, identity, identityHash: walletIdentityHashV1(identity) };
}

function envelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1,
    clientRequestId: '4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c',
    marketId: 'market-1',
    epochId: 'epoch-1',
    commitment: 'ab'.repeat(32),
    traderTagHash: 'cd'.repeat(32),
    encryptionKeyId: 'matcher-key-1',
    algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
    ephemeralPublicKey: 'ZXBoZW1lcmFs',
    salt: 'c2FsdA',
    nonce: 'bm9uY2U',
    ciphertext: 'Y2lwaGVydGV4dA',
    ...overrides,
  } as Parameters<typeof buildOrderSigningMessageV1>[0];
}

describe('deriveTraderTagHashV1', () => {
  it('is deterministic for a key and identity, and differs across both', () => {
    const identityHash = 'ab'.repeat(32);
    const other = 'cd'.repeat(32);

    expect(deriveTraderTagHashV1(KEY, identityHash)).toBe(deriveTraderTagHashV1(KEY, identityHash));
    expect(deriveTraderTagHashV1(KEY, identityHash)).not.toBe(deriveTraderTagHashV1(KEY, other));
    // A rotated key produces different tags: this is the orphaning cost the
    // derivation's documentation calls out, asserted so it is not a surprise.
    expect(deriveTraderTagHashV1(KEY, identityHash)).not.toBe(deriveTraderTagHashV1(OTHER_KEY, identityHash));
    expect(deriveTraderTagHashV1(KEY, identityHash)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('refuses a short key or a malformed identity hash', () => {
    expect(() => deriveTraderTagHashV1(new Uint8Array(31), 'ab'.repeat(32))).toThrow(TraderTagError);
    expect(() => deriveTraderTagHashV1(KEY, 'not-a-hash')).toThrow(TraderTagError);
    expect(() => deriveTraderTagHashV1(KEY, 'AB'.repeat(32))).toThrow(TraderTagError);
  });
});

describe('HmacTraderSessionBindingVerifierV1', () => {
  it('accepts the tag it issued for that session', async () => {
    const verifier = new HmacTraderSessionBindingVerifierV1(KEY);
    const identityHash = 'ab'.repeat(32);
    const tag = verifier.tagFor(identityHash);
    expect(await verifier.verify({ walletIdentityHash: identityHash, traderTagHash: tag })).toBe(true);
  });

  it("refuses another trader's tag", async () => {
    // The attack: attributing an order to someone else by reusing their tag.
    const verifier = new HmacTraderSessionBindingVerifierV1(KEY);
    const victimTag = verifier.tagFor('ab'.repeat(32));
    expect(await verifier.verify({ walletIdentityHash: 'cd'.repeat(32), traderTagHash: victimTag })).toBe(false);
  });

  it('refuses a tag minted under a different key, and any malformed tag', async () => {
    const verifier = new HmacTraderSessionBindingVerifierV1(KEY);
    const identityHash = 'ab'.repeat(32);
    const foreign = new HmacTraderSessionBindingVerifierV1(OTHER_KEY).tagFor(identityHash);

    expect(await verifier.verify({ walletIdentityHash: identityHash, traderTagHash: foreign })).toBe(false);
    expect(await verifier.verify({ walletIdentityHash: identityHash, traderTagHash: 'short' })).toBe(false);
    expect(await verifier.verify({ walletIdentityHash: 'bad', traderTagHash: verifier.tagFor(identityHash) }))
      .toBe(false);
  });

  it('refuses to construct with a weak key', () => {
    expect(() => new HmacTraderSessionBindingVerifierV1(new Uint8Array(16))).toThrow(TraderTagError);
  });
});

describe('LedgerOrderEnvelopeSignatureVerifierV1', () => {
  it('accepts a genuine signature from the session wallet', async () => {
    const user = wallet();
    const order = envelope();
    const signature = hexToBytes(signData(user.signingKey, orderSigningMessageBytesV1(order)));

    const verifier = new LedgerOrderEnvelopeSignatureVerifierV1(ledger);
    expect(await verifier.verify({
      walletIdentityHash: user.identityHash,
      envelope: order,
      signature,
      verifyingKey: user.verifyingKey,
    })).toBe(true);
  });

  it("refuses a valid signature from a wallet other than the session's", async () => {
    const session = wallet();
    const attacker = wallet();
    const order = envelope();
    const signature = hexToBytes(signData(attacker.signingKey, orderSigningMessageBytesV1(order)));

    const verifier = new LedgerOrderEnvelopeSignatureVerifierV1(ledger);
    expect(await verifier.verify({
      walletIdentityHash: session.identityHash,
      envelope: order,
      signature,
      verifyingKey: attacker.verifyingKey,
    })).toBe(false);
  });

  it('refuses a swapped ciphertext under an otherwise valid signature', async () => {
    // The whole reason the signature covers the ciphertext: otherwise the
    // order admitted is not the order the user approved.
    const user = wallet();
    const approved = envelope();
    const signature = hexToBytes(signData(user.signingKey, orderSigningMessageBytesV1(approved)));

    const verifier = new LedgerOrderEnvelopeSignatureVerifierV1(ledger);
    expect(await verifier.verify({
      walletIdentityHash: user.identityHash,
      envelope: envelope({ ciphertext: 'c3dhcHBlZA' }),
      signature,
      verifyingKey: user.verifyingKey,
    })).toBe(false);
  });

  it('refuses a swapped commitment, market, epoch or trader tag', async () => {
    const user = wallet();
    const approved = envelope();
    const signature = hexToBytes(signData(user.signingKey, orderSigningMessageBytesV1(approved)));
    const verifier = new LedgerOrderEnvelopeSignatureVerifierV1(ledger);

    for (const tampered of [
      envelope({ commitment: 'ef'.repeat(32) }),
      envelope({ marketId: 'market-2' }),
      envelope({ epochId: 'epoch-2' }),
      envelope({ traderTagHash: 'ef'.repeat(32) }),
    ]) {
      expect(await verifier.verify({
        walletIdentityHash: user.identityHash,
        envelope: tampered,
        signature,
        verifyingKey: user.verifyingKey,
      })).toBe(false);
    }
  });

  it('accepts a wallet-chosen prefix but refuses appended bytes', async () => {
    const user = wallet();
    const order = envelope();
    const message = orderSigningMessageBytesV1(order);

    const prefixed = new Uint8Array([...new TextEncoder().encode('Midnight Signed Message:\n'), ...message]);
    const suffixed = new Uint8Array([...message, ...new TextEncoder().encode('\nciphertext=other')]);
    const verifier = new LedgerOrderEnvelopeSignatureVerifierV1(ledger);

    expect(await verifier.verify({
      walletIdentityHash: user.identityHash,
      envelope: order,
      signature: hexToBytes(signData(user.signingKey, prefixed)),
      verifyingKey: user.verifyingKey,
      signedData: prefixed,
    })).toBe(true);

    expect(await verifier.verify({
      walletIdentityHash: user.identityHash,
      envelope: order,
      signature: hexToBytes(signData(user.signingKey, suffixed)),
      verifyingKey: user.verifyingKey,
      signedData: suffixed,
    })).toBe(false);
  });

  it('refuses a missing verifying key, an empty signature and a malformed envelope', async () => {
    const user = wallet();
    const order = envelope();
    const signature = hexToBytes(signData(user.signingKey, orderSigningMessageBytesV1(order)));
    const verifier = new LedgerOrderEnvelopeSignatureVerifierV1(ledger);

    expect(await verifier.verify({ walletIdentityHash: user.identityHash, envelope: order, signature }))
      .toBe(false);
    expect(await verifier.verify({
      walletIdentityHash: user.identityHash, envelope: order,
      signature: new Uint8Array(0), verifyingKey: user.verifyingKey,
    })).toBe(false);
    expect(await verifier.verify({
      walletIdentityHash: user.identityHash,
      envelope: envelope({ marketId: '' }),
      signature, verifyingKey: user.verifyingKey,
    })).toBe(false);
  });
});
