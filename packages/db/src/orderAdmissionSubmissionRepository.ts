import { randomUUID } from 'node:crypto';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_LIMIT = 100;

export interface OrderAdmissionSubmissionCandidateV1 {
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly epochSequence: bigint;
  readonly contractAddress: string;
  readonly commitment: string;
}

export type OrderAdmissionSubmissionClaimV1 =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly state: 'ATTEMPTING' | 'SUBMITTED' | 'UNCERTAIN' };

export class OrderAdmissionSubmissionRepositoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_ROW' | 'INVALID_STATE' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'OrderAdmissionSubmissionRepositoryError';
  }
}

interface CandidateRow extends Record<string, unknown> {
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly epochSequence: string;
  readonly contractAddress: string;
  readonly commitment: string;
}

const SELECT_CANDIDATES = `
  SELECT o."id" AS "orderId", o."clientRequestId"::text AS "clientRequestId",
    o."marketId", o."epochId", e."sequence"::text AS "epochSequence",
    m."marketContractAddress" AS "contractAddress", o."commitment"
  FROM "OrderEnvelope" o
  JOIN "Epoch" e ON e."id" = o."epochId" AND e."marketId" = o."marketId"
  JOIN "Market" m ON m."id" = o."marketId"
  LEFT JOIN "OrderAdmissionSubmission" s ON s."orderId" = o."id"
  WHERE o."state" = 'PENDING_CHAIN' AND e."state" = 'OPEN'
    AND m."status" = 'ACTIVE' AND s."orderId" IS NULL
  ORDER BY o."createdAt" ASC, o."id" ASC
  LIMIT $1
`;

function assertIdentifier(value: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) throw new OrderAdmissionSubmissionRepositoryError('INVALID_INPUT');
}

/**
 * Durable fail-closed boundary around the external admission mutation.
 * ATTEMPTING is written before the chain call. A crashed attempt is never
 * selected again automatically because its result may already be on-chain.
 */
export class PostgresOrderAdmissionSubmissionRepositoryV1 {
  constructor(
    private readonly pool: SerializableSqlPool,
    private readonly newId: () => string = randomUUID,
  ) {}

  async listCandidates(limit: number): Promise<readonly OrderAdmissionSubmissionCandidateV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new OrderAdmissionSubmissionRepositoryError('INVALID_INPUT');
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<CandidateRow>(SELECT_CANDIDATES, [limit]);
      return result.rows.map(row => {
        if (
          typeof row.orderId !== 'string' || !IDENTIFIER_PATTERN.test(row.orderId)
          || typeof row.clientRequestId !== 'string' || !/^[0-9a-f-]{36}$/u.test(row.clientRequestId)
          || typeof row.marketId !== 'string' || !IDENTIFIER_PATTERN.test(row.marketId)
          || typeof row.epochId !== 'string' || !IDENTIFIER_PATTERN.test(row.epochId)
          || typeof row.epochSequence !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(row.epochSequence)
          || typeof row.contractAddress !== 'string' || !IDENTIFIER_PATTERN.test(row.contractAddress)
          || typeof row.commitment !== 'string' || !HASH_PATTERN.test(row.commitment)
        ) throw new OrderAdmissionSubmissionRepositoryError('INVALID_ROW');
        return { ...row, epochSequence: BigInt(row.epochSequence) };
      });
    } catch (error) {
      if (error instanceof OrderAdmissionSubmissionRepositoryError) throw error;
      throw new OrderAdmissionSubmissionRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  async claim(orderId: string): Promise<OrderAdmissionSubmissionClaimV1> {
    assertIdentifier(orderId);
    const client: SerializableSqlClient = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const order = await client.query<{ state: string }>(
        'SELECT "state" FROM "OrderEnvelope" WHERE "id" = $1 FOR UPDATE', [orderId],
      );
      if (order.rows[0]?.state !== 'PENDING_CHAIN') {
        throw new OrderAdmissionSubmissionRepositoryError('INVALID_STATE');
      }
      const inserted = await client.query<{ state: 'ATTEMPTING' }>(`
        INSERT INTO "OrderAdmissionSubmission" ("id", "orderId", "state", "updatedAt")
        VALUES ($1, $2, 'ATTEMPTING', CURRENT_TIMESTAMP)
        ON CONFLICT ("orderId") DO NOTHING RETURNING "state"
      `, [this.newId(), orderId]);
      if (inserted.rows.length === 1) {
        await client.query('COMMIT');
        return { claimed: true };
      }
      const existing = await client.query<{ state: 'ATTEMPTING' | 'SUBMITTED' | 'UNCERTAIN' }>(
        'SELECT "state" FROM "OrderAdmissionSubmission" WHERE "orderId" = $1', [orderId],
      );
      const state = existing.rows[0]?.state;
      if (state !== 'ATTEMPTING' && state !== 'SUBMITTED' && state !== 'UNCERTAIN') {
        throw new OrderAdmissionSubmissionRepositoryError('INVALID_STATE');
      }
      await client.query('COMMIT');
      return { claimed: false, state };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error instanceof OrderAdmissionSubmissionRepositoryError) throw error;
      throw new OrderAdmissionSubmissionRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  async markSubmitted(orderId: string, publicTxId: string): Promise<void> {
    await this.finish(orderId, 'SUBMITTED', publicTxId, null);
  }

  async markUncertain(orderId: string, errorCode = 'SUBMISSION_OUTCOME_UNCERTAIN'): Promise<void> {
    await this.finish(orderId, 'UNCERTAIN', null, errorCode);
  }

  private async finish(
    orderId: string,
    state: 'SUBMITTED' | 'UNCERTAIN',
    publicTxId: string | null,
    errorCode: string | null,
  ): Promise<void> {
    assertIdentifier(orderId);
    if (publicTxId !== null) assertIdentifier(publicTxId);
    if (errorCode !== null) assertIdentifier(errorCode);
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ id: string }>(`
        UPDATE "OrderAdmissionSubmission"
        SET "state" = $2, "publicTxId" = $3, "lastErrorCode" = $4, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "orderId" = $1 AND "state" = 'ATTEMPTING'
        RETURNING "id"
      `, [orderId, state, publicTxId, errorCode]);
      if (result.rows.length !== 1) throw new OrderAdmissionSubmissionRepositoryError('INVALID_STATE');
    } catch (error) {
      if (error instanceof OrderAdmissionSubmissionRepositoryError) throw error;
      throw new OrderAdmissionSubmissionRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }
}
