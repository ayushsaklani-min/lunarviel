import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import { MarketContractRegistryDbError, PostgresMarketContractRegistryV1 } from './marketContractRegistry.js';

const ADDRESS = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';

function pool(rows: readonly Record<string, unknown>[], capture?: { text?: string; values?: readonly unknown[] }): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query(text: string, values: readonly unknown[] = []) {
          if (capture !== undefined) { capture.text = text; capture.values = values; }
          return { rows: rows as never };
        },
        release() { /* pooled */ },
      };
    },
  };
}

function failingPool(): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query() { throw new Error('connection to server at "10.0.0.1", user "lunarveil" failed'); },
        release() { /* pooled */ },
      };
    },
  };
}

describe('PostgresMarketContractRegistryV1', () => {
  it('resolves a market to its normalized contract address with a parameterized query', async () => {
    const capture: { text?: string; values?: readonly unknown[] } = {};
    const registry = new PostgresMarketContractRegistryV1(
      pool([{ marketContractAddress: ADDRESS.toUpperCase() }], capture),
    );
    expect(await registry.resolveContractAddress('market-1')).toBe(ADDRESS);
    expect(capture.values).toEqual(['market-1']);
    expect(capture.text).toContain('$1');
    // Public market metadata only.
    expect(capture.text).not.toMatch(/ciphertext|clientSignature|privateKeyRef|traderTagHash/u);
  });

  it('returns undefined for a market that has no row', async () => {
    const registry = new PostgresMarketContractRegistryV1(pool([]));
    expect(await registry.resolveContractAddress('market-1')).toBeUndefined();
  });

  it('fails closed on a malformed stored address instead of returning undefined', async () => {
    const registry = new PostgresMarketContractRegistryV1(pool([{ marketContractAddress: 'not-hex' }]));
    await expect(registry.resolveContractAddress('market-1'))
      .rejects.toThrow(new MarketContractRegistryDbError('INVALID_ROW'));

    const missing = new PostgresMarketContractRegistryV1(pool([{ marketContractAddress: null }]));
    await expect(missing.resolveContractAddress('market-1'))
      .rejects.toThrow(new MarketContractRegistryDbError('INVALID_ROW'));
  });

  it('rejects a malformed market id before querying', async () => {
    const registry = new PostgresMarketContractRegistryV1(pool([{ marketContractAddress: ADDRESS }]));
    await expect(registry.resolveContractAddress('-bad'))
      .rejects.toThrow(new MarketContractRegistryDbError('INVALID_MARKET_ID'));
    await expect(registry.resolveContractAddress('a'.repeat(129)))
      .rejects.toThrow(new MarketContractRegistryDbError('INVALID_MARKET_ID'));
  });

  it('never leaks the underlying database error message', async () => {
    const registry = new PostgresMarketContractRegistryV1(failingPool());
    await expect(registry.resolveContractAddress('market-1'))
      .rejects.toThrow(new MarketContractRegistryDbError('DATABASE_FAILURE'));
  });
});
