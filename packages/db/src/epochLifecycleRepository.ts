import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_LIMIT = 100;

export interface DueEpochV1 {
  readonly epochId: string;
  readonly marketId: string;
  readonly sequence: bigint;
  readonly configHash: string;
  readonly ruleVersion: string;
  readonly maxOrders: number;
  readonly tickSizeAtomic: bigint;
  readonly lotSizeAtomic: bigint;
  readonly feeBps: bigint;
  readonly maxPriceCollarBps: bigint | undefined;
  /** Orders actually admitted to the chain, counted at close time. */
  readonly admittedOrderCount: number;
}

export type EpochCloseOutcomeV1 =
  | { readonly outcome: 'CLOSED'; readonly epochId: string; readonly admittedOrderCount: number }
  | { readonly outcome: 'SKIPPED'; readonly epochId: string; readonly reason: 'NOT_OPEN' | 'NOT_DUE' };

export class EpochLifecycleRepositoryError extends Error {
  constructor(readonly code: 'INVALID_LIMIT' | 'INVALID_NOW' | 'INVALID_ROW' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'EpochLifecycleRepositoryError';
  }
}

interface DueEpochRow extends Record<string, unknown> {
  readonly id: string;
  readonly marketId: string;
  readonly sequence: string;
  readonly configHash: string;
  readonly ruleVersion: string;
  readonly maxOrdersPerEpoch: number;
  readonly tickSizeAtomic: string;
  readonly lotSizeAtomic: string;
  readonly feeBps: number;
  readonly maxPriceCollarBps: number | null;
  readonly admittedOrderCount: string;
}

/**
 * Epochs whose scheduled close has passed, oldest first.
 *
 * `admittedOrderCount` counts only `ACCEPTED` orders. An order still in
 * `PENDING_CHAIN` has no confirmed chain admission, so it is not part of the
 * set this epoch closes over — counting it would freeze a root that includes
 * an order the chain may never have accepted.
 */
const SELECT_DUE = `
  SELECT
    e."id", e."marketId", e."sequence"::text AS "sequence", e."configHash", e."ruleVersion",
    m."maxOrdersPerEpoch", m."tickSizeAtomic", m."lotSizeAtomic", m."feeBps", m."maxPriceCollarBps",
    (SELECT COUNT(*) FROM "OrderEnvelope" o
      WHERE o."epochId" = e."id" AND o."state" = 'ACCEPTED')::text AS "admittedOrderCount"
  FROM "Epoch" e
  JOIN "Market" m ON m."id" = e."marketId"
  WHERE e."state" = 'OPEN'
    AND e."scheduledCloseAt" <= to_timestamp($1::bigint / 1000.0)
  ORDER BY e."scheduledCloseAt" ASC, e."id" ASC
  LIMIT $2
`;

const LOCK_EPOCH = `
  SELECT e."id", e."state", e."configHash",
    (SELECT COUNT(*) FROM "OrderEnvelope" o
      WHERE o."epochId" = e."id" AND o."state" = 'ACCEPTED')::text AS "admittedOrderCount"
  FROM "Epoch" e
  WHERE e."id" = $1
    AND e."scheduledCloseAt" <= to_timestamp($2::bigint / 1000.0)
  FOR UPDATE OF e
`;

const CLOSE_EPOCH = `
  UPDATE "Epoch"
  SET "state" = 'CLOSED', "closedAt" = to_timestamp($2::bigint / 1000.0),
      "orderCount" = $3, "updatedAt" = NOW()
  WHERE "id" = $1 AND "state" = 'OPEN'
`;

/**
 * Durable half of the epoch lifecycle.
 *
 * The decision to close is made by the pure `transitionEpochLifecycleV1`
 * state machine; this type only reads candidates and persists the outcome
 * under a serializable transaction. Closing is idempotent: an epoch already
 * past `OPEN` is reported `SKIPPED`, never re-closed, so two workers racing
 * cannot both advance it.
 */
export class PostgresEpochLifecycleRepositoryV1 {
  constructor(private readonly pool: SerializableSqlPool) {}

  async listDueForClose(input: { readonly nowMs: bigint; readonly limit: number }): Promise<readonly DueEpochV1[]> {
    if (typeof input.nowMs !== 'bigint' || input.nowMs < 0n) {
      throw new EpochLifecycleRepositoryError('INVALID_NOW');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
      throw new EpochLifecycleRepositoryError('INVALID_LIMIT');
    }

    let rows: readonly DueEpochRow[];
    const client = await this.pool.connect();
    try {
      const result = await client.query<DueEpochRow>(SELECT_DUE, [input.nowMs.toString(), input.limit]);
      rows = result.rows;
    } catch {
      throw new EpochLifecycleRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }

    return rows.map(row => {
      if (
        typeof row.id !== 'string' || !IDENTIFIER_PATTERN.test(row.id)
        || typeof row.marketId !== 'string' || !IDENTIFIER_PATTERN.test(row.marketId)
        || typeof row.configHash !== 'string' || !HASH_PATTERN.test(row.configHash)
        || typeof row.ruleVersion !== 'string' || !IDENTIFIER_PATTERN.test(row.ruleVersion)
        || typeof row.sequence !== 'string' || !/^[0-9]+$/u.test(row.sequence)
        || !Number.isSafeInteger(row.maxOrdersPerEpoch) || row.maxOrdersPerEpoch < 1
        || typeof row.tickSizeAtomic !== 'string' || !/^[0-9]+$/u.test(row.tickSizeAtomic)
        || typeof row.lotSizeAtomic !== 'string' || !/^[0-9]+$/u.test(row.lotSizeAtomic)
        || !Number.isSafeInteger(row.feeBps) || row.feeBps < 0
        || (row.maxPriceCollarBps !== null && !Number.isSafeInteger(row.maxPriceCollarBps))
        || typeof row.admittedOrderCount !== 'string' || !/^[0-9]+$/u.test(row.admittedOrderCount)
      ) {
        throw new EpochLifecycleRepositoryError('INVALID_ROW');
      }

      return {
        epochId: row.id,
        marketId: row.marketId,
        sequence: BigInt(row.sequence),
        configHash: row.configHash,
        ruleVersion: row.ruleVersion,
        maxOrders: row.maxOrdersPerEpoch,
        tickSizeAtomic: BigInt(row.tickSizeAtomic),
        lotSizeAtomic: BigInt(row.lotSizeAtomic),
        feeBps: BigInt(row.feeBps),
        maxPriceCollarBps: row.maxPriceCollarBps === null ? undefined : BigInt(row.maxPriceCollarBps),
        admittedOrderCount: Number(row.admittedOrderCount),
      };
    });
  }

  /**
   * Closes one epoch, re-checking under the lock.
   *
   * `expectedConfigHash` is the hash the caller made its decision against. If
   * the row's hash changed in between, the frozen parameters that decision
   * used are no longer the epoch's parameters, so the close is refused rather
   * than applied to a different configuration.
   */
  async close(input: {
    readonly epochId: string;
    readonly expectedConfigHash: string;
    readonly nowMs: bigint;
  }): Promise<EpochCloseOutcomeV1> {
    if (typeof input.nowMs !== 'bigint' || input.nowMs < 0n) {
      throw new EpochLifecycleRepositoryError('INVALID_NOW');
    }

    const client: SerializableSqlClient = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      try {
        const locked = await client.query<{ id: string; state: string; configHash: string; admittedOrderCount: string }>(
          LOCK_EPOCH,
          [input.epochId, input.nowMs.toString()],
        );
        const row = locked.rows[0];
        if (row === undefined) {
          await client.query('COMMIT');
          return { outcome: 'SKIPPED', epochId: input.epochId, reason: 'NOT_DUE' };
        }
        if (row.state !== 'OPEN' || row.configHash !== input.expectedConfigHash) {
          await client.query('COMMIT');
          return { outcome: 'SKIPPED', epochId: input.epochId, reason: 'NOT_OPEN' };
        }

        const admittedOrderCount = Number(row.admittedOrderCount);
        if (!Number.isSafeInteger(admittedOrderCount) || admittedOrderCount < 0) {
          throw new EpochLifecycleRepositoryError('INVALID_ROW');
        }

        await client.query(CLOSE_EPOCH, [input.epochId, input.nowMs.toString(), admittedOrderCount]);
        await client.query('COMMIT');
        return { outcome: 'CLOSED', epochId: input.epochId, admittedOrderCount };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original outcome */ }
        if (error instanceof EpochLifecycleRepositoryError) throw error;
        throw new EpochLifecycleRepositoryError('DATABASE_FAILURE');
      }
    } finally {
      client.release();
    }
  }
}
