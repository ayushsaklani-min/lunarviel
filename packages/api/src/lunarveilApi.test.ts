import { describe, expect, it } from 'vitest';

import {
  type MatcherEncryptionPublicKeyV1,
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
} from '@lunarveil/crypto';
import {
  type AuthenticatedOrderSubmissionServiceV1,
  InMemorySessionChallengeService,
} from '@lunarveil/matcher';

import { createRedactedLoggerV1, type EmittedLogEventV1 } from './logging.js';
import { buildLunarveilApi } from './lunarveilApi.js';

const nowMs = 1_800_000_000_000n;

const matcherKey: MatcherEncryptionPublicKeyV1 = {
  version: 1,
  keyId: 'matcher-api-test',
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
  publicKey: 'A'.repeat(43),
  activeFromMs: nowMs - 1n,
  expiresAtMs: nowMs + 1_000n,
};

function baseDependencies(orders: Pick<AuthenticatedOrderSubmissionServiceV1, 'submit'>) {
  return {
    sessions: sessions(), orders, matcherKeys: { activePublicKey: () => matcherKey }, nowMs: () => nowMs,
    markets: {
      async listMarkets() { return [{ id: 'market-1', marketKey: 'NIGHT-USDCX', baseAssetId: 'NIGHT', quoteAssetId: 'USDCX', tickSizeAtomic: '1', lotSizeAtomic: '1', epochDurationSeconds: 60, maxOrdersPerEpoch: 4, minBatchPrivacy: 2, matchingRuleVersion: 'v1', status: 'ACTIVE' as const }]; },
      async currentEpoch(marketId: string) { return marketId === 'market-1' ? { id: 'epoch-1', marketId, sequence: '7', state: 'OPEN' as const, orderCount: 1, maxOrders: 4, scheduledCloseAtMs: nowMs.toString(), ruleVersion: 'v1', configHash: 'aa'.repeat(32) } : undefined; },
    },
    systemStatus: {
      async read() { return { state: 'DEGRADED' as const, components: [{ name: 'DATABASE' as const, state: 'UNAVAILABLE' as const }, { name: 'MATCHER' as const, state: 'READY' as const }] }; },
    },
  };
}

async function validEnvelope() {
  const key = await generateMatcherDecryptionKeyV1({
    keyId: 'matcher-api-test', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 1_000n,
  });
  return sealOrderEnvelopeV1({
    header: {
      clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
      marketId: 'NIGHT-USDCX', epochId: 'epoch-7', commitment: '11'.repeat(32), traderTagHash: '22'.repeat(32),
    },
    matcherKey: matcherPublicKeyV1(key),
    plaintext: new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}'),
    nowMs,
  });
}

function sessions() {
  return new InMemorySessionChallengeService({
    nowMs: () => nowMs,
    challengeLifetimeMs: 100n,
    sessionLifetimeMs: 500n,
    verifier: { async verify({ signature }) { return signature.length === 1 && signature[0] === 7; } },
    newId: () => 'challenge-1',
    random: (length) => new Uint8Array(length).fill(7),
  });
}

describe('buildLunarveilApi', () => {
  it('serves health and only public active matcher-key metadata', async () => {
    const app = buildLunarveilApi(baseDependencies({ async submit() { throw new Error('not reached'); } }));
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready' });
      expect(response.headers).toMatchObject({
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      });
      const key = await app.inject({ method: 'GET', url: '/v1/matcher-key' });
      expect(key.statusCode).toBe(200);
      expect(key.json()).toEqual({
        version: 1, keyId: 'matcher-api-test', algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
        publicKey: 'A'.repeat(43), activeFromMs: (nowMs - 1n).toString(), expiresAtMs: (nowMs + 1_000n).toString(),
      });
      const markets = await app.inject({ method: 'GET', url: '/v1/markets' });
      expect(markets.statusCode).toBe(200);
      expect(markets.json<{ markets: unknown[] }>().markets).toHaveLength(1);
      const epoch = await app.inject({ method: 'GET', url: '/v1/markets/market-1/epoch' });
      expect(epoch.json()).toMatchObject({ id: 'epoch-1', state: 'OPEN' });
      const status = await app.inject({ method: 'GET', url: '/v1/system/status' });
      expect(status.json()).toEqual({ state: 'DEGRADED', components: [{ name: 'DATABASE', state: 'UNAVAILABLE' }, { name: 'MATCHER', state: 'READY' }] });
      const readiness = await app.inject({ method: 'GET', url: '/readyz' });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ status: 'not_ready', code: 'DEPENDENCY_NOT_READY' });
    } finally {
      await app.close();
    }
  });

  it('creates a session and submits only encrypted order transport', async () => {
    const submitted: unknown[] = [];
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('not reached'); } }),
      orders: {
        async submit(input) {
          submitted.push(input);
          return {
            replayed: false,
            record: {
              id: 'order-1', clientRequestId: input.envelope.clientRequestId,
              marketId: input.envelope.marketId, epochId: input.envelope.epochId,
              commitment: input.envelope.commitment, state: 'PENDING_CHAIN' as const, createdAtMs: nowMs,
            },
          };
        },
      },
    });
    try {
      const challenge = await app.inject({
        method: 'POST', url: '/v1/sessions/challenges',
        payload: { domain: 'https://app.lunarveil.test', walletIdentity: 'wallet-public-key' },
      });
      expect(challenge.statusCode).toBe(200);
      const session = await app.inject({
        method: 'POST', url: '/v1/sessions/verify',
        payload: { challengeId: challenge.json().id, signature: 'Bw' },
      });
      expect(session.statusCode).toBe(200);
      const token = session.json<{ token: string }>().token;
      const envelope = await validEnvelope();
      const order = await app.inject({
        method: 'POST', url: '/v1/orders', headers: { authorization: `Bearer ${token}` },
        payload: { envelope, clientSignature: 'Bw' },
      });

      expect(order.statusCode).toBe(200);
      expect(order.json()).toEqual({
        orderId: 'order-1', clientRequestId: envelope.clientRequestId,
        state: 'PENDING_CHAIN', replayed: false, createdAtMs: nowMs.toString(),
      });
      expect(JSON.stringify(order.json())).not.toContain('quantityLots');
      expect(submitted).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed requests and sanitizes unexpected backend failures', async () => {
    const app = buildLunarveilApi(baseDependencies({ async submit() { throw new Error('database connection string must not reach clients'); } }));
    try {
      const invalid = await app.inject({ method: 'POST', url: '/v1/sessions/challenges', payload: { domain: 'x' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'REQUEST_REJECTED', code: 'VALIDATION_FAILED' });

      const envelope = await validEnvelope();
      const failure = await app.inject({
        method: 'POST', url: '/v1/orders', headers: { authorization: 'Bearer test-token' },
        payload: { envelope, clientSignature: 'Bw' },
      });
      expect(failure.statusCode).toBe(503);
      expect(failure.json()).toEqual({ error: 'SERVICE_UNAVAILABLE', code: 'ORDER_SERVICE_UNAVAILABLE' });
      expect(failure.body).not.toContain('connection string');
    } finally {
      await app.close();
    }
  });

  it('delivers encrypted allocations and accepts only encrypted firm-up bytes', async () => {
    let received: Uint8Array | undefined;
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('not reached'); } }),
      allocations: {
        async get(input) {
          expect(input).toEqual({ epochId: 'epoch-1', bearerToken: 'test-token' });
          return {
            envelope: {
              version: 1, allocationId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903', batchId: 'batch-1',
              traderTagHash: '22'.repeat(32), encryptionKeyId: 'recipient-1', algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
              ephemeralPublicKey: 'A'.repeat(43), salt: 'B'.repeat(22), nonce: 'C'.repeat(16), ciphertext: 'D'.repeat(22),
            },
            solutionCommitment: 'aa'.repeat(32), firmDeadlineMs: nowMs.toString(),
          };
        },
        async receiveFirmup(input) {
          expect(input.epochId).toBe('epoch-1');
          expect(input.allocationId).toBe('allocation-1');
          expect(input.clientRequestId).toBe('8d246316-9c6b-4c9f-a7f5-b5d4ae874903');
          expect(input.bearerToken).toBe('test-token');
          received = new Uint8Array(input.ciphertextPayload);
          return { state: 'RECEIVED' as const, replayed: false };
        },
      },
    });
    try {
      const allocation = await app.inject({ method: 'GET', url: '/v1/epochs/epoch-1/allocation', headers: { authorization: 'Bearer test-token' } });
      expect(allocation.statusCode).toBe(200);
      expect(allocation.json()).toMatchObject({ solutionCommitment: 'aa'.repeat(32) });
      expect(JSON.stringify(allocation.json())).not.toContain('quantityLots');
      const firmup = await app.inject({
        method: 'POST', url: '/v1/epochs/epoch-1/firmup', headers: { authorization: 'Bearer test-token' },
        payload: { allocationId: 'allocation-1', clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903', ciphertextPayload: 'AQID' },
      });
      expect(firmup.statusCode).toBe(200);
      expect(firmup.json()).toEqual({ state: 'RECEIVED', replayed: false });
      expect(received).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      await app.close();
    }
  });

  it('enforces an injected browser-origin allowlist without reading request bodies', async () => {
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('not reached'); } }),
      allowedOrigins: ['https://app.example'],
    });
    try {
      const allowed = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://app.example' } });
      expect(allowed.statusCode).toBe(200);
      const rejected = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toEqual({ error: 'REQUEST_REJECTED', code: 'ORIGIN_NOT_ALLOWED' });
    } finally {
      await app.close();
    }
  });

  const allReady = [
    { name: 'DATABASE' as const, state: 'READY' as const },
    { name: 'MATCHER' as const, state: 'READY' as const },
    { name: 'CHAIN_SOURCE' as const, state: 'READY' as const },
    { name: 'PROVER' as const, state: 'READY' as const },
    { name: 'KMS' as const, state: 'READY' as const },
  ];

  function withStatus(read: () => Promise<unknown>) {
    return buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('not reached'); } }),
      systemStatus: { read } as never,
    });
  }

  it('returns ready only when every dependency is present and ready', async () => {
    const app = withStatus(async () => ({ state: 'READY' as const, components: allReady }));
    try {
      const readiness = await app.inject({ method: 'GET', url: '/readyz' });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json()).toEqual({ status: 'ready' });
    } finally {
      await app.close();
    }
  });

  it('refuses readiness for incomplete, empty, unready or duplicated dependency sets', async () => {
    const cases: { readonly components: unknown; readonly code: string }[] = [
      { components: allReady.slice(0, 4), code: 'DEPENDENCY_NOT_READY' },
      { components: [], code: 'DEPENDENCY_NOT_READY' },
      { components: [...allReady.slice(0, 4), { name: 'KMS', state: 'DEGRADED' }], code: 'DEPENDENCY_NOT_READY' },
      { components: [...allReady.slice(0, 4), { name: 'DATABASE', state: 'READY' }], code: 'STATUS_UNAVAILABLE' },
      { components: [...allReady, { name: 'KMS', state: 'READY' }], code: 'STATUS_UNAVAILABLE' },
      { components: [...allReady.slice(0, 4), { name: 'ORACLE', state: 'READY' }], code: 'STATUS_UNAVAILABLE' },
      { components: [...allReady.slice(0, 4), { name: 'KMS', state: 'ONLINE' }], code: 'STATUS_UNAVAILABLE' },
      { components: undefined, code: 'STATUS_UNAVAILABLE' },
    ];
    for (const { components, code } of cases) {
      const app = withStatus(async () => ({ state: 'READY' as const, components }));
      try {
        const readiness = await app.inject({ method: 'GET', url: '/readyz' });
        expect(readiness.statusCode).toBe(503);
        expect(readiness.json()).toEqual({ status: 'not_ready', code });
      } finally {
        await app.close();
      }
    }
  });

  it('downgrades a claimed ready state and redacts extra status fields', async () => {
    const app = withStatus(async () => ({
      state: 'READY' as const,
      hostname: 'matcher-primary.internal',
      components: [
        { name: 'DATABASE' as const, state: 'READY' as const, dsn: 'postgres://user:pw@host/db' },
        { name: 'MATCHER' as const, state: 'UNAVAILABLE' as const },
      ],
    }));
    try {
      const status = await app.inject({ method: 'GET', url: '/v1/system/status' });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        state: 'DEGRADED',
        components: [{ name: 'DATABASE', state: 'READY' }, { name: 'MATCHER', state: 'UNAVAILABLE' }],
      });
      expect(status.body).not.toContain('postgres://');
      expect(status.body).not.toContain('matcher-primary');
    } finally {
      await app.close();
    }
  });

  it('answers a valid CORS preflight and refuses unknown or malformed ones', async () => {
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('not reached'); } }),
      allowedOrigins: ['https://app.example'],
    });
    try {
      const preflight = await app.inject({
        method: 'OPTIONS', url: '/v1/orders',
        headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://app.example');
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
      const allowedMethods = String(preflight.headers['access-control-allow-methods']).split(', ').sort();
      expect(allowedMethods).toEqual(['GET', 'HEAD', 'POST']);

      const unknownOrigin = await app.inject({
        method: 'OPTIONS', url: '/v1/orders',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(unknownOrigin.statusCode).toBe(403);
      expect(unknownOrigin.headers['access-control-allow-origin']).toBeUndefined();

      const malformed = await app.inject({
        method: 'OPTIONS', url: '/v1/orders', headers: { origin: 'https://app.example' },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.headers['access-control-allow-methods']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns allowlisted CORS headers on successful and rejected responses', async () => {
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('not reached'); } }),
      allowedOrigins: ['https://app.example'],
    });
    try {
      const success = await app.inject({
        method: 'GET', url: '/v1/markets', headers: { origin: 'https://app.example' },
      });
      expect(success.statusCode).toBe(200);
      expect(success.headers['access-control-allow-origin']).toBe('https://app.example');
      expect(success.headers['access-control-expose-headers']).toBe('retry-after');

      const notFound = await app.inject({
        method: 'GET', url: '/v1/does-not-exist', headers: { origin: 'https://app.example' },
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.headers['access-control-allow-origin']).toBe('https://app.example');

      const noOrigin = await app.inject({ method: 'GET', url: '/v1/markets' });
      expect(noOrigin.statusCode).toBe(200);
      expect(noOrigin.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects a body above the configured limit before invoking submission', async () => {
    let submitted = false;
    const app = buildLunarveilApi(
      baseDependencies({ async submit() { submitted = true; throw new Error('not reached'); } }),
      { bodyLimitBytes: 512 },
    );
    try {
      const oversized = await app.inject({
        method: 'POST', url: '/v1/orders', headers: { authorization: 'Bearer test-token' },
        payload: { clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903', envelope: 'A'.repeat(2048) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json()).toEqual({ error: 'REQUEST_REJECTED', code: 'REQUEST_TOO_LARGE' });
      expect(submitted).toBe(false);
    } finally {
      await app.close();
    }
  });
  it('awaits an asynchronous shared limiter before routing', async () => {
    const keys: string[] = [];
    let submitted = false;
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { submitted = true; throw new Error('not reached'); } }),
      rateLimiter: {
        async consume(key: string) {
          keys.push(key);
          await Promise.resolve();
          return keys.length > 1 ? { allowed: false, retryAfterSeconds: 42 } : { allowed: true, retryAfterSeconds: 0 };
        },
      },
    });
    try {
      const first = await app.inject({ method: 'GET', url: '/healthz' });
      expect(first.statusCode).toBe(200);

      const limited = await app.inject({
        method: 'POST', url: '/v1/orders', headers: { authorization: 'Bearer test-token' },
        payload: { clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903', envelope: 'AQID' },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toEqual({ error: 'REQUEST_REJECTED', code: 'RATE_LIMITED' });
      expect(limited.headers['retry-after']).toBe('42');
      expect(submitted).toBe(false);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toContain('/v1/orders');
    } finally {
      await app.close();
    }
  });
  it('logs route patterns and hashed clients without any request material', async () => {
    const events: EmittedLogEventV1[] = [];
    const logger = createRedactedLoggerV1({
      sink: event => { events.push(event); },
      nowMs: () => nowMs,
      clientHashKey: new Uint8Array(32).fill(3),
    });
    const sealed = await validEnvelope();
    const app = buildLunarveilApi({
      ...baseDependencies({ async submit() { throw new Error('database password=hunter2 at 10.0.0.4'); } }),
      logger,
    });
    try {
      await app.inject({ method: 'GET', url: '/v1/markets/market-1/epoch' });
      const failed = await app.inject({
        method: 'POST', url: '/v1/orders', headers: { authorization: 'Bearer super-secret-token' },
        payload: { envelope: sealed, clientSignature: 'Bw' },
      });
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ level: 'info', event: 'http.request', route: '/v1/markets/:marketId/epoch', method: 'GET', statusCode: 200 });
      expect(events[1]).toMatchObject({ level: 'error', route: '/v1/orders', method: 'POST' });
      expect(events[1]!.statusCode).toBe(failed.statusCode);

      // The populated identifier, the bearer token, the ciphertext and the
      // internal failure message must all be absent from every emitted line.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('market-1');
      expect(serialized).not.toContain('super-secret-token');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('10.0.0.4');
      expect(serialized).not.toContain(sealed.ciphertext);
      expect(serialized).not.toContain('8d246316');
      for (const event of events) {
        expect(Object.keys(event).every(field => [
          'timestampMs', 'service', 'level', 'event', 'route', 'method', 'statusCode', 'durationMs', 'code', 'requestId', 'clientHash',
        ].includes(field))).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});

describe('public epoch results', () => {
  const noOrders = { async submit() { throw new Error('unused'); } };
  const finalized = {
    epochId: 'epoch-6', sequence: '6', state: 'FINALIZED' as const, closedAtMs: nowMs.toString(),
    orderCount: 3, matchedOrderCount: 2, clearingPriceTicks: '100', totalVolumeLots: '6',
    rejectedSolutionCount: 1, proofReference: 'simulated:ab', settlementReference: 'simulated:cd', simulated: true,
  };

  it('is not routed when no results source is configured', async () => {
    const app = buildLunarveilApi(baseDependencies(noOrders));
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/markets/market-1/results' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns only the declared public aggregates', async () => {
    const requested: [string, number][] = [];
    const app = buildLunarveilApi({
      ...baseDependencies(noOrders),
      epochResults: {
        async recentResults(marketId: string, limit: number) {
          requested.push([marketId, limit]);
          // A field a future repository might add must not leak through.
          return [{ ...finalized, traderTagHash: 'aa'.repeat(32) } as typeof finalized];
        },
      },
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/markets/market-1/results?limit=5' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ results: [finalized] });
      expect(requested).toEqual([['market-1', 5]]);
    } finally {
      await app.close();
    }
  });

  it('rejects an out-of-range limit and hides repository failures', async () => {
    const app = buildLunarveilApi({
      ...baseDependencies(noOrders),
      epochResults: { async recentResults() { throw new Error('connection string postgres://secret'); } },
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/markets/market-1/results?limit=500' })).statusCode).toBe(400);
      const failed = await app.inject({ method: 'GET', url: '/v1/markets/market-1/results' });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain('secret');
    } finally {
      await app.close();
    }
  });
});
