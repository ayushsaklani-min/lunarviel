import { createHash, randomUUID } from 'node:crypto';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

/**
 * Prefix carried by every identifier the simulated chain invents, so a
 * simulated admission, root, proof or settlement can never be mistaken for a
 * real chain artifact in the database, the API or the UI.
 */
export const SIMULATED_CHAIN_PREFIX = 'simulated:';

export class SimulatedChainRepositoryError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_ROW' | 'INVALID_STATE' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'SimulatedChainRepositoryError';
  }
}

export interface SimulatedAdmissionCandidateV1 {
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly epochSequence: bigint;
  readonly contractAddress: string;
  readonly commitment: string;
}

export type SimulatedAdmissionOutcomeV1 =
  | { readonly outcome: 'ADMITTED'; readonly leafIndex: bigint; readonly txId: string }
  | { readonly outcome: 'EPOCH_FULL' }
  | { readonly outcome: 'SKIPPED' };

/** Terminal owner-visible order outcomes of a finalized batch. */
export type SimulatedOrderOutcomeV1 = 'FILLED' | 'PARTIALLY_FILLED' | 'EXPIRED';

export interface SimulatedFinalizationV1 {
  readonly epochId: string;
  readonly solutionCommitment: string;
  readonly clearingPriceTicks: bigint;
  readonly totalVolumeLots: bigint;
  readonly matchedOrderCount: number;
  readonly rejectedSolutionCount: number;
  /** Keyed by public commitment. Every admitted order must appear exactly once. */
  readonly orderOutcomes: ReadonlyMap<string, SimulatedOrderOutcomeV1>;
}

const SELECT_PENDING = `
  SELECT o."id", o."clientRequestId"::text AS "clientRequestId", o."marketId", o."epochId",
    o."commitment", e."sequence"::text AS "sequence", m."marketContractAddress"
  FROM "OrderEnvelope" o
  JOIN "Epoch" e ON e."id" = o."epochId"
  JOIN "Market" m ON m."id" = o."marketId"
  WHERE o."state" = 'PENDING_CHAIN' AND e."state" = 'OPEN'
  ORDER BY o."createdAt" ASC, o."id" ASC
  LIMIT $1
`;

const LOCK_OPEN_EPOCH = `
  SELECT e."state", m."maxOrdersPerEpoch",
    (SELECT COUNT(*) FROM "OrderEnvelope" o
      WHERE o."epochId" = e."id" AND o."state" = 'ACCEPTED')::text AS "accepted"
  FROM "Epoch" e JOIN "Market" m ON m."id" = e."marketId"
  WHERE e."id" = $1
  FOR UPDATE OF e
`;

const ADMIT = `
  UPDATE "OrderEnvelope"
  SET "state" = 'ACCEPTED', "leafIndex" = $2, "chainAdmissionTxId" = $3,
      "acceptedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" = 'PENDING_CHAIN'
`;

const REJECT = `
  UPDATE "OrderEnvelope" SET "state" = 'REJECTED', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" = 'PENDING_CHAIN'
`;

/** A pending order in an epoch that is no longer open can never be admitted. */
const EXPIRE_STRANDED = `
  UPDATE "OrderEnvelope" o SET "state" = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
  FROM "Epoch" e
  WHERE e."id" = o."epochId" AND o."state" = 'PENDING_CHAIN' AND e."state" <> 'OPEN'
`;

const SELECT_UNFROZEN = `
  SELECT "id" FROM "Epoch"
  WHERE "state" = 'CLOSED' AND "closeRoot" IS NULL
  ORDER BY "closedAt" ASC, "id" ASC
  LIMIT $1
`;

const LOCK_CLOSED_EPOCH = `
  SELECT "state", "orderCount", "closeRoot" FROM "Epoch" WHERE "id" = $1 FOR UPDATE
`;

const SELECT_ADMITTED_COMMITMENTS = `
  SELECT "commitment", "leafIndex" FROM "OrderEnvelope"
  WHERE "epochId" = $1 AND "state" = 'ACCEPTED'
  ORDER BY ("leafIndex")::numeric ASC
`;

const FREEZE = `
  UPDATE "Epoch" SET "closeRoot" = $2, "onchainEndIndexExclusive" = $3, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" = 'CLOSED' AND "closeRoot" IS NULL
`;

const LOCK_MATCHED_EPOCH = `
  SELECT e."state", e."pendingSolutionCommitment", b."solutionCommitment" AS "batchCommitment"
  FROM "Epoch" e LEFT JOIN "BatchSolutionRecord" b ON b."epochId" = e."id"
  WHERE e."id" = $1
  FOR UPDATE OF e
`;

/**
 * The solution lives only in matcher memory. If the process stopped between
 * starting the proof and finalizing, return the epoch to CLOSED: matching is
 * deterministic, so the next pass re-derives the identical solution, which
 * `beginProving` reports as REPLAYED against the stored fingerprint.
 */
const RECOVER_STALLED = `
  UPDATE "Epoch" SET "state" = 'CLOSED', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "state" = 'PROVING'
`;

const INVALIDATE_EPOCH = `
  UPDATE "Epoch" SET "state" = 'INVALIDATED', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" IN ('CLOSED', 'PROVING')
`;

const EXPIRE_EPOCH_ORDERS = `
  UPDATE "OrderEnvelope" SET "state" = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
  WHERE "epochId" = $1 AND "state" IN ('ACCEPTED', 'PENDING_CHAIN')
`;

const SELECT_EPOCH_ORDERS = `
  SELECT "commitment" FROM "OrderEnvelope" WHERE "epochId" = $1 AND "state" = 'ACCEPTED'
`;

const SET_ORDER_OUTCOME = `
  UPDATE "OrderEnvelope" SET "state" = $3::"OrderState", "updatedAt" = CURRENT_TIMESTAMP
  WHERE "epochId" = $1 AND "commitment" = $2 AND "state" = 'ACCEPTED'
`;

const FINALIZE_BATCH = `
  UPDATE "BatchSolutionRecord"
  SET "status" = 'FINALIZED_SIMULATED', "proofReference" = $2, "publicVolume" = $3,
      "clearingPriceTicks" = $4, "sanitizedMatchedCount" = $5, "rejectedSolutionCount" = $6,
      "updatedAt" = CURRENT_TIMESTAMP
  WHERE "epochId" = $1 AND "solutionCommitment" = $7
`;

const FINALIZE_EPOCH = `
  UPDATE "Epoch"
  SET "state" = 'FINALIZED', "finalSolutionCommitment" = $2, "batchProofTxId" = $3,
      "settlementTxId" = $4, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" = $5::"EpochState"
`;

/** An empty frozen epoch has nothing to match; it is finalized directly. */
const SELECT_EMPTY_FROZEN = `
  SELECT "id" FROM "Epoch"
  WHERE "state" = 'CLOSED' AND "orderCount" = 0 AND "closeRoot" IS NOT NULL
  ORDER BY "closedAt" ASC, "id" ASC LIMIT $1
`;

const SELECT_MARKETS_WITHOUT_OPEN_EPOCH = `
  SELECT m."id" AS "marketId", m."epochDurationSeconds",
    e."sequence"::text AS "sequence", e."configHash", e."ruleVersion",
    e."onchainStartIndex", e."orderCount"
  FROM "Market" m
  JOIN LATERAL (
    SELECT * FROM "Epoch" x WHERE x."marketId" = m."id" ORDER BY x."sequence" DESC LIMIT 1
  ) e ON TRUE
  WHERE m."status" = 'ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM "Epoch" o WHERE o."marketId" = m."id" AND o."state" = 'OPEN')
  ORDER BY m."id" ASC
  LIMIT $1
`;

const INSERT_NEXT_EPOCH = `
  INSERT INTO "Epoch" (
    "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt",
    "onchainStartIndex", "configHash", "ruleVersion", "updatedAt"
  ) VALUES (
    $1, $2, $3::bigint, 'OPEN', to_timestamp($4::bigint / 1000.0),
    to_timestamp($5::bigint / 1000.0), $6, $7, $8, CURRENT_TIMESTAMP
  )
  ON CONFLICT ("marketId", "sequence") DO NOTHING
`;

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SimulatedChainRepositoryError('INVALID_INPUT');
  }
}

function assertId(value: string): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new SimulatedChainRepositoryError('INVALID_INPUT');
  }
}

function sha256Hex(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part, 'utf8').update('\u0000', 'utf8');
  return hash.digest('hex');
}

/**
 * The simulated order-set root: a domain-separated hash over the admitted
 * commitments in leaf order. It stands in for the Compact contract's
 * `closeRoot`, which on a real chain is read from finalized ledger state.
 */
export function simulatedCloseRootV1(epochId: string, commitmentsInLeafOrder: readonly string[]): string {
  return `${SIMULATED_CHAIN_PREFIX}${sha256Hex('lunarveil:simulated-close-root:v1', epochId, ...commitmentsInLeafOrder)}`;
}

/**
 * Development-only stand-in for the Midnight chain.
 *
 * On a real deployment the chain is the integrity source of truth (AGENTS.md
 * rule 5): admissions, the frozen order-set root, the batch proof and the
 * settlement are all read back from finalized ledger state. This repository
 * writes *simulated* equivalents of those facts straight into the database so
 * the rest of the pipeline - the real matcher, the real lifecycle machine,
 * the real API and UI - can be demonstrated without a funded wallet, a prover
 * or a deployed contract. Every value it invents carries
 * `SIMULATED_CHAIN_PREFIX`. The composition that uses it refuses to start
 * outside `development`.
 *
 * It never reads or writes order plaintext or ciphertext.
 */
export class PostgresSimulatedChainRepositoryV1 {
  constructor(private readonly pool: SerializableSqlPool, private readonly newId: () => string = randomUUID) {}

  private async transaction<T>(work: (client: SerializableSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* keep the original error */ }
        throw error;
      }
    } catch (error) {
      if (error instanceof SimulatedChainRepositoryError) throw error;
      throw new SimulatedChainRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  private async read<Row extends Record<string, unknown>>(sql: string, values: readonly (string | number)[]): Promise<readonly Row[]> {
    const client = await this.pool.connect();
    try {
      return (await client.query<Row>(sql, values)).rows;
    } catch {
      throw new SimulatedChainRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  async listPendingAdmissions(limit: number): Promise<readonly SimulatedAdmissionCandidateV1[]> {
    assertLimit(limit);
    const rows = await this.read<{
      id: string; clientRequestId: string; marketId: string; epochId: string;
      commitment: string; sequence: string; marketContractAddress: string;
    }>(SELECT_PENDING, [limit]);
    return rows.map(row => {
      if (!IDENTIFIER.test(row.id) || !IDENTIFIER.test(row.marketId) || !IDENTIFIER.test(row.epochId)
        || !HASH.test(row.commitment) || !DECIMAL.test(row.sequence)) {
        throw new SimulatedChainRepositoryError('INVALID_ROW');
      }
      return {
        orderId: row.id, clientRequestId: row.clientRequestId, marketId: row.marketId, epochId: row.epochId,
        epochSequence: BigInt(row.sequence), contractAddress: row.marketContractAddress, commitment: row.commitment,
      };
    });
  }

  /**
   * Admits one validated order at the next leaf of its still-open epoch. The
   * epoch row lock serializes this with the epoch close pass, so an order is
   * either admitted before the close counts it or not admitted at all.
   */
  async admit(candidate: SimulatedAdmissionCandidateV1): Promise<SimulatedAdmissionOutcomeV1> {
    assertId(candidate.orderId);
    assertId(candidate.epochId);
    return this.transaction(async client => {
      const epoch = (await client.query<{ state: string; maxOrdersPerEpoch: number; accepted: string }>(
        LOCK_OPEN_EPOCH, [candidate.epochId],
      )).rows[0];
      if (epoch === undefined || epoch.state !== 'OPEN') return { outcome: 'SKIPPED' };
      const leafIndex = BigInt(epoch.accepted);
      if (leafIndex >= BigInt(epoch.maxOrdersPerEpoch)) return { outcome: 'EPOCH_FULL' };
      const txId = `${SIMULATED_CHAIN_PREFIX}${sha256Hex('lunarveil:simulated-admission:v1', candidate.epochId, candidate.commitment)}`;
      await client.query(ADMIT, [candidate.orderId, leafIndex.toString(), txId]);
      return { outcome: 'ADMITTED', leafIndex, txId };
    });
  }

  async reject(orderId: string): Promise<void> {
    assertId(orderId);
    await this.transaction(async client => { await client.query(REJECT, [orderId]); });
  }

  async expireStranded(): Promise<void> {
    await this.transaction(async client => { await client.query(EXPIRE_STRANDED, []); });
  }

  /** Records the simulated `closeRoot` for closed epochs. Returns how many were frozen. */
  async freezeClosedEpochs(limit: number): Promise<number> {
    assertLimit(limit);
    const epochs = await this.read<{ id: string }>(SELECT_UNFROZEN, [limit]);
    let frozen = 0;
    for (const { id } of epochs) {
      const done = await this.transaction(async client => {
        const epoch = (await client.query<{ state: string; orderCount: number; closeRoot: string | null }>(
          LOCK_CLOSED_EPOCH, [id],
        )).rows[0];
        if (epoch === undefined || epoch.state !== 'CLOSED' || epoch.closeRoot !== null) return false;
        const admitted = (await client.query<{ commitment: string; leafIndex: string }>(
          SELECT_ADMITTED_COMMITMENTS, [id],
        )).rows;
        // The close pass counted exactly these rows. Anything else means the
        // set moved underneath it: refuse rather than freeze a different set.
        if (admitted.length !== epoch.orderCount
          || admitted.some((row, index) => row.leafIndex !== String(index))) {
          throw new SimulatedChainRepositoryError('INVALID_STATE');
        }
        const root = simulatedCloseRootV1(id, admitted.map(row => row.commitment));
        await client.query(FREEZE, [id, root, String(epoch.orderCount)]);
        return true;
      });
      if (done) frozen += 1;
    }
    return frozen;
  }

  /** Must run only while no other simulator pass can be in flight (under the pass lock). */
  async recoverStalledProving(): Promise<void> {
    await this.transaction(async client => { await client.query(RECOVER_STALLED, []); });
  }

  /**
   * Fail closed: an epoch whose frozen set the matcher rejects is never
   * matched. It is invalidated and its orders expire unfilled.
   */
  async invalidate(epochId: string): Promise<void> {
    assertId(epochId);
    await this.transaction(async client => {
      await client.query(INVALIDATE_EPOCH, [epochId]);
      await client.query(EXPIRE_EPOCH_ORDERS, [epochId]);
    });
  }

  /** Finalizes epochs that closed with no admitted order. */
  async finalizeEmptyEpochs(limit: number): Promise<number> {
    assertLimit(limit);
    const epochs = await this.read<{ id: string }>(SELECT_EMPTY_FROZEN, [limit]);
    for (const { id } of epochs) {
      await this.transaction(async client => {
        await client.query(FINALIZE_EPOCH, [id, null, null, null, 'CLOSED']);
      });
    }
    return epochs.length;
  }

  /**
   * Applies a verified batch outcome: owner-visible order states, the public
   * clearing price and volume, and simulated proof/settlement references.
   * Only public aggregates and per-order state enums are written.
   */
  async finalize(input: SimulatedFinalizationV1): Promise<void> {
    assertId(input.epochId);
    if (!HASH.test(input.solutionCommitment) || input.clearingPriceTicks < 0n || input.totalVolumeLots < 0n
      || !Number.isSafeInteger(input.matchedOrderCount) || input.matchedOrderCount < 0
      || !Number.isSafeInteger(input.rejectedSolutionCount) || input.rejectedSolutionCount < 0) {
      throw new SimulatedChainRepositoryError('INVALID_INPUT');
    }
    await this.transaction(async client => {
      const epoch = (await client.query<{ state: string; pendingSolutionCommitment: string | null; batchCommitment: string | null }>(
        LOCK_MATCHED_EPOCH, [input.epochId],
      )).rows[0];
      const proving = epoch?.state === 'PROVING' && epoch.pendingSolutionCommitment === input.solutionCommitment;
      const replayed = epoch?.state === 'CLOSED' && epoch.batchCommitment === input.solutionCommitment;
      if (epoch === undefined || epoch.batchCommitment !== input.solutionCommitment || (!proving && !replayed)) {
        throw new SimulatedChainRepositoryError('INVALID_STATE');
      }
      const admitted = (await client.query<{ commitment: string }>(SELECT_EPOCH_ORDERS, [input.epochId])).rows;
      if (admitted.length !== input.orderOutcomes.size
        || admitted.some(row => !input.orderOutcomes.has(row.commitment))) {
        throw new SimulatedChainRepositoryError('INVALID_STATE');
      }
      for (const [commitment, outcome] of input.orderOutcomes) {
        await client.query(SET_ORDER_OUTCOME, [input.epochId, commitment, outcome]);
      }
      const proofRef = `${SIMULATED_CHAIN_PREFIX}${sha256Hex('lunarveil:simulated-proof:v1', input.solutionCommitment)}`;
      const settlementRef = `${SIMULATED_CHAIN_PREFIX}${sha256Hex('lunarveil:simulated-settlement:v1', input.solutionCommitment)}`;
      await client.query(FINALIZE_BATCH, [
        input.epochId, proofRef, input.totalVolumeLots.toString(), input.clearingPriceTicks.toString(),
        input.matchedOrderCount, input.rejectedSolutionCount, input.solutionCommitment,
      ]);
      await client.query(FINALIZE_EPOCH, [input.epochId, input.solutionCommitment, proofRef, settlementRef, epoch.state]);
    });
  }

  /**
   * Opens the next epoch for every active market that has none open. The
   * frozen configuration (config hash, rule version) is carried over
   * unchanged, so rolling never alters matching rules mid-stream.
   */
  async rollEpochs(input: { readonly nowMs: bigint; readonly limit: number }): Promise<number> {
    assertLimit(input.limit);
    if (typeof input.nowMs !== 'bigint' || input.nowMs < 0n) throw new SimulatedChainRepositoryError('INVALID_INPUT');
    const markets = await this.read<{
      marketId: string; epochDurationSeconds: number; sequence: string; configHash: string;
      ruleVersion: string; onchainStartIndex: string; orderCount: number;
    }>(SELECT_MARKETS_WITHOUT_OPEN_EPOCH, [input.limit]);
    let opened = 0;
    for (const market of markets) {
      if (!DECIMAL.test(market.sequence) || !DECIMAL.test(market.onchainStartIndex)
        || !Number.isSafeInteger(market.epochDurationSeconds) || market.epochDurationSeconds < 1) {
        throw new SimulatedChainRepositoryError('INVALID_ROW');
      }
      const closeAt = input.nowMs + BigInt(market.epochDurationSeconds) * 1000n;
      const start = BigInt(market.onchainStartIndex) + BigInt(market.orderCount);
      await this.transaction(async client => {
        await client.query(INSERT_NEXT_EPOCH, [
          this.newId(), market.marketId, (BigInt(market.sequence) + 1n).toString(),
          input.nowMs.toString(), closeAt.toString(), start.toString(), market.configHash, market.ruleVersion,
        ]);
      });
      opened += 1;
    }
    return opened;
  }
}
