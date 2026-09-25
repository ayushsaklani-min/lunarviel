import { describe, expect, it } from 'vitest';

import { LunarveilApiError } from './errors.js';
import { LunarveilApiClientV1 } from './lunarveilApiClient.js';

const BASE_URL = 'http://127.0.0.1:3001';

const market = {
  id: 'market-1',
  marketKey: 'NIGHT-USDCX',
  baseAssetId: 'night',
  quoteAssetId: 'usdcx',
  tickSizeAtomic: '1',
  lotSizeAtomic: '100',
  epochDurationSeconds: 60,
  maxOrdersPerEpoch: 4,
  minBatchPrivacy: 2,
  matchingRuleVersion: 'rules-v1',
  status: 'ACTIVE',
};

const epoch = {
  id: 'epoch-1',
  marketId: 'market-1',
  sequence: '7',
  state: 'OPEN',
  orderCount: 2,
  maxOrders: 4,
  scheduledCloseAtMs: '1800000060000',
  ruleVersion: 'rules-v1',
  configHash: 'ab'.repeat(32),
};

interface CallV1 { readonly url: string; readonly init: RequestInit }

function stub(payload: unknown, init: { status?: number } = {}): { calls: CallV1[]; fetchImpl: typeof fetch } {
  const calls: CallV1[] = [];
  const fetchImpl = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      async json() {
        if (payload === undefined) throw new Error('not json');
        return payload;
      },
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch, baseUrl = BASE_URL): LunarveilApiClientV1 {
  return new LunarveilApiClientV1({ baseUrl, fetchImpl });
}

describe('LunarveilApiClientV1 — base URL', () => {
  it('accepts an http or https origin and strips a trailing slash', async () => {
    const { calls, fetchImpl } = stub({ markets: [] });
    await client(fetchImpl, 'https://api.example.test/').listMarkets();
    expect(calls[0]?.url).toBe('https://api.example.test/v1/markets');
  });

  it('rejects a credentialed, query-bearing or non-http base URL', () => {
    for (const bad of [
      'https://user:secret@api.example.test',
      'https://api.example.test?token=abc',
      'https://api.example.test#fragment',
      'ftp://api.example.test',
      'not a url',
    ]) {
      expect(() => new LunarveilApiClientV1({ baseUrl: bad, fetchImpl: stub({}).fetchImpl }))
        .toThrow(new LunarveilApiError('INVALID_BASE_URL'));
    }
  });
});

describe('LunarveilApiClientV1 — reads', () => {
  it('lists markets and preserves atomic integers as decimal strings', async () => {
    const { fetchImpl } = stub({ markets: [market] });
    const markets = await client(fetchImpl).listMarkets();

    expect(markets).toEqual([market]);
    // Never parsed to number: that would reintroduce float error into market math.
    expect(typeof markets[0]?.tickSizeAtomic).toBe('string');
    expect(BigInt(markets[0]?.lotSizeAtomic ?? '0')).toBe(100n);
  });

  it('drops any field the server grows that this client has not reviewed', async () => {
    const { fetchImpl } = stub({
      markets: [{ ...market, secretOperatorNote: 'do not render me', feeBps: 25 }],
    });
    const markets = await client(fetchImpl).listMarkets();
    expect(Object.keys(markets[0] ?? {}).sort()).toEqual(Object.keys(market).sort());
  });

  it('reads a market epoch and sends no credential with the request', async () => {
    const { calls, fetchImpl } = stub(epoch);
    expect(await client(fetchImpl).getMarketEpoch('market-1')).toEqual(epoch);
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/markets/market-1/epoch`);
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(JSON.stringify(calls[0]?.init.headers)).not.toMatch(/authorization|cookie/iu);
  });

  it('reads sanitized dependency status', async () => {
    const { fetchImpl } = stub({
      state: 'DEGRADED',
      components: [{ name: 'DATABASE', state: 'READY' }, { name: 'CHAIN_SOURCE', state: 'DEGRADED' }],
    });
    const status = await client(fetchImpl).getSystemStatus();
    expect(status.state).toBe('DEGRADED');
    expect(status.components).toHaveLength(2);
  });

  it('rejects a malformed market id before any request is sent', async () => {
    const { calls, fetchImpl } = stub(epoch);
    await expect(client(fetchImpl).getMarketEpoch('-bad')).rejects.toThrow(new LunarveilApiError('INVALID_ARGUMENT'));
    await expect(client(fetchImpl).getMarketEpoch('a'.repeat(129))).rejects.toThrow(new LunarveilApiError('INVALID_ARGUMENT'));
    expect(calls).toEqual([]);
  });
});

describe('LunarveilApiClientV1 — failures are sanitized', () => {
  it('maps 503 to SERVICE_UNAVAILABLE and keeps only the allowlisted server code', async () => {
    const { fetchImpl } = stub({ error: 'SERVICE_UNAVAILABLE', code: 'DATABASE_UNAVAILABLE' }, { status: 503 });
    const error = await client(fetchImpl).listMarkets().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(LunarveilApiError);
    expect((error as LunarveilApiError).code).toBe('SERVICE_UNAVAILABLE');
    expect((error as LunarveilApiError).serverCode).toBe('DATABASE_UNAVAILABLE');
  });

  it('maps 4xx to REQUEST_REJECTED and 5xx to INTERNAL_ERROR', async () => {
    const rejected = await client(stub({ error: 'REQUEST_REJECTED', code: 'NOT_FOUND' }, { status: 404 }).fetchImpl)
      .getMarketEpoch('market-1').catch((thrown: unknown) => thrown);
    expect((rejected as LunarveilApiError).code).toBe('REQUEST_REJECTED');

    const internal = await client(stub({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 }).fetchImpl)
      .listMarkets().catch((thrown: unknown) => thrown);
    expect((internal as LunarveilApiError).code).toBe('INTERNAL_ERROR');
  });

  it('discards a server code that is not a machine code', async () => {
    // A body that smuggles prose (or worse) must never reach a UI label.
    const { fetchImpl } = stub(
      { error: 'REQUEST_REJECTED', code: 'connection to 10.0.0.1 as user lunarveil failed' },
      { status: 400 },
    );
    const error = await client(fetchImpl).listMarkets().catch((thrown: unknown) => thrown);
    expect((error as LunarveilApiError).serverCode).toBeUndefined();
  });

  it('never leaks the underlying transport error', async () => {
    const failing = (async () => { throw new Error(`connect ECONNREFUSED ${BASE_URL}/v1/markets`); }) as unknown as typeof fetch;
    const error = await client(failing).listMarkets().catch((thrown: unknown) => thrown);
    expect((error as LunarveilApiError).code).toBe('NETWORK_FAILURE');
    expect(String(error)).not.toContain('ECONNREFUSED');
  });

  it('rejects a response that is not valid JSON', async () => {
    const { fetchImpl } = stub(undefined);
    const error = await client(fetchImpl).listMarkets().catch((thrown: unknown) => thrown);
    expect((error as LunarveilApiError).code).toBe('MALFORMED_RESPONSE');
  });

  it('rejects a response whose shape or values are wrong', async () => {
    const cases: unknown[] = [
      { markets: 'nope' },
      { markets: [{ ...market, status: 'HALTED' }] },
      { markets: [{ ...market, tickSizeAtomic: '1.5' }] },
      { markets: [{ ...market, epochDurationSeconds: 0 }] },
      { markets: [{ ...market, id: '' }] },
      null,
    ];
    for (const payload of cases) {
      await expect(client(stub(payload).fetchImpl).listMarkets())
        .rejects.toThrow(new LunarveilApiError('MALFORMED_RESPONSE'));
    }
  });

  it('times out rather than hanging forever', async () => {
    const hanging = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
    })) as unknown as typeof fetch;
    const timed = new LunarveilApiClientV1({ baseUrl: BASE_URL, fetchImpl: hanging, timeoutMs: 20 });
    await expect(timed.listMarkets()).rejects.toThrow(new LunarveilApiError('TIMEOUT'));
  });
});

describe('LunarveilApiClientV1 — platform fetch binding', () => {
  it('calls the platform fetch bound to the global object', async () => {
    // A browser's fetch throws "Illegal invocation" when its `this` is not the
    // global. Storing it as a property and calling `this.fetchImpl(...)` does
    // precisely that, so the whole UI failed in a real browser while every
    // test passed. This stand-in reproduces that binding requirement.
    const strictFetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve({ ok: true, status: 200, async json() { return { markets: [] }; } });
    } as unknown as typeof fetch;

    const original = globalThis.fetch;
    globalThis.fetch = strictFetch;
    try {
      const api = new LunarveilApiClientV1({ baseUrl: BASE_URL });
      await expect(api.listMarkets()).resolves.toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('LunarveilApiClientV1 — epoch results', () => {
  const result = {
    epochId: 'epoch-6', sequence: '6', state: 'FINALIZED', closedAtMs: '1800000060000',
    orderCount: 3, matchedOrderCount: 2, clearingPriceTicks: '100', totalVolumeLots: '6',
    rejectedSolutionCount: 0, proofReference: 'simulated:ab', settlementReference: 'simulated:cd', simulated: true,
  };

  it('reads recent results and drops unreviewed fields', async () => {
    const { calls, fetchImpl } = stub({ results: [{ ...result, traderTagHash: 'aa'.repeat(32) }] });
    expect(await client(fetchImpl).listEpochResults('market-1', { limit: 5 })).toEqual([result]);
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/markets/market-1/results?limit=5`);
  });

  it('keeps an untraded epoch without a clearing price', async () => {
    const { clearingPriceTicks: _omitted, ...untraded } = { ...result, totalVolumeLots: '0', matchedOrderCount: 0 };
    const { fetchImpl } = stub({ results: [untraded] });
    const [parsed] = await client(fetchImpl).listEpochResults('market-1');
    expect(parsed?.clearingPriceTicks).toBeUndefined();
  });

  it('rejects malformed results rather than rendering them', async () => {
    const { fetchImpl } = stub({ results: [{ ...result, clearingPriceTicks: '100.5' }] });
    await expect(client(fetchImpl).listEpochResults('market-1')).rejects.toThrow(new LunarveilApiError('MALFORMED_RESPONSE'));
    const missingFlag = stub({ results: [{ ...result, simulated: 'yes' }] });
    await expect(client(missingFlag.fetchImpl).listEpochResults('market-1')).rejects.toThrow(new LunarveilApiError('MALFORMED_RESPONSE'));
  });
});
