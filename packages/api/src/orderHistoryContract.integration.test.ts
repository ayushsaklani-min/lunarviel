import { afterEach, describe, expect, it } from 'vitest';

import {
  LunarveilApiClientV1,
  buildSessionSigningMessageV1,
  type LunarveilApiError,
} from '@lunarveil/api-client';
import {
  InMemorySessionChallengeService,
  TraderOrderHistoryServiceV1,
  type TraderOrderHistoryRepository,
} from '@lunarveil/matcher';
import type { TraderOrderRecordV1 } from '@lunarveil/db';
import { HmacTraderSessionBindingVerifierV1, LedgerWalletSignatureVerifierV1 } from '@lunarveil/wallet-auth';
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
 * Order history over the real listener with real sessions.
 *
 * The property that matters here is negative: one authenticated trader must
 * not be able to read another trader's orders, and there must be no request
 * field through which they could try.
 */

const nowMs = 1_800_000_000_000n;
const TRADER_TAG_KEY = new Uint8Array(32).fill(23);
const ledger = { verifySignature, addressFromKey };

const matcherKey: MatcherEncryptionPublicKeyV1 = {
  version: 1,
  keyId: 'matcher-history-test',
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
  publicKey: 'A'.repeat(43),
  activeFromMs: nowMs - 1n,
  expiresAtMs: nowMs + 600_000n,
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

function order(tag: string, index: number): TraderOrderRecordV1 {
  return {
    orderId: `order-${tag.slice(0, 4)}-${index}`,
    clientRequestId: `4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6${index}`,
    marketId: 'market-1',
    epochId: 'epoch-1',
    commitment: index.toString(16).padStart(2, '0').repeat(32),
    state: 'PENDING_CHAIN',
    createdAtMs: nowMs,
    acceptedAtMs: undefined,
    chainAdmissionTxId: undefined,
    leafIndex: undefined,
  };
}

let started: StartedLunarveilApiV1 | undefined;

afterEach(async () => {
  await started?.app.close();
  started = undefined;
});

interface HarnessV1 {
  readonly client: LunarveilApiClientV1;
  readonly requestedTags: string[];
}

async function harness(extra: Partial<TraderOrderRecordV1> = {}): Promise<HarnessV1> {
  const requestedTags: string[] = [];
  const traderTags = new HmacTraderSessionBindingVerifierV1(TRADER_TAG_KEY);
  const sessions = new InMemorySessionChallengeService({
    nowMs: () => nowMs,
    challengeLifetimeMs: 60_000n,
    sessionLifetimeMs: 600_000n,
    verifier: new LedgerWalletSignatureVerifierV1(ledger),
  });

  // Every trader has orders in this store; only the caller's own tag may
  // select any of them.
  const repository: TraderOrderHistoryRepository = {
    async listForTrader(input) {
      requestedTags.push(input.traderTagHash);
      return [{ ...order(input.traderTagHash, 1), ...extra }, order(input.traderTagHash, 2)].slice(0, input.limit);
    },
  };

  const dependencies = {
    nowMs: () => nowMs,
    matcherKeys: { activePublicKey: () => matcherKey },
    sessions,
    traderTags,
    orderHistory: new TraderOrderHistoryServiceV1(sessions, traderTags, repository),
    orders: { async submit() { throw new Error('not reached'); } },
    markets: { async listMarkets() { return []; }, async currentEpoch() { return undefined; } },
    systemStatus: {
      async read() { return { state: 'READY' as const, components: [{ name: 'DATABASE' as const, state: 'READY' as const }] }; },
    },
  } as unknown as LunarveilApiDependencies;

  const config: LunarveilRuntimeConfigV1 = {
    environment: 'development', host: '127.0.0.1', port: 0,
    bodyLimitBytes: 64 * 1024, allowedOrigins: [], trustProxy: false,
  };
  started = await startLunarveilApiV1(dependencies, config);
  return { client: new LunarveilApiClientV1({ baseUrl: started.address }), requestedTags };
}

async function openSession(client: LunarveilApiClientV1, user: ReturnType<typeof wallet>) {
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
  return client.verifySessionChallenge({
    challengeId: challenge.id,
    signature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
    verifyingKey: user.verifyingKey,
    signedData: base64Url(new TextEncoder().encode(message)),
  });
}

describe('trader order history over real HTTP', () => {
  it('carries the finalized admission submission tx id to the client', async () => {
    const txId = '00' + 'ab'.repeat(32);
    const { client } = await harness({ admissionSubmittedTxId: txId });
    const session = await openSession(client, wallet());
    const orders = await client.listMyOrders({ bearerToken: session.token });
    expect(orders[0]?.admissionSubmittedTxId).toBe(txId);
  });

  it("returns the caller's own orders, scoped to the session's derived tag", async () => {
    const { client, requestedTags } = await harness();
    const user = wallet();
    const session = await openSession(client, user);

    const orders = await client.listMyOrders({ bearerToken: session.token });

    expect(orders).toHaveLength(2);
    expect(orders[0]?.state).toBe('PENDING_CHAIN');
    // The tag queried is the one the server derived, not anything sent.
    expect(requestedTags).toEqual([session.traderTagHash]);
  });

  it('scopes two traders to different tags on the same server', async () => {
    const { client, requestedTags } = await harness();
    const first = await openSession(client, wallet());
    const second = await openSession(client, wallet());

    await client.listMyOrders({ bearerToken: first.token });
    await client.listMyOrders({ bearerToken: second.token });

    expect(first.traderTagHash).not.toBe(second.traderTagHash);
    expect(requestedTags).toEqual([first.traderTagHash, second.traderTagHash]);
  });

  it("ignores any smuggled trader tag and still returns only the caller's orders", async () => {
    const { client, requestedTags } = await harness();
    const victim = await openSession(client, wallet());
    const attacker = await openSession(client, wallet());

    // Fastify strips query parameters the schema does not declare rather than
    // rejecting them, so these requests succeed. What matters is that the
    // smuggled value reaches nothing: the tag queried is always the one
    // derived from the caller's own session.
    for (const query of [
      `?traderTagHash=${victim.traderTagHash}`,
      `?trader=${victim.traderTagHash}`,
      `?limit=1&traderTagHash=${victim.traderTagHash}`,
    ]) {
      const response = await fetch(`${started?.address ?? ''}/v1/orders${query}`, {
        headers: { authorization: `Bearer ${attacker.token}` },
      });
      expect(response.status).toBe(200);
    }

    expect(requestedTags).toEqual([
      attacker.traderTagHash, attacker.traderTagHash, attacker.traderTagHash,
    ]);
    expect(requestedTags).not.toContain(victim.traderTagHash);
  });

  it('refuses a missing, malformed or unknown session', async () => {
    const { client } = await harness();

    const noHeader = await fetch(`${started?.address ?? ''}/v1/orders`);
    expect(noHeader.status).toBe(401);

    const unknown = await client
      .listMyOrders({ bearerToken: 'bm90LWEtcmVhbC10b2tlbg' })
      .catch((thrown: unknown) => thrown);
    expect((unknown as LunarveilApiError).code).toBe('REQUEST_REJECTED');
    expect((unknown as LunarveilApiError).serverCode).toBe('SESSION_INVALID');
  });

  it('rejects a limit outside the allowed range before any query', async () => {
    const { client, requestedTags } = await harness();
    const session = await openSession(client, wallet());

    await expect(client.listMyOrders({ bearerToken: session.token, limit: 0 })).rejects.toThrow();
    await expect(client.listMyOrders({ bearerToken: session.token, limit: 1_000 })).rejects.toThrow();
    expect(requestedTags).toEqual([]);

    const honoured = await client.listMyOrders({ bearerToken: session.token, limit: 1 });
    expect(honoured).toHaveLength(1);
  });

  it('never returns order contents or envelope material', async () => {
    const { client } = await harness();
    const session = await openSession(client, wallet());

    const response = await fetch(`${started?.address ?? ''}/v1/orders`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const body = await response.text();

    for (const forbidden of ['ciphertext', 'clientSignature', 'ephemeralPublicKey', 'salt', 'nonce', 'traderTagHash']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
