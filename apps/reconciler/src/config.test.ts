import { describe, expect, it } from 'vitest';

import { parseReconcilerConfigV1 } from './config.js';

const base = {
  LUNARVEIL_CHAIN_NETWORK: 'preview',
  LUNARVEIL_INDEXER_URL: 'https://indexer.preview.midnight.network/api/v4/graphql',
  LUNARVEIL_INDEXER_WS_URL: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
};

describe('parseReconcilerConfigV1', () => {
  it('applies documented defaults', () => {
    expect(parseReconcilerConfigV1(base)).toEqual({
      network: 'preview',
      indexerUrl: base.LUNARVEIL_INDEXER_URL,
      indexerWsUrl: base.LUNARVEIL_INDEXER_WS_URL,
      confirmationDepth: 12,
      requiredMatchingSources: 1,
      intervalMs: 30_000,
      batchSize: 100,
      reorgLookbackMs: 3_600_000,
    });
  });

  it('accepts explicit overrides', () => {
    const config = parseReconcilerConfigV1({
      ...base,
      LUNARVEIL_CHAIN_CONFIRMATION_DEPTH: '24',
      LUNARVEIL_CHAIN_REQUIRED_SOURCES: '2',
      LUNARVEIL_RECONCILER_INTERVAL_MS: '5000',
      LUNARVEIL_RECONCILER_BATCH_SIZE: '10',
      LUNARVEIL_REORG_RECHECK_LOOKBACK_MS: '600000',
    });
    expect(config).toMatchObject({
      confirmationDepth: 24, requiredMatchingSources: 2, intervalMs: 5_000, batchSize: 10, reorgLookbackMs: 600_000,
    });
  });

  it('fails closed on malformed values instead of silently defaulting', () => {
    for (const override of [
      { LUNARVEIL_CHAIN_NETWORK: 'mainnet' },
      { LUNARVEIL_CHAIN_NETWORK: '' },
      { LUNARVEIL_INDEXER_URL: 'http://insecure.example/graphql' },
      { LUNARVEIL_INDEXER_URL: 'not-a-url' },
      { LUNARVEIL_INDEXER_WS_URL: 'https://wrong-scheme.example' },
      { LUNARVEIL_CHAIN_CONFIRMATION_DEPTH: '-1' },
      { LUNARVEIL_CHAIN_CONFIRMATION_DEPTH: '0' },
      { LUNARVEIL_CHAIN_CONFIRMATION_DEPTH: 'twelve' },
      { LUNARVEIL_CHAIN_REQUIRED_SOURCES: '0' },
      { LUNARVEIL_RECONCILER_INTERVAL_MS: '0' },
      { LUNARVEIL_RECONCILER_BATCH_SIZE: '1001' },
      { LUNARVEIL_REORG_RECHECK_LOOKBACK_MS: '0' },
    ]) {
      expect(() => parseReconcilerConfigV1({ ...base, ...override })).toThrow();
    }
  });

  it('requires the indexer URLs rather than assuming a network default', () => {
    expect(() => parseReconcilerConfigV1({ LUNARVEIL_CHAIN_NETWORK: 'preview' })).toThrow();
  });
});
