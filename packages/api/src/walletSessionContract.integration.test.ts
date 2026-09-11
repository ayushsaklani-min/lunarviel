import { afterEach, describe, expect, it } from 'vitest';

import {
  LunarveilApiClientV1,
  buildSessionSigningMessageV1,
  type LunarveilApiError,
} from '@lunarveil/api-client';
import { InMemorySessionChallengeService } from '@lunarveil/matcher';
import { LedgerWalletSignatureVerifierV1 } from '@lunarveil/wallet-auth';
import {
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
  verifySignature,
} from '@midnight-ntwrk/ledger-v8';

import type { MatcherEncryptionPublicKeyV1 } from '@lunarveil/crypto';
import type { LunarveilApiDependencies } from './lunarveilApi.js';
import type { LunarveilRuntimeConfigV1 } from './runtimeConfig.js';
import { startLunarveilApiV1, type StartedLunarveilApiV1 } from './server.js';

/**
 * The full wallet-authentication slice, end to end and unfaked apart from the
 * browser itself.
 *
 * Real Fastify listener on a real port, the real browser API client over real
 * HTTP, the real session challenge service, the real ledger verifier, and a
 * real Midnight signing key producing real signatures. The only thing standing
 * in for a wallet extension is the local signing key.
 */

const nowMs = 1_800_000_000_000n;

const matcherKey: MatcherEncryptionPublicKeyV1 = {
  version: 1,
  keyId: 'matcher-session-contract',
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
  publicKey: 'A'.repeat(43),
  activeFromMs: nowMs - 1n,
  expiresAtMs: nowMs + 1_000n,
};

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function wallet() {
  const signingKey = sampleSigningKey();
  const verifyingKey = signatureVerifyingKey(signingKey);
  return { signingKey, verifyingKey, identity: addressFromKey(verifyingKey) };
}

function dependencies(): LunarveilApiDependencies {
  return {
    nowMs: () => nowMs,
    matcherKeys: { activePublicKey: () => matcherKey },
    sessions: new InMemorySessionChallengeService({
      nowMs: () => nowMs,
      challengeLifetimeMs: 60_000n,
      sessionLifetimeMs: 600_000n,
      verifier: new LedgerWalletSignatureVerifierV1({ verifySignature, addressFromKey }),
    }),
    orders: { async submit() { throw new Error('not reached'); } },
    markets: {
      async listMarkets() { return []; },
      async currentEpoch() { return undefined; },
    },
    systemStatus: {
      async read() { return { state: 'READY' as const, components: [{ name: 'DATABASE' as const, state: 'READY' as const }] }; },
    },
  } as LunarveilApiDependencies;
}

function config(): LunarveilRuntimeConfigV1 {
  return {
    environment: 'development',
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    allowedOrigins: [],
    trustProxy: false,
  };
}

let started: StartedLunarveilApiV1 | undefined;

afterEach(async () => {
  await started?.app.close();
  started = undefined;
});

async function api(): Promise<LunarveilApiClientV1> {
  started = await startLunarveilApiV1(dependencies(), config());
  return new LunarveilApiClientV1({ baseUrl: started.address });
}

describe('wallet session, end to end over real HTTP with real signatures', () => {
  it('issues a session for a genuine wallet signature', async () => {
    const client = await api();
    const user = wallet();

    const challenge = await client.createSessionChallenge({
      domain: 'app.lunarveil.test',
      walletIdentity: user.identity,
    });
    expect(challenge.walletIdentity).toBe(user.identity);

    const message = buildSessionSigningMessageV1({
      domain: challenge.domain,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      walletIdentity: challenge.walletIdentity,
    });
    const signature = signData(user.signingKey, new TextEncoder().encode(message));

    const session = await client.verifySessionChallenge({
      challengeId: challenge.id,
      signature: base64Url(hexToBytes(signature)),
      verifyingKey: user.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    });

    expect(session.token.length).toBeGreaterThan(0);
    expect(BigInt(session.expiresAtMs)).toBeGreaterThan(nowMs);
  });

  it('refuses a signature from a wallet that does not own the claimed identity', async () => {
    const client = await api();
    const victim = wallet();
    const attacker = wallet();

    const challenge = await client.createSessionChallenge({
      domain: 'app.lunarveil.test',
      walletIdentity: victim.identity,
    });
    const message = buildSessionSigningMessageV1({
      domain: challenge.domain,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      walletIdentity: challenge.walletIdentity,
    });
    // A genuine signature — over the right message — from the wrong wallet.
    const signature = signData(attacker.signingKey, new TextEncoder().encode(message));

    const error = await client.verifySessionChallenge({
      challengeId: challenge.id,
      signature: base64Url(hexToBytes(signature)),
      verifyingKey: attacker.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    }).catch((thrown: unknown) => thrown);

    expect((error as LunarveilApiError).code).toBe('REQUEST_REJECTED');
    expect((error as LunarveilApiError).serverCode).toBe('INVALID_SIGNATURE');
  });

  it('refuses a replayed challenge even with the correct signature', async () => {
    const client = await api();
    const user = wallet();

    const challenge = await client.createSessionChallenge({
      domain: 'app.lunarveil.test',
      walletIdentity: user.identity,
    });
    const message = buildSessionSigningMessageV1({
      domain: challenge.domain,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      walletIdentity: challenge.walletIdentity,
    });
    const body = {
      challengeId: challenge.id,
      signature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
      verifyingKey: user.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    };

    await client.verifySessionChallenge(body);
    const replayed = await client.verifySessionChallenge(body).catch((thrown: unknown) => thrown);
    expect((replayed as LunarveilApiError).serverCode).toBe('CHALLENGE_REPLAYED');
  });

  it('refuses a signature bound to a different challenge', async () => {
    const client = await api();
    const user = wallet();

    const first = await client.createSessionChallenge({ domain: 'app.lunarveil.test', walletIdentity: user.identity });
    const second = await client.createSessionChallenge({ domain: 'app.lunarveil.test', walletIdentity: user.identity });

    const messageForFirst = buildSessionSigningMessageV1({
      domain: first.domain, challengeId: first.id, nonce: first.nonce, walletIdentity: first.walletIdentity,
    });
    const signature = signData(user.signingKey, new TextEncoder().encode(messageForFirst));

    const error = await client.verifySessionChallenge({
      challengeId: second.id,
      signature: base64Url(hexToBytes(signature)),
      verifyingKey: user.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(messageForFirst)),
    }).catch((thrown: unknown) => thrown);

    expect((error as LunarveilApiError).serverCode).toBe('INVALID_SIGNATURE');
  });

  it('refuses a request that omits the verifying key entirely', async () => {
    const client = await api();
    const user = wallet();

    const challenge = await client.createSessionChallenge({
      domain: 'app.lunarveil.test',
      walletIdentity: user.identity,
    });
    const message = buildSessionSigningMessageV1({
      domain: challenge.domain,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      walletIdentity: challenge.walletIdentity,
    });

    const error = await client.verifySessionChallenge({
      challengeId: challenge.id,
      signature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
    }).catch((thrown: unknown) => thrown);

    expect((error as LunarveilApiError).serverCode).toBe('INVALID_SIGNATURE');
  });
});
