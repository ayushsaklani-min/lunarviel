import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMMITMENT_PATTERN = /^[0-9a-f]{64}$/u;
const LEAF_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/u;
// Must accept everything the write path (@lunarveil/chain's TX_ID_PATTERN)
// can legally produce, or a txId that is valid to write becomes unreadable
// forever and permanently disables the reorg re-check for all orders.
const TX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/u;
const MAX_LIMIT = 1_000;

export interface AcceptedAdmissionRowV1 {
  readonly orderId: string;
  readonly marketId: string;
  readonly commitment: string;
  readonly txId: string;
  readonly leafIndex: string | undefined;
}

export class AcceptedAdmissionSourceError extends Error {
  constructor(readonly code: 'INVALID_LIMIT' | 'INVALID_LOOKBACK' | 'INVALID_ROW' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'AcceptedAdmissionSourceError';
  }
}

interface AcceptedRow extends Record<string, unknown> {
  readonly id: string;
  readonly marketId: string;
  readonly commitment: string;
  readonly chainAdmissionTxId: string | null;
  readonly leafIndex: string | null;
}

const SELECT_ACCEPTED = `
  SELECT "id", "marketId", "commitment", "chainAdmissionTxId", "leafIndex"
  FROM "OrderEnvelope"
  WHERE "state" = 'ACCEPTED'
    AND "chainAdmissionTxId" IS NOT NULL
    AND "acceptedAt" IS NOT NULL
    AND "acceptedAt" >= NOW() - $1::bigint * INTERVAL '1 millisecond'
  ORDER BY "acceptedAt" ASC, "id" ASC
  LIMIT $2
`;

/** Read-only scan of recently accepted admissions for the reorg re-check. */
export class PostgresAcceptedAdmissionSourceV1 {
  constructor(private readonly pool: SerializableSqlPool) {}

  async listRecentlyAccepted(input: { readonly limit: number; readonly lookbackMs: number }): Promise<readonly AcceptedAdmissionRowV1[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
      throw new AcceptedAdmissionSourceError('INVALID_LIMIT');
    }
    if (!Number.isSafeInteger(input.lookbackMs) || input.lookbackMs < 1) {
      throw new AcceptedAdmissionSourceError('INVALID_LOOKBACK');
    }
    let rows: readonly AcceptedRow[];
    const client = await this.pool.connect();
    try {
      const result = await client.query<AcceptedRow>(SELECT_ACCEPTED, [String(input.lookbackMs), input.limit]);
      rows = result.rows;
    } catch {
      throw new AcceptedAdmissionSourceError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
    return rows.map(row => {
      if (
        typeof row.id !== 'string' || !IDENTIFIER_PATTERN.test(row.id)
        || typeof row.marketId !== 'string' || !IDENTIFIER_PATTERN.test(row.marketId)
        || typeof row.commitment !== 'string' || !COMMITMENT_PATTERN.test(row.commitment)
        || typeof row.chainAdmissionTxId !== 'string' || !TX_ID_PATTERN.test(row.chainAdmissionTxId)
        || (row.leafIndex !== null && (typeof row.leafIndex !== 'string' || !LEAF_INDEX_PATTERN.test(row.leafIndex)))
      ) {
        throw new AcceptedAdmissionSourceError('INVALID_ROW');
      }
      return {
        orderId: row.id,
        marketId: row.marketId,
        commitment: row.commitment,
        txId: row.chainAdmissionTxId,
        ...(row.leafIndex !== null ? { leafIndex: row.leafIndex } : { leafIndex: undefined }),
      };
    });
  }
}
