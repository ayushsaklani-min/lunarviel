import { Pool } from 'pg';

import { createRedactedLoggerV1, jsonLineSinkV1 } from '@lunarveil/api';
import {
  PostgresAdvisoryLockV1,
  PostgresClosedEpochBatchRepositoryV1,
  PostgresEpochLifecycleRepositoryV1,
  PostgresOrderEnvelopeRepository,
  PostgresSimulatedChainRepositoryV1,
  nodePostgresSerializablePool,
} from '@lunarveil/db';
import {
  EpochCloseServiceV1,
  M3AdmissionPreflightV1,
  SimulatedChainServiceV1,
  type EpochClosePassResultV1,
  type MatcherKeyResolverV1,
} from '@lunarveil/matcher';

import type { MatcherWorkerConfigV1 } from './config.js';

export interface ComposedMatcherWorkerV1 {
  runPass(): Promise<EpochClosePassResultV1>;
  close(): Promise<void>;
}

const LOCK_NAME = 'lunarveil:epoch-lifecycle';

const EMPTY: EpochClosePassResultV1 = { scanned: 0, closed: 0, skipped: 0, refused: 0 };

/**
 * Wires the epoch close pass over one pool.
 *
 * The pass runs under a session-scoped advisory lock so replicas do not
 * duplicate the scan. That is an efficiency measure, not the safety one: the
 * repository re-checks state and config hash under a row lock, so correctness
 * does not depend on the advisory lock being held.
 */
export function composeMatcherWorkerV1(input: {
  readonly config: MatcherWorkerConfigV1;
  readonly databaseUrl: string;
  readonly nowMs?: () => bigint;
  readonly logLine?: (line: string) => void;
  readonly poolMax?: number;
  /** Required exactly when `config.simulatedChain` is set. */
  readonly simulatedChainKeys?: MatcherKeyResolverV1;
}): ComposedMatcherWorkerV1 {
  if ((input.config.simulatedChain === undefined) !== (input.simulatedChainKeys === undefined)) {
    throw new Error('SIMULATED_CHAIN_KEYS_MISMATCH');
  }
  const poolMax = input.poolMax ?? 4;
  // The advisory lock holds one client for the whole enclosed pass, which
  // itself needs at least one more to do any work.
  if (!Number.isSafeInteger(poolMax) || poolMax < 2) throw new Error('INVALID_POOL_MAX');

  const nowMs = input.nowMs ?? (() => BigInt(Date.now()));
  const pool = new Pool({ connectionString: input.databaseUrl, max: poolMax });
  const serializable = nodePostgresSerializablePool(pool);
  const logger = createRedactedLoggerV1({
    sink: jsonLineSinkV1(input.logLine ?? (line => process.stdout.write(`${line}\n`))),
    nowMs,
  });

  const service = new EpochCloseServiceV1(
    new PostgresEpochLifecycleRepositoryV1(serializable),
    { nowMs, batchSize: input.config.batchSize },
  );
  const lock = new PostgresAdvisoryLockV1(serializable, LOCK_NAME);

  // Development-only: plays the chain's part so the lifecycle completes.
  const simulator = input.config.simulatedChain === undefined ? undefined : new SimulatedChainServiceV1({
    store: new PostgresSimulatedChainRepositoryV1(serializable),
    batches: new PostgresClosedEpochBatchRepositoryV1(serializable),
    preflight: new M3AdmissionPreflightV1(new PostgresOrderEnvelopeRepository(serializable), input.simulatedChainKeys!, nowMs),
    keys: input.simulatedChainKeys!,
    nowMs,
    maliciousMatcher: input.config.simulatedChain.maliciousMatcher,
    batchSize: input.config.batchSize,
    onEvent: event => logger.log({
      level: event.event === 'simulated.malicious_solution_rejected' || event.event === 'simulated.epoch_invalidated' ? 'warn' : 'info',
      event: event.event,
    }),
  });

  return {
    async runPass(): Promise<EpochClosePassResultV1> {
      try {
        const outcome = await lock.runExclusively(async () => {
          const closed = await service.runOnce();
          if (simulator !== undefined) {
            try {
              await simulator.runOnce();
            } catch {
              logger.log({ level: 'error', event: 'simulated.pass_failed', code: 'SIMULATED_PASS_FAILED' });
            }
          }
          return closed;
        });
        if (!outcome.ran) {
          logger.log({ level: 'info', event: 'epoch.pass_skipped', code: 'LOCK_HELD' });
          return EMPTY;
        }
        const result = outcome.result;
        if (result.refused > 0) {
          // An epoch the state machine refuses to close stays OPEN. That is
          // safe but needs an operator's attention, so it is logged loudly.
          logger.log({ level: 'error', event: 'epoch.close_refused', code: 'EPOCH_CLOSE_REFUSED' });
        }
        logger.log({ level: 'info', event: 'epoch.pass_complete' });
        return result;
      } catch {
        // Never carry the underlying error: it can hold a connection string.
        logger.log({ level: 'error', event: 'epoch.pass_failed', code: 'PASS_FAILED' });
        return EMPTY;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
