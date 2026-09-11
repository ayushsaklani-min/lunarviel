import { randomUUID } from 'node:crypto';

import type { OrderEnvelopeV1 } from '@lunarveil/crypto';
import type { BatchSolutionV1 } from '@lunarveil/matching-core';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ClosedEpochBatchCandidateV1 {
  readonly marketId: string;
  readonly epochId: string;
  readonly epochSequence: bigint;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly inputRoot: string;
  readonly closedAtMs: bigint;
  readonly orderCount: number;
  readonly maxOrders: number;
}

export interface ClosedEpochEncryptedOrderV1 {
  readonly orderId: string;
  readonly leafIndex: bigint;
  readonly envelope: OrderEnvelopeV1;
}

export type BeginProvingOutcomeV1 =
  | { readonly outcome: 'STARTED'; readonly batchId: string }
  | { readonly outcome: 'REPLAYED'; readonly batchId: string }
  | { readonly outcome: 'CONFLICT' };

export class ClosedEpochBatchRepositoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_ROW' | 'INVALID_STATE' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'ClosedEpochBatchRepositoryError';
  }
}

interface CandidateRow extends Record<string, unknown> {
  readonly marketId: string;
  readonly epochId: string;
  readonly sequence: string;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly closeRoot: string;
  readonly closedAt: Date;
  readonly orderCount: number;
  readonly maxOrdersPerEpoch: number;
  readonly onchainEndIndexExclusive: string;
}

interface EncryptedOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly leafIndex: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly encryptionKeyId: string;
  readonly envelopeVersion: number;
  readonly envelopeAlgorithm: string;
  readonly ephemeralPublicKey: string;
  readonly envelopeSalt: string;
  readonly envelopeNonce: string;
  readonly ciphertext: Buffer;
  readonly traderTagHash: string;
}

const SELECT_READY = `
  SELECT e."id" AS "epochId", e."marketId", e."sequence"::text AS "sequence",
    e."ruleVersion", e."configHash", e."closeRoot", e."closedAt", e."orderCount",
    e."onchainEndIndexExclusive", m."maxOrdersPerEpoch"
  FROM "Epoch" e
  JOIN "Market" m ON m."id" = e."marketId"
  WHERE e."state" = 'CLOSED'
    AND e."closeRoot" IS NOT NULL
    AND e."closedAt" IS NOT NULL
    AND e."onchainEndIndexExclusive" IS NOT NULL
    -- M3a does not prove an oracle collar. Refuse to prepare an epoch whose
    -- frozen public configuration would require one.
    AND e."referencePriceHash" IS NULL
    AND m."maxPriceCollarBps" IS NULL
  ORDER BY e."closedAt" ASC, e."id" ASC
  LIMIT $1
`;

const SELECT_FROZEN_ORDERS = `
  SELECT "id", "leafIndex", "clientRequestId", "marketId", "epochId", "commitment",
    "encryptionKeyId", "envelopeVersion", "envelopeAlgorithm", "ephemeralPublicKey",
    "envelopeSalt", "envelopeNonce", "ciphertext", "traderTagHash"
  FROM "OrderEnvelope"
  WHERE "epochId" = $1 AND "state" = 'ACCEPTED' AND "leafIndex" IS NOT NULL
  ORDER BY ("leafIndex")::numeric ASC, "id" ASC
`;

const LOCK_EPOCH = `
  SELECT "state", "configHash", "closeRoot", "orderCount"
  FROM "Epoch" WHERE "id" = $1 FOR UPDATE
`;

const INSERT_BATCH = `
  INSERT INTO "BatchSolutionRecord" (
    "id", "epochId", "ruleVersion", "solutionCommitment", "encryptedSolution",
    "proofReference", "status", "sanitizedOrderCount", "sanitizedMatchedCount", "publicVolume"
  ) VALUES ($1, $2, $3, $4, NULL, NULL, 'PROOF_PENDING', $5, $6, NULL)
  ON CONFLICT ("epochId") DO NOTHING
  RETURNING "id"
`;

const SELECT_BATCH = `
  SELECT "id", "solutionCommitment" FROM "BatchSolutionRecord" WHERE "epochId" = $1
`;

const START_PROVING = `
  UPDATE "Epoch"
  SET "state" = 'PROVING', "pendingSolutionCommitment" = $2, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" = 'CLOSED'
`;

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ClosedEpochBatchRepositoryError('INVALID_INPUT');
  }
}

function toCandidate(row: CandidateRow): ClosedEpochBatchCandidateV1 {
  if (!IDENTIFIER.test(row.marketId) || !IDENTIFIER.test(row.epochId) || !DECIMAL.test(row.sequence)
    || !IDENTIFIER.test(row.ruleVersion) || !HASH.test(row.configHash) || !IDENTIFIER.test(row.closeRoot)
    || !(row.closedAt instanceof Date) || !Number.isSafeInteger(row.orderCount) || row.orderCount < 0
    || !Number.isSafeInteger(row.maxOrdersPerEpoch) || row.maxOrdersPerEpoch < 1
    || !DECIMAL.test(row.onchainEndIndexExclusive)) {
    throw new ClosedEpochBatchRepositoryError('INVALID_ROW');
  }
  const end = BigInt(row.onchainEndIndexExclusive);
  if (end !== BigInt(row.orderCount) || row.orderCount > row.maxOrdersPerEpoch) {
    throw new ClosedEpochBatchRepositoryError('INVALID_ROW');
  }
  return {
    marketId: row.marketId, epochId: row.epochId, epochSequence: BigInt(row.sequence),
    ruleVersion: row.ruleVersion, configHash: row.configHash, inputRoot: row.closeRoot,
    closedAtMs: BigInt(row.closedAt.getTime()), orderCount: row.orderCount, maxOrders: row.maxOrdersPerEpoch,
  };
}

function toEncryptedOrder(row: EncryptedOrderRow, epochId: string): ClosedEpochEncryptedOrderV1 {
  if (!IDENTIFIER.test(row.id) || !DECIMAL.test(row.leafIndex) || !UUID.test(row.clientRequestId)
    || !IDENTIFIER.test(row.marketId) || !IDENTIFIER.test(row.epochId) || row.epochId !== epochId
    || !HASH.test(row.commitment) || !IDENTIFIER.test(row.encryptionKeyId)
    || row.envelopeVersion !== 1 || typeof row.envelopeAlgorithm !== 'string'
    || typeof row.ephemeralPublicKey !== 'string' || typeof row.envelopeSalt !== 'string'
    || typeof row.envelopeNonce !== 'string' || !(row.ciphertext instanceof Buffer)
    || !HASH.test(row.traderTagHash)) {
    throw new ClosedEpochBatchRepositoryError('INVALID_ROW');
  }
  return {
    orderId: row.id,
    leafIndex: BigInt(row.leafIndex),
    envelope: {
      version: 1, clientRequestId: row.clientRequestId, marketId: row.marketId, epochId: row.epochId,
      commitment: row.commitment, traderTagHash: row.traderTagHash, encryptionKeyId: row.encryptionKeyId,
      algorithm: row.envelopeAlgorithm as OrderEnvelopeV1['algorithm'], ephemeralPublicKey: row.ephemeralPublicKey,
      salt: row.envelopeSalt, nonce: row.envelopeNonce, ciphertext: row.ciphertext.toString('base64url'),
    },
  };
}

/**
 * Matcher-only database boundary. It is the one deliberate query path that
 * may read order ciphertext after chain admission; public/API repositories
 * must continue to expose ciphertext-free projections.
 */
export class PostgresClosedEpochBatchRepositoryV1 {
  constructor(private readonly pool: SerializableSqlPool, private readonly newId: () => string = randomUUID) {}

  async listReady(limit: number): Promise<readonly ClosedEpochBatchCandidateV1[]> {
    assertLimit(limit);
    const client = await this.pool.connect();
    try {
      const result = await client.query<CandidateRow>(SELECT_READY, [limit]);
      return result.rows.map(toCandidate);
    } catch (error) {
      if (error instanceof ClosedEpochBatchRepositoryError) throw error;
      throw new ClosedEpochBatchRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  async loadFrozenOrders(epochId: string): Promise<readonly ClosedEpochEncryptedOrderV1[]> {
    if (!IDENTIFIER.test(epochId)) throw new ClosedEpochBatchRepositoryError('INVALID_INPUT');
    const client = await this.pool.connect();
    try {
      const result = await client.query<EncryptedOrderRow>(SELECT_FROZEN_ORDERS, [epochId]);
      return result.rows.map(row => toEncryptedOrder(row, epochId));
    } catch (error) {
      if (error instanceof ClosedEpochBatchRepositoryError) throw error;
      throw new ClosedEpochBatchRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  /**
   * Atomically records a non-sensitive solution fingerprint and starts the
   * proof phase. The solution itself remains only in matcher memory and can
   * be deterministically reconstructed from the frozen ciphertext if needed.
   */
  async beginProving(input: {
    readonly candidate: ClosedEpochBatchCandidateV1;
    readonly solution: BatchSolutionV1;
  }): Promise<BeginProvingOutcomeV1> {
    const { candidate, solution } = input;
    if (solution.epochId !== candidate.epochId || solution.marketId !== candidate.marketId
      || solution.ruleVersion !== candidate.ruleVersion || solution.configHash !== candidate.configHash
      || solution.inputRoot !== candidate.inputRoot || !HASH.test(solution.canonicalSolutionHash)) {
      throw new ClosedEpochBatchRepositoryError('INVALID_INPUT');
    }
    const client: SerializableSqlClient = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      try {
        const locked = await client.query<{ state: string; configHash: string; closeRoot: string | null; orderCount: number }>(LOCK_EPOCH, [candidate.epochId]);
        const epoch = locked.rows[0];
        if (!epoch || epoch.state !== 'CLOSED' || epoch.configHash !== candidate.configHash
          || epoch.closeRoot !== candidate.inputRoot || epoch.orderCount !== candidate.orderCount) {
          throw new ClosedEpochBatchRepositoryError('INVALID_STATE');
        }
        const inserted = await client.query<{ id: string }>(INSERT_BATCH, [
          this.newId(), candidate.epochId, candidate.ruleVersion, solution.canonicalSolutionHash,
          candidate.orderCount, solution.fills.length,
        ]);
        if (inserted.rows[0]) {
          await client.query(START_PROVING, [candidate.epochId, solution.canonicalSolutionHash]);
          await client.query('COMMIT');
          return { outcome: 'STARTED', batchId: inserted.rows[0].id };
        }
        const existing = await client.query<{ id: string; solutionCommitment: string }>(SELECT_BATCH, [candidate.epochId]);
        const batch = existing.rows[0];
        if (!batch || batch.solutionCommitment !== solution.canonicalSolutionHash) {
          throw new ClosedEpochBatchRepositoryError('INVALID_STATE');
        }
        await client.query('COMMIT');
        return { outcome: 'REPLAYED', batchId: batch.id };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the safe outcome. */ }
        throw error;
      }
    } catch (error) {
      if (error instanceof ClosedEpochBatchRepositoryError) throw error;
      throw new ClosedEpochBatchRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }
}
