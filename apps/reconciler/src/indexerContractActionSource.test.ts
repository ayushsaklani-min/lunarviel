import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseReconcilerConfigV1 } from './config.js';
import { createIndexerContractActionSourceV1 } from './indexerContractActionSource.js';

const config = parseReconcilerConfigV1({
  LUNARVEIL_CHAIN_NETWORK: 'preview',
  LUNARVEIL_INDEXER_URL: 'https://indexer.example.invalid/api/v4/graphql',
  LUNARVEIL_INDEXER_WS_URL: 'wss://indexer.example.invalid/api/v4/graphql/ws',
});

const ADDRESS = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';
const TX_HASH = 'd8c46ec045fffdbdf85c517263d5f78b0b92350e4910e97ed784431f5fb08414';

interface CapturedRequestV1 { readonly url: string; readonly body: { query: string; variables?: Record<string, unknown> } }

function stubFetch(payload: unknown, init: { status?: number } = {}): CapturedRequestV1[] {
  const captured: CapturedRequestV1[] = [];
  vi.stubGlobal('fetch', async (url: string, request: { body: string }) => {
    captured.push({ url, body: JSON.parse(request.body) as CapturedRequestV1['body'] });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      async json() { return payload; },
    };
  });
  return captured;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('createIndexerContractActionSourceV1', () => {
  it('reads the latest action with its correlated transaction hash and block height', async () => {
    const captured = stubFetch({
      data: {
        contractAction: {
          address: ADDRESS.toUpperCase(),
          state: 'AABB',
          transaction: { hash: TX_HASH, block: { height: 730_027 } },
        },
      },
    });

    const source = createIndexerContractActionSourceV1(config);
    expect(await source.readLatestAction({ address: ADDRESS })).toEqual({
      address: ADDRESS,
      stateHex: 'aabb',
      txId: TX_HASH,
      blockHeight: 730_027n,
    });

    const request = captured[0];
    expect(request?.url).toBe(config.indexerUrl);
    expect(request?.body.variables).toEqual({ address: ADDRESS });
    expect(request?.body.query).toContain('contractAction(address: $address)');
  });

  it('reads an action at a block offset using the documented offset shape', async () => {
    const captured = stubFetch({
      data: {
        contractAction: {
          address: ADDRESS,
          state: 'aabb',
          transaction: { hash: TX_HASH, block: { height: 730_000 } },
        },
      },
    });

    const source = createIndexerContractActionSourceV1(config);
    const action = await source.readActionAtHeight({ address: ADDRESS, blockHeight: 730_010n });
    expect(action?.blockHeight).toBe(730_000n);
    expect(captured[0]?.body.variables).toEqual({ address: ADDRESS, height: 730_010 });
    expect(captured[0]?.body.query).toContain('offset: { blockOffset: { height: $height } }');
  });

  it('reports undefined only when the indexer positively returns no action', async () => {
    stubFetch({ data: { contractAction: null } });
    const source = createIndexerContractActionSourceV1(config);
    expect(await source.readActionAtHeight({ address: ADDRESS, blockHeight: 1n })).toBeUndefined();
  });

  it('throws — never reports absence — on a GraphQL error, HTTP error or malformed action', async () => {
    stubFetch({ errors: [{ message: 'boom' }] });
    await expect(createIndexerContractActionSourceV1(config).readLatestAction({ address: ADDRESS }))
      .rejects.toThrow('INDEXER_CONTRACT_ACTION_GRAPHQL_ERROR');

    stubFetch({ data: { contractAction: null } }, { status: 502 });
    await expect(createIndexerContractActionSourceV1(config).readLatestAction({ address: ADDRESS }))
      .rejects.toThrow('INDEXER_CONTRACT_ACTION_HTTP_502');

    stubFetch({ data: { contractAction: { address: ADDRESS, state: 'aabb', transaction: null } } });
    await expect(createIndexerContractActionSourceV1(config).readLatestAction({ address: ADDRESS }))
      .rejects.toThrow('INDEXER_CONTRACT_ACTION_MALFORMED');

    stubFetch({ data: null });
    await expect(createIndexerContractActionSourceV1(config).readLatestAction({ address: ADDRESS }))
      .rejects.toThrow('INDEXER_CONTRACT_ACTION_MALFORMED');
  });

  it('rejects a height the GraphQL Int offset cannot represent', async () => {
    const captured = stubFetch({ data: { contractAction: null } });
    await expect(createIndexerContractActionSourceV1(config)
      .readActionAtHeight({ address: ADDRESS, blockHeight: 2_147_483_648n }))
      .rejects.toThrow('INDEXER_CONTRACT_ACTION_HEIGHT_OUT_OF_RANGE');
    expect(captured).toEqual([]);
  });

  it('sends no order, commitment or credential data to the indexer', async () => {
    const captured = stubFetch({ data: { contractAction: null } });
    await createIndexerContractActionSourceV1(config).readActionAtHeight({ address: ADDRESS, blockHeight: 10n });
    const serialized = JSON.stringify(captured);
    // Only the public contract address and a block height ever leave here.
    expect(Object.keys(captured[0]?.body.variables ?? {}).sort()).toEqual(['address', 'height']);
    expect(serialized).not.toMatch(/commitment|ciphertext|seed|password|order/iu);
  });
});
