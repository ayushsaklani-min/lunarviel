import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TRADER_TAG_PATTERN = /^[0-9a-f]{64}$/u;
const COMMITMENT_PATTERN = /^[0-9a-f]{64}$/u;
const LEAF_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/u;
const TX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/u;
const MAX_LIMIT = 200;

export const TRADER_ORDER_STATES_V1 = [
  'PENDING_CHAIN', 'ACCEPTED', 'RESERVED', 'PARTIALLY_FILLED', 'FILLED',
  'CANCEL_PENDING', 'CANCELLED', 'EXPIRED', 'REJECTED',
] as const;

export type TraderOrderStateV1 = (typeof TRADER_ORDER_STATES_V1)[number];

/**
 * One of a trader's orders, as workflow metadata only.
 *
 * Nothing here is order content. Side, price, quantity and minimum fill live
 * exclusively in the ciphertext, which this repository never selects.
 */
export interface TraderOrderRecordV1 {
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  /** Public: this is what goes on chain. */
  readonly commitment: string;
  readonly state: TraderOrderStateV1;
  readonly createdAtMs: bigint;
  readonly acceptedAtMs: bigint | undefined;
  readonly chainAdmissionTxId: string | undefined;
  readonly leafIndex: string | undefined;
  /**
   * Public tx id recorded by the admission worker once its transaction
   * finalized with SucceedEntirely. Reconciliation may not have run yet, so
   * this is reported separately from `chainAdmissionTxId`.
   */
  readonly admissionSubmittedTxId?: string | undefined;
}

export class TraderOrderHistoryError extends Error {
  constructor(readonly code: 'INVALID_TRADER_TAG' | 'INVALID_LIMIT' | 'INVALID_ROW' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'TraderOrderHistoryError';
  }
}

interface TraderOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly state: string;
  readonly createdAtMs: string;
  readonly acceptedAtMs: string | null;
  readonly chainAdmissionTxId: string | null;
  readonly leafIndex: string | null;
  readonly admissionSubmittedTxId?: string | null;
}

/**
 * Public workflow columns only. There is deliberately no `ciphertext`,
 * `clientSignature`, `encryptionKeyId` or envelope-crypto column in this
 * projection, and a privacy test asserts the statement stays that way.
 */
const SELECT_TRADER_ORDERS = `
  SELECT
    "id",
    "clientRequestId",
    "marketId",
    "epochId",
    "commitment",
    "state",
    (EXTRACT(EPOCH FROM "createdAt") * 1000)::bigint::text AS "createdAtMs",
    CASE WHEN "acceptedAt" IS NULL THEN NULL
      ELSE (EXTRACT(EPOCH FROM "acceptedAt") * 1000)::bigint::text END AS "acceptedAtMs",
    "chainAdmissionTxId",
    "leafIndex",
    (SELECT s."publicTxId" FROM "OrderAdmissionSubmission" s
      WHERE s."orderId" = "OrderEnvelope"."id" AND s."state" = 'SUBMITTED') AS "admissionSubmittedTxId"
  FROM "OrderEnvelope"
  WHERE "traderTagHash" = $1
  ORDER BY "createdAt" DESC, "id" DESC
  LIMIT $2
`;

/**
 * Reads one trader's own order history.
 *
 * The trader tag is supplied by the caller and must come from an authenticated
 * session, never from a request field: this repository has no way to tell the
 * difference, so the service above it is responsible for deriving the tag
 * rather than accepting one.
 */
export class PostgresTraderOrderHistoryRepositoryV1 {
  constructor(private readonly pool: SerializableSqlPool) {}

  async listForTrader(input: {
    readonly traderTagHash: string;
    readonly limit: number;
  }): Promise<readonly TraderOrderRecordV1[]> {
    if (typeof input.traderTagHash !== 'string' || !TRADER_TAG_PATTERN.test(input.traderTagHash)) {
      throw new TraderOrderHistoryError('INVALID_TRADER_TAG');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
      throw new TraderOrderHistoryError('INVALID_LIMIT');
    }

    let rows: readonly TraderOrderRow[];
    const client = await this.pool.connect();
    try {
      const result = await client.query<TraderOrderRow>(
        SELECT_TRADER_ORDERS,
        [input.traderTagHash, input.limit],
      );
      rows = result.rows;
    } catch {
      throw new TraderOrderHistoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }

    return rows.map(row => {
      if (
        typeof row.id !== 'string' || !IDENTIFIER_PATTERN.test(row.id)
        || typeof row.clientRequestId !== 'string' || !IDENTIFIER_PATTERN.test(row.clientRequestId)
        || typeof row.marketId !== 'string' || !IDENTIFIER_PATTERN.test(row.marketId)
        || typeof row.epochId !== 'string' || !IDENTIFIER_PATTERN.test(row.epochId)
        || typeof row.commitment !== 'string' || !COMMITMENT_PATTERN.test(row.commitment)
        || !(TRADER_ORDER_STATES_V1 as readonly string[]).includes(row.state)
        || typeof row.createdAtMs !== 'string' || !/^-?[0-9]+$/u.test(row.createdAtMs)
        || (row.acceptedAtMs !== null && (typeof row.acceptedAtMs !== 'string' || !/^-?[0-9]+$/u.test(row.acceptedAtMs)))
        || (row.chainAdmissionTxId !== null && (typeof row.chainAdmissionTxId !== 'string' || !TX_ID_PATTERN.test(row.chainAdmissionTxId)))
        || (row.leafIndex !== null && (typeof row.leafIndex !== 'string' || !LEAF_INDEX_PATTERN.test(row.leafIndex)))
        || (row.admissionSubmittedTxId != null && (typeof row.admissionSubmittedTxId !== 'string' || !TX_ID_PATTERN.test(row.admissionSubmittedTxId)))
      ) {
        throw new TraderOrderHistoryError('INVALID_ROW');
      }

      return {
        orderId: row.id,
        clientRequestId: row.clientRequestId,
        marketId: row.marketId,
        epochId: row.epochId,
        commitment: row.commitment,
        state: row.state as TraderOrderStateV1,
        createdAtMs: BigInt(row.createdAtMs),
        acceptedAtMs: row.acceptedAtMs === null ? undefined : BigInt(row.acceptedAtMs),
        chainAdmissionTxId: row.chainAdmissionTxId ?? undefined,
        leafIndex: row.leafIndex ?? undefined,
        admissionSubmittedTxId: row.admissionSubmittedTxId ?? undefined,
      };
    });
  }
}
