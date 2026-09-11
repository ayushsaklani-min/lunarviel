import { afterEach, describe, expect, it } from 'vitest';

import { LunarveilApiClientV1, isLunarveilApiError, type LunarveilApiError } from '@lunarveil/api-client';
import { InMemorySessionChallengeService } from '@lunarveil/matcher';

import type { MatcherEncryptionPublicKeyV1 } from '@lunarveil/crypto';
import type { LunarveilApiDependencies, PublicEpochV1, PublicMarketV1 } from './lunarveilApi.js';
import type { LunarveilRuntimeConfigV1 } from './runtimeConfig.js';
import { startLunarveilApiV1, type StartedLunarveilApiV1 } from './server.js';

/**
 * The frontend/backend contract test.
 *
 * It starts the real Fastify listener on a real port and drives it with the
 * real browser client (`@lunarveil/api-client`) over real HTTP. Wire-format
 * drift between the two — a renamed field, a number where a decimal string
 * belongs, an error envelope the client cannot read — fails here rather than
 * in a browser. No database, no chain and no wallet is involved.
 */

const nowMs = 1_800_000_000_000n;

const matcherKey: MatcherEncryptionPublicKeyV1 = {
  version: 1,
  keyId: 'matcher-contract-test',
  algorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
  publicKey: 'A'.repeat(43),
  activeFromMs: nowMs - 1n,
  expiresAtMs: nowMs + 1_000n,
};

const market: PublicMarketV1 = {
  id: 'market-1',
  marketKey: 'NIGHT-USDCX',
  baseAssetId: 'night',
  quoteAssetId: 'usdcx',
  tickSizeAtomic: '1',
  lotSizeAtomic: '100000',
  epochDurationSeconds: 60,
  maxOrdersPerEpoch: 4,
  minBatchPrivacy: 2,
  matchingRuleVersion: 'rules-v1',
  status: 'ACTIVE',
};

const epoch: PublicEpochV1 = {
  id: 'epoch-1',
  marketId: 'market-1',
  sequence: '7',
  state: 'OPEN',
  orderCount: 3,
  maxOrders: 4,
  scheduledCloseAtMs: '1800000060000',
  ruleVersion: 'rules-v1',
  configHash: 'ab'.repeat(32),
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
      async listMarkets() { return [market]; },
      async currentEpoch(marketId: string) { return marketId === market.id ? epoch : undefined; },
    },
    systemStatus: {
      async read() {
        return {
          state: 'DEGRADED' as const,
          components: [
            { name: 'DATABASE' as const, state: 'READY' as const },
            { name: 'CHAIN_SOURCE' as const, state: 'DEGRADED' as const },
          ],
        };
      },
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

async function client(overrides: Partial<LunarveilApiDependencies> = {}): Promise<LunarveilApiClientV1> {
  started = await startLunarveilApiV1(dependencies(overrides), config());
  return new LunarveilApiClientV1({ baseUrl: started.address });
}

describe('browser client against the real API listener', () => {
  it('reads the market catalog the server actually serves', async () => {
    const api = await client();
    expect(await api.listMarkets()).toEqual([market]);
  });

  it('reads a market epoch, preserving decimal strings across the wire', async () => {
    const api = await client();
    const value = await api.getMarketEpoch('market-1');

    expect(value).toEqual(epoch);
    // The wire keeps these as strings, so the browser never rounds them.
    expect(typeof value.sequence).toBe('string');
    expect(BigInt(value.scheduledCloseAtMs)).toBe(1_800_000_060_000n);
  });

  it('reads the sanitized dependency status', async () => {
    const api = await client();
    const status = await api.getSystemStatus();
    expect(status.state).toBe('DEGRADED');
    expect(status.components).toEqual([
      { name: 'DATABASE', state: 'READY' },
      { name: 'CHAIN_SOURCE', state: 'DEGRADED' },
    ]);
  });

  it('turns the server 404 envelope into a sanitized client error', async () => {
    const api = await client();
    const error = await api.getMarketEpoch('market-absent').catch((thrown: unknown) => thrown);

    expect(isLunarveilApiError(error)).toBe(true);
    expect((error as LunarveilApiError).code).toBe('REQUEST_REJECTED');
    expect((error as LunarveilApiError).serverCode).toBe('MARKET_OR_EPOCH_NOT_FOUND');
  });

  it('turns a dependency failure into SERVICE_UNAVAILABLE with no server message', async () => {
    const api = await client({
      markets: {
        async listMarkets(): Promise<readonly PublicMarketV1[]> {
          throw new Error('connection to server at "10.0.0.1", user "lunarveil" failed');
        },
        async currentEpoch() { return undefined; },
      },
    });

    const error = await api.listMarkets().catch((thrown: unknown) => thrown);
    expect((error as LunarveilApiError).code).toBe('SERVICE_UNAVAILABLE');
    expect(String(error)).not.toContain('10.0.0.1');
    expect(String(error)).not.toContain('lunarveil');
  });

  it('is reachable from an allowlisted browser origin and refused from an unknown one', async () => {
    // The frontend and API are separate deployments, so the browser will send
    // an Origin header on every one of these reads.
    started = await startLunarveilApiV1(
      dependencies(),
      config({ allowedOrigins: ['https://app.lunarveil.test'] }),
    );

    const allowed = await fetch(`${started.address}/v1/markets`, {
      headers: { origin: 'https://app.lunarveil.test' },
    });
    expect(allowed.status).toBe(200);

    const refused = await fetch(`${started.address}/v1/markets`, {
      headers: { origin: 'https://attacker.test' },
    });
    expect(refused.status).toBe(403);
  });
  it('serves a browser when no origin allowlist is configured', async () => {
    // An empty allowlist means "no enforcement configured", not "allow
    // nothing". Passing it through unconditionally used to install the
    // enforcement hook with an empty allow-set, so every request carrying an
    // Origin header — that is, every browser request — was refused with 403,
    // while curl and these tests kept passing. See ADR-0040.
    started = await startLunarveilApiV1(dependencies(), config({ allowedOrigins: [] }));

    const response = await fetch(`${started.address}/v1/markets`, {
      headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(response.status).toBe(200);
  });

  it('answers a browser preflight from an allowlisted origin', async () => {
    started = await startLunarveilApiV1(
      dependencies(),
      config({ allowedOrigins: ['https://app.lunarveil.test'] }),
    );

    const preflight = await fetch(`${started.address}/v1/markets`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.lunarveil.test',
        'access-control-request-method': 'GET',
      },
    });
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.lunarveil.test');
  });
});
