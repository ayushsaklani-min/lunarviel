import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

export type PublicMarketStatusV1 = 'ACTIVE' | 'ADMISSION_PAUSED' | 'SETTLEMENT_ONLY' | 'DISABLED';
export type PublicEpochStateV1 = 'OPEN' | 'CLOSED' | 'PROVING' | 'PENDING_FIRMUP' | 'SETTLING' | 'FINALIZED' | 'RECOMPUTE' | 'INVALIDATED';

export interface PublicMarketRecordV1 {
  readonly id: string;
  readonly marketKey: string;
  readonly baseAssetId: string;
  readonly quoteAssetId: string;
  readonly tickSizeAtomic: string;
  readonly lotSizeAtomic: string;
  readonly epochDurationSeconds: number;
  readonly maxOrdersPerEpoch: number;
  readonly minBatchPrivacy: number;
  readonly matchingRuleVersion: string;
  readonly status: PublicMarketStatusV1;
}

export interface PublicEpochRecordV1 {
  readonly id: string;
  readonly marketId: string;
  readonly sequence: string;
  readonly state: PublicEpochStateV1;
  readonly orderCount: number;
  readonly maxOrders: number;
  readonly scheduledCloseAtMs: string;
  readonly ruleVersion: string;
  readonly configHash: string;
}

export class PublicMarketCatalogRepositoryError extends Error {
  constructor(readonly code: 'DATABASE_FAILURE' | 'INVALID_DATABASE_RECORD') {
    super(code);
    this.name = 'PublicMarketCatalogRepositoryError';
  }
}

interface MarketRow extends Record<string, unknown> {
  readonly id: string;
  readonly marketKey: string;
  readonly baseAssetId: string;
  readonly quoteAssetId: string;
  readonly tickSizeAtomic: string;
  readonly lotSizeAtomic: string;
  readonly epochDurationSeconds: number;
  readonly maxOrdersPerEpoch: number;
  readonly minBatchPrivacy: number;
  readonly matchingRuleVersion: string;
  readonly status: PublicMarketStatusV1;
}

interface EpochRow extends Record<string, unknown> {
  readonly id: string;
  readonly marketId: string;
  readonly sequence: string | bigint;
  readonly state: PublicEpochStateV1;
  readonly orderCount: number;
  readonly maxOrders: number;
  readonly scheduledCloseAt: Date;
  readonly ruleVersion: string;
  readonly configHash: string;
}

const MARKET_STATUSES = new Set<PublicMarketStatusV1>(['ACTIVE', 'ADMISSION_PAUSED', 'SETTLEMENT_ONLY', 'DISABLED']);
const EPOCH_STATES = new Set<PublicEpochStateV1>(['OPEN', 'CLOSED', 'PROVING', 'PENDING_FIRMUP', 'SETTLING', 'FINALIZED', 'RECOMPUTE', 'INVALIDATED']);

const SELECT_MARKETS = `
  SELECT "id", "marketKey", "baseAssetId", "quoteAssetId", "tickSizeAtomic", "lotSizeAtomic",
    "epochDurationSeconds", "maxOrdersPerEpoch", "minBatchPrivacy", "matchingRuleVersion", "status"
  FROM "Market"
  ORDER BY "marketKey" ASC, "id" ASC
`;

const SELECT_CURRENT_EPOCH = `
  SELECT e."id", e."marketId", e."sequence", e."state", e."orderCount",
    m."maxOrdersPerEpoch" AS "maxOrders", e."scheduledCloseAt", e."ruleVersion", e."configHash"
  FROM "Epoch" e
  INNER JOIN "Market" m ON m."id" = e."marketId"
  WHERE e."marketId" = $1
    AND e."state" NOT IN ('FINALIZED', 'INVALIDATED')
  ORDER BY e."sequence" DESC, e."id" DESC
  LIMIT 1
`;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function marketFromRow(row: MarketRow): PublicMarketRecordV1 {
  if (
    !isNonEmptyString(row.id) || !isNonEmptyString(row.marketKey) || !isNonEmptyString(row.baseAssetId)
    || !isNonEmptyString(row.quoteAssetId) || !isNonEmptyString(row.tickSizeAtomic) || !isNonEmptyString(row.lotSizeAtomic)
    || !isNonEmptyString(row.matchingRuleVersion) || !MARKET_STATUSES.has(row.status)
    || !isNonNegativeInteger(row.epochDurationSeconds) || !isNonNegativeInteger(row.maxOrdersPerEpoch)
    || !isNonNegativeInteger(row.minBatchPrivacy)
  ) {
    throw new PublicMarketCatalogRepositoryError('INVALID_DATABASE_RECORD');
  }
  return {
    id: row.id, marketKey: row.marketKey, baseAssetId: row.baseAssetId, quoteAssetId: row.quoteAssetId,
    tickSizeAtomic: row.tickSizeAtomic, lotSizeAtomic: row.lotSizeAtomic,
    epochDurationSeconds: row.epochDurationSeconds, maxOrdersPerEpoch: row.maxOrdersPerEpoch,
    minBatchPrivacy: row.minBatchPrivacy, matchingRuleVersion: row.matchingRuleVersion, status: row.status,
  };
}

function epochFromRow(row: EpochRow): PublicEpochRecordV1 {
  const sequence = typeof row.sequence === 'bigint' ? row.sequence.toString(10) : row.sequence;
  if (
    !isNonEmptyString(row.id) || !isNonEmptyString(row.marketId) || !/^[0-9]+$/u.test(sequence)
    || !EPOCH_STATES.has(row.state) || !isNonNegativeInteger(row.orderCount) || !isNonNegativeInteger(row.maxOrders)
    || !(row.scheduledCloseAt instanceof Date) || !Number.isFinite(row.scheduledCloseAt.getTime())
    || !isNonEmptyString(row.ruleVersion) || !isNonEmptyString(row.configHash)
  ) {
    throw new PublicMarketCatalogRepositoryError('INVALID_DATABASE_RECORD');
  }
  return {
    id: row.id, marketId: row.marketId, sequence, state: row.state, orderCount: row.orderCount,
    maxOrders: row.maxOrders, scheduledCloseAtMs: BigInt(row.scheduledCloseAt.getTime()).toString(10),
    ruleVersion: row.ruleVersion, configHash: row.configHash,
  };
}

/**
 * Read-only catalog for the API's public discovery routes. It intentionally
 * never selects encrypted envelopes, credentials, allocations, or signatures.
 */
export class PostgresPublicMarketCatalogRepository {
  constructor(private readonly pool: SerializableSqlPool) {}

  async listMarkets(): Promise<readonly PublicMarketRecordV1[]> {
    const client = await this.connect();
    try {
      const result = await client.query<MarketRow>(SELECT_MARKETS);
      return result.rows.map(marketFromRow);
    } catch (error) {
      if (error instanceof PublicMarketCatalogRepositoryError) throw error;
      throw new PublicMarketCatalogRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  async currentEpoch(marketId: string): Promise<PublicEpochRecordV1 | undefined> {
    if (!isNonEmptyString(marketId) || marketId.length > 128) {
      throw new PublicMarketCatalogRepositoryError('INVALID_DATABASE_RECORD');
    }
    const client = await this.connect();
    try {
      const result = await client.query<EpochRow>(SELECT_CURRENT_EPOCH, [marketId]);
      const row = result.rows[0];
      return row === undefined ? undefined : epochFromRow(row);
    } catch (error) {
      if (error instanceof PublicMarketCatalogRepositoryError) throw error;
      throw new PublicMarketCatalogRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  private async connect() {
    try {
      return await this.pool.connect();
    } catch {
      throw new PublicMarketCatalogRepositoryError('DATABASE_FAILURE');
    }
  }
}
