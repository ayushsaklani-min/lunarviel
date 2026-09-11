import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMMITMENT_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_LIMIT = 1_000;

export interface PendingChainOrderRecordV1 {
  readonly orderId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly state: 'PENDING_CHAIN';
}

export class PendingChainOrderSourceError extends Error {
  constructor(readonly code: 'INVALID_LIMIT' | 'INVALID_ROW' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'PendingChainOrderSourceError';
  }
}

interface PendingRow extends Record<string, unknown> {
  readonly id: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly state: string;
}

// Deterministic ordering keeps concurrent replicas and repeated passes stable.
const SELECT_PENDING = `
  SELECT "id", "marketId", "epochId", "commitment", "state"
  FROM "OrderEnvelope"
  WHERE "state" = 'PENDING_CHAIN'
  ORDER BY "createdAt" ASC, "id" ASC
  LIMIT $1
`;

/** Read-only public scan. It selects no ciphertext, signature or allocation column. */
export class PostgresPendingChainOrderSourceV1 {
  constructor(private readonly pool: SerializableSqlPool) {}

  async listPending(limit: number): Promise<readonly PendingChainOrderRecordV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new PendingChainOrderSourceError('INVALID_LIMIT');
    }
    let rows: readonly PendingRow[];
    const client = await this.pool.connect();
    try {
      const result = await client.query<PendingRow>(SELECT_PENDING, [limit]);
      rows = result.rows;
    } catch (error) {
      if (error instanceof PendingChainOrderSourceError) throw error;
      throw new PendingChainOrderSourceError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
    return rows.map(row => {
      if (
        typeof row.id !== 'string' || !IDENTIFIER_PATTERN.test(row.id)
        || typeof row.marketId !== 'string' || !IDENTIFIER_PATTERN.test(row.marketId)
        || typeof row.epochId !== 'string' || !IDENTIFIER_PATTERN.test(row.epochId)
        || typeof row.commitment !== 'string' || !COMMITMENT_PATTERN.test(row.commitment)
        || row.state !== 'PENDING_CHAIN'
      ) {
        throw new PendingChainOrderSourceError('INVALID_ROW');
      }
      return {
        orderId: row.id,
        marketId: row.marketId,
        epochId: row.epochId,
        commitment: row.commitment,
        state: 'PENDING_CHAIN' as const,
      };
    });
  }
}
