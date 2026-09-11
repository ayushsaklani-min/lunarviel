import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

const MARKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTRACT_ADDRESS_PATTERN = /^(?:[0-9a-f]{2}){8,128}$/u;

export class MarketContractRegistryDbError extends Error {
  constructor(readonly code: 'INVALID_MARKET_ID' | 'INVALID_ROW' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'MarketContractRegistryDbError';
  }
}

interface MarketContractRow extends Record<string, unknown> {
  readonly marketContractAddress: string;
}

// Public market metadata only: no ciphertext, key reference or trader column.
const SELECT_CONTRACT_ADDRESS = `
  SELECT "marketContractAddress"
  FROM "Market"
  WHERE "id" = $1
  LIMIT 1
`;

/**
 * Resolves a market to its deployed contract address.
 *
 * It structurally satisfies `@lunarveil/chain`'s `MarketContractRegistryV1`
 * without importing it: `@lunarveil/chain` already depends on
 * `@lunarveil/matcher`, which depends on this package, so a nominal import
 * here would close a workspace dependency cycle.
 *
 * A market row that exists but carries a malformed address is an `INVALID_ROW`
 * failure, never a silent `undefined`: the caller distinguishes "no contract
 * for this market" from "the registry is broken", and only the first of those
 * is a normal condition.
 */
export class PostgresMarketContractRegistryV1 {
  constructor(private readonly pool: SerializableSqlPool) {}

  async resolveContractAddress(marketId: string): Promise<string | undefined> {
    if (typeof marketId !== 'string' || !MARKET_ID_PATTERN.test(marketId)) {
      throw new MarketContractRegistryDbError('INVALID_MARKET_ID');
    }
    let rows: readonly MarketContractRow[];
    const client = await this.pool.connect();
    try {
      const result = await client.query<MarketContractRow>(SELECT_CONTRACT_ADDRESS, [marketId]);
      rows = result.rows;
    } catch {
      throw new MarketContractRegistryDbError('DATABASE_FAILURE');
    } finally {
      client.release();
    }

    const row = rows[0];
    if (row === undefined) return undefined;
    const address = typeof row.marketContractAddress === 'string'
      ? row.marketContractAddress.trim().toLowerCase()
      : undefined;
    if (address === undefined || !CONTRACT_ADDRESS_PATTERN.test(address)) {
      throw new MarketContractRegistryDbError('INVALID_ROW');
    }
    return address;
  }
}
