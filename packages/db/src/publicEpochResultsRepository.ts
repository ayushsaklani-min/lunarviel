import type { SerializableSqlPool } from './orderEnvelopeRepository.js';
import { SIMULATED_CHAIN_PREFIX } from './simulatedChainRepository.js';

/**
 * The public outcome of one finished batch auction. Everything here is a
 * batch-level aggregate that a frequent batch auction publishes anyway; no
 * order side, price, quantity or trader identifier is representable.
 */
export interface PublicEpochResultV1 {
  readonly epochId: string;
  readonly sequence: string;
  readonly state: 'FINALIZED' | 'INVALIDATED';
  /** Canonical decimal milliseconds. */
  readonly closedAtMs: string;
  readonly orderCount: number;
  readonly matchedOrderCount: number;
  /** Absent when nothing traded. Canonical decimal ticks. */
  readonly clearingPriceTicks?: string;
  /** Canonical decimal lots. */
  readonly totalVolumeLots: string;
  readonly rejectedSolutionCount: number;
  readonly proofReference?: string;
  readonly settlementReference?: string;
  /** True when proof and settlement came from the development-only simulated chain. */
  readonly simulated: boolean;
}

export class PublicEpochResultsRepositoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_DATABASE_RECORD' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'PublicEpochResultsRepositoryError';
  }
}

interface ResultRow extends Record<string, unknown> {
  readonly id: string;
  readonly sequence: string;
  readonly state: string;
  readonly closedAt: Date | null;
  readonly orderCount: number;
  readonly matchedCount: number | null;
  readonly clearingPriceTicks: string | null;
  readonly publicVolume: string | null;
  readonly rejectedSolutionCount: number | null;
  readonly batchProofTxId: string | null;
  readonly settlementTxId: string | null;
}

const SELECT_RESULTS = `
  SELECT e."id", e."sequence"::text AS "sequence", e."state", e."closedAt", e."orderCount",
    b."sanitizedMatchedCount" AS "matchedCount", b."clearingPriceTicks", b."publicVolume",
    b."rejectedSolutionCount", e."batchProofTxId", e."settlementTxId"
  FROM "Epoch" e
  LEFT JOIN "BatchSolutionRecord" b ON b."epochId" = e."id"
  WHERE e."marketId" = $1 AND e."state" IN ('FINALIZED', 'INVALIDATED')
  ORDER BY e."sequence" DESC, e."id" DESC
  LIMIT $2
`;

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

function resultFromRow(row: ResultRow): PublicEpochResultV1 {
  if (typeof row.id !== 'string' || !DECIMAL.test(row.sequence)
    || (row.state !== 'FINALIZED' && row.state !== 'INVALIDATED')
    || !(row.closedAt instanceof Date) || !Number.isSafeInteger(row.orderCount)
    || (row.clearingPriceTicks !== null && !DECIMAL.test(row.clearingPriceTicks))
    || (row.publicVolume !== null && !DECIMAL.test(row.publicVolume))) {
    throw new PublicEpochResultsRepositoryError('INVALID_DATABASE_RECORD');
  }
  const volume = row.publicVolume ?? '0';
  const references = [row.batchProofTxId, row.settlementTxId].filter((value): value is string => value !== null);
  return {
    epochId: row.id,
    sequence: row.sequence,
    state: row.state,
    closedAtMs: BigInt(row.closedAt.getTime()).toString(10),
    orderCount: row.orderCount,
    matchedOrderCount: row.matchedCount ?? 0,
    // A clearing price with zero volume is not a trade; do not publish it as one.
    ...(row.clearingPriceTicks !== null && volume !== '0' ? { clearingPriceTicks: row.clearingPriceTicks } : {}),
    totalVolumeLots: volume,
    rejectedSolutionCount: row.rejectedSolutionCount ?? 0,
    ...(row.batchProofTxId === null ? {} : { proofReference: row.batchProofTxId }),
    ...(row.settlementTxId === null ? {} : { settlementReference: row.settlementTxId }),
    simulated: references.some(reference => reference.startsWith(SIMULATED_CHAIN_PREFIX)),
  };
}

/** Read-only public batch outcomes. Never selects ciphertext or per-order data. */
export class PostgresPublicEpochResultsRepositoryV1 {
  constructor(private readonly pool: SerializableSqlPool) {}

  async recentResults(marketId: string, limit: number): Promise<readonly PublicEpochResultV1[]> {
    if (typeof marketId !== 'string' || marketId.length === 0 || marketId.length > 128
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new PublicEpochResultsRepositoryError('INVALID_INPUT');
    }
    let client;
    try {
      client = await this.pool.connect();
    } catch {
      throw new PublicEpochResultsRepositoryError('DATABASE_FAILURE');
    }
    try {
      const result = await client.query<ResultRow>(SELECT_RESULTS, [marketId, limit]);
      return result.rows.map(resultFromRow);
    } catch (error) {
      if (error instanceof PublicEpochResultsRepositoryError) throw error;
      throw new PublicEpochResultsRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }
}
