import { afterEach, describe, expect, it } from 'vitest';

import { InMemorySessionChallengeService } from '@lunarveil/matcher';

import type { MatcherEncryptionPublicKeyV1 } from '@lunarveil/crypto';
import type { LunarveilApiDependencies } from './lunarveilApi.js';
import { InMemoryRateLimiterV1, type LunarveilRuntimeConfigV1 } from './runtimeConfig.js';
import { startLunarveilApiV1, type StartedLunarveilApiV1 } from './server.js';

const nowMs = 1_800_000_000_000n;

const matcherKey: MatcherEncryptionPublicKeyV1 = {
  version: 1,
  keyId: 'matcher-listener-test',
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
  publicKey: 'A'.repeat(43),
  activeFromMs: nowMs - 1n,
  expiresAtMs: nowMs + 1_000n,
};

function dependencies(overrides: Partial<LunarveilApiDependencies> = {}): LunarveilApiDependencies {
  return {
    nowMs: () => nowMs,
    matcherKeys: { activePublicKey: () => matcherKey },
    sessions: new InMemorySessionChallengeService({
      nowMs: () => nowMs,
      challengeLifetimeMs: 100n,
      sessionLifetimeMs: 500n,
      verifier: { async verify() { return false; } },
    }),
    orders: { async submit() { throw new Error('not reached'); } },
    markets: {
      async listMarkets() { return []; },
      async currentEpoch() { return undefined; },
    },
    systemStatus: {
      async read() { return { state: 'DEGRADED' as const, components: [{ name: 'DATABASE' as const, state: 'UNAVAILABLE' as const }] }; },
    },
    ...overrides,
  } as LunarveilApiDependencies;
}

function config(overrides: Partial<LunarveilRuntimeConfigV1> = {}): LunarveilRuntimeConfigV1 {
  return {
    environment: 'development',
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    allowedOrigins: [],
    trustProxy: false,
    ...overrides,
  };
}

let started: StartedLunarveilApiV1 | undefined;

afterEach(async () => {
  await started?.app.close();
  started = undefined;
});

describe('startLunarveilApiV1', () => {
  it('listens on an ephemeral port and serves liveness over real HTTP', async () => {
    started = await startLunarveilApiV1(dependencies(), config());
    expect(started.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(started.address).not.toMatch(/:0$/u);

    const response = await fetch(`${started.address}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('applies the configured body limit to a real request', async () => {
    let submitted = false;
    started = await startLunarveilApiV1(
      dependencies({ orders: { async submit() { submitted = true; throw new Error('not reached'); } } }),
      config({ bodyLimitBytes: 1_024 }),
    );

    const response = await fetch(`${started.address}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer listener-test' },
      body: JSON.stringify({ clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903', envelope: 'A'.repeat(4_096) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'REQUEST_REJECTED', code: 'REQUEST_TOO_LARGE' });
    expect(submitted).toBe(false);
  });

  it('enforces the configured origin allowlist over the listening socket', async () => {
    started = await startLunarveilApiV1(dependencies(), config({ allowedOrigins: ['https://app.example'] }));

    const allowed = await fetch(`${started.address}/healthz`, { headers: { origin: 'https://app.example' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');

    const rejected = await fetch(`${started.address}/healthz`, { headers: { origin: 'https://evil.example' } });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: 'REQUEST_REJECTED', code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('ignores forwarded client addresses unless proxy trust is configured', async () => {
    const untrusted = await startLunarveilApiV1(
      dependencies({ rateLimiter: new InMemoryRateLimiterV1(1) }),
      config({ trustProxy: false }),
    );
    try {
      const first = await fetch(`${untrusted.address}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.1' } });
      const second = await fetch(`${untrusted.address}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.2' } });
      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toMatch(/^\d+$/u);
    } finally {
      await untrusted.app.close();
    }

    started = await startLunarveilApiV1(
      dependencies({ rateLimiter: new InMemoryRateLimiterV1(1) }),
      config({ trustProxy: true }),
    );
    const firstHop = await fetch(`${started.address}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.1' } });
    const secondHop = await fetch(`${started.address}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.2' } });
    const repeatHop = await fetch(`${started.address}/healthz`, { headers: { 'x-forwarded-for': '203.0.113.1' } });
    expect(firstHop.status).toBe(200);
    expect(secondHop.status).toBe(200);
    expect(repeatHop.status).toBe(429);
  });

  it('closes the socket when the listener fails to bind', async () => {
    started = await startLunarveilApiV1(dependencies(), config());
    const port = Number(new URL(started.address).port);
    await expect(startLunarveilApiV1(dependencies(), config({ port }))).rejects.toThrow();

    const stillServing = await fetch(`${started.address}/healthz`);
    expect(stillServing.status).toBe(200);
  });
});
