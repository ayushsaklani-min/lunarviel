import { describe, expect, it } from 'vitest';

import { sessionSigningMessageBytesV1 } from '@lunarveil/api-client';
import {
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
  verifySignature,
} from '@midnight-ntwrk/ledger-v8';

import { LedgerWalletSignatureVerifierV1 } from './ledgerWalletSignatureVerifier.js';
import { loadLedgerSignatureApiV1 } from './ledgerSignatureApi.js';

/**
 * These tests use the real ledger primitives with real keys and real
 * signatures. Nothing about the cryptography here is mocked; the only thing
 * standing in for a browser wallet is the local signing key.
 */

const ledger = { verifySignature, addressFromKey };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function wallet() {
  const signingKey = sampleSigningKey();
  const verifyingKey = signatureVerifyingKey(signingKey);
  return { signingKey, verifyingKey, identity: addressFromKey(verifyingKey) };
}

function challenge(identity: string) {
  return {
    domain: 'app.lunarveil.test',
    challengeId: 'challenge-1',
    nonce: 'bm9uY2UtdmFsdWU',
    walletIdentity: identity,
  };
}

describe('LedgerWalletSignatureVerifierV1', () => {
  it('accepts a genuine signature from the wallet that owns the identity', async () => {
    const user = wallet();
    const input = challenge(user.identity);
    const message = sessionSigningMessageBytesV1(input);
    const signature = hexToBytes(signData(user.signingKey, message));

    const verifier = new LedgerWalletSignatureVerifierV1(ledger);
    expect(await verifier.verify({ ...input, signature, verifyingKey: user.verifyingKey })).toBe(true);
  });

  it("rejects a valid signature from a key that does not own the claimed identity", async () => {
    // The attack this blocks: a real signature from an attacker's own wallet,
    // presented against someone else's identity. Signature validity alone
    // proves possession of a key, never of *this* wallet.
    const attacker = wallet();
    const victim = wallet();
    const input = challenge(victim.identity);
    const message = sessionSigningMessageBytesV1(input);
    const signature = hexToBytes(signData(attacker.signingKey, message));

    const verifier = new LedgerWalletSignatureVerifierV1(ledger);
    expect(await verifier.verify({ ...input, signature, verifyingKey: attacker.verifyingKey })).toBe(false);
  });

  it("rejects a signature over a different challenge, nonce or domain", async () => {
    const user = wallet();
    const input = challenge(user.identity);
    const signature = hexToBytes(signData(user.signingKey, sessionSigningMessageBytesV1(input)));
    const verifier = new LedgerWalletSignatureVerifierV1(ledger);

    for (const tampered of [
      { ...input, challengeId: 'challenge-2' },
      { ...input, nonce: 'ZGlmZmVyZW50' },
      { ...input, domain: 'evil.test' },
    ]) {
      expect(await verifier.verify({ ...tampered, signature, verifyingKey: user.verifyingKey })).toBe(false);
    }
  });

  it("accepts a wallet-chosen prefix, because the canonical message is still a suffix", async () => {
    // The connector's signData documents that it prepends a prefix it does not
    // specify. The signature must cover the reported bytes, and the canonical
    // message must terminate them.
    const user = wallet();
    const input = challenge(user.identity);
    const message = sessionSigningMessageBytesV1(input);
    const prefixed = new Uint8Array([...new TextEncoder().encode('Midnight Signed Message:\n'), ...message]);
    const signature = hexToBytes(signData(user.signingKey, prefixed));

    const verifier = new LedgerWalletSignatureVerifierV1(ledger);
    expect(await verifier.verify({ ...input, signature, verifyingKey: user.verifyingKey, signedData: prefixed }))
      .toBe(true);
  });

  it("rejects reported bytes that do not end with the canonical message", async () => {
    // A suffix, not a substring: trailing bytes could otherwise reinterpret
    // the message a user believed they were signing.
    const user = wallet();
    const input = challenge(user.identity);
    const message = sessionSigningMessageBytesV1(input);
    const suffixed = new Uint8Array([...message, ...new TextEncoder().encode('\nwallet=attacker')]);
    const signature = hexToBytes(signData(user.signingKey, suffixed));

    const verifier = new LedgerWalletSignatureVerifierV1(ledger);
    expect(await verifier.verify({ ...input, signature, verifyingKey: user.verifyingKey, signedData: suffixed }))
      .toBe(false);
  });

  it("rejects a signature over bytes other than the ones reported", async () => {
    const user = wallet();
    const input = challenge(user.identity);
    const message = sessionSigningMessageBytesV1(input);
    const signature = hexToBytes(signData(user.signingKey, new TextEncoder().encode('something else entirely')));

    const verifier = new LedgerWalletSignatureVerifierV1(ledger);
    expect(await verifier.verify({ ...input, signature, verifyingKey: user.verifyingKey, signedData: message }))
      .toBe(false);
  });

  it("rejects a missing, malformed or oversized verifying key", async () => {
    const user = wallet();
    const input = challenge(user.identity);
    const signature = hexToBytes(signData(user.signingKey, sessionSigningMessageBytesV1(input)));
    const verifier = new LedgerWalletSignatureVerifierV1(ledger);

    expect(await verifier.verify({ ...input, signature })).toBe(false);
    expect(await verifier.verify({ ...input, signature, verifyingKey: '' })).toBe(false);
    expect(await verifier.verify({ ...input, signature, verifyingKey: 'nothex!' })).toBe(false);
    expect(await verifier.verify({ ...input, signature, verifyingKey: 'abc' })).toBe(false);
    expect(await verifier.verify({ ...input, signature, verifyingKey: 'ab'.repeat(300) })).toBe(false);
  });

  it("rejects an empty signature and oversized reported data", async () => {
    const user = wallet();
    const input = challenge(user.identity);
    const message = sessionSigningMessageBytesV1(input);
    const signature = hexToBytes(signData(user.signingKey, message));
    const verifier = new LedgerWalletSignatureVerifierV1(ledger, { maxSignedDataBytes: 16 });

    expect(await verifier.verify({ ...input, signature: new Uint8Array(0), verifyingKey: user.verifyingKey }))
      .toBe(false);
    // The canonical message alone already exceeds this deliberately tiny cap.
    expect(await verifier.verify({ ...input, signature, verifyingKey: user.verifyingKey })).toBe(false);
  });

  it("returns false rather than throwing when the ledger rejects an input", async () => {
    const user = wallet();
    const input = challenge(user.identity);
    const signature = hexToBytes(signData(user.signingKey, sessionSigningMessageBytesV1(input)));
    const throwing = {
      verifySignature() { throw new Error('wasm panic'); },
      addressFromKey() { throw new Error('wasm panic'); },
    };

    const verifier = new LedgerWalletSignatureVerifierV1(throwing);
    expect(await verifier.verify({ ...input, signature, verifyingKey: user.verifyingKey })).toBe(false);
  });

  it("loads the real primitives through the composition-root loader", async () => {
    const api = await loadLedgerSignatureApiV1();
    const user = wallet();
    const message = sessionSigningMessageBytesV1(challenge(user.identity));
    expect(api.addressFromKey(user.verifyingKey)).toBe(user.identity);
    expect(api.verifySignature(user.verifyingKey, message, signData(user.signingKey, message))).toBe(true);
  });
});
