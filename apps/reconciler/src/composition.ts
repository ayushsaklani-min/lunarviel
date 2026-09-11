import { Pool } from 'pg';

import { createRedactedLoggerV1, jsonLineSinkV1 } from '@lunarveil/api';
import {
  MidnightIndexerAdmissionSourceV1,
  ReorgRecheckServiceV1,
  type ChainLedgerReaderV1,
} from '@lunarveil/chain';
import {
  ChainAdmissionReconciliationServiceV1,
  ChainAdmissionReconciliationWorkerV1,
} from '@lunarveil/matcher';
import {
  PostgresAcceptedAdmissionSourceV1,
  PostgresAdvisoryLockV1,
  PostgresChainAdmissionReconciliationRepository,
  PostgresPendingChainOrderSourceV1,
  nodePostgresSerializablePool,
  type SerializableSqlPool,
} from '@lunarveil/db';

import type { ReconcilerConfigV1 } from './config.js';

export interface ReconcilerPassResultV1 {
  readonly ran: boolean;
  readonly scanned: number;
  readonly accepted: number;
  readonly paused: number;
  readonly pending: number;
  readonly failed: number;
  readonly revoked: number;
}

export interface ComposedReconcilerV1 {
  runPass(): Promise<ReconcilerPassResultV1>;
  close(): Promise<void>;
}

const LOCK_NAME = 'lunarveil:chain-admission-reconciler';

/**
 * Wires the chain source, consensus worker and reorg re-check over one pool.
 * The chain reader is injected so integration tests can drive a deterministic
 * fake without a network. A reader that itself needs database access — the
 * contract-action reader resolves markets to contract addresses — is passed as
 * a factory instead, so it shares this pool rather than opening a second one.
 */
export function composeReconcilerV1(input: {
  readonly config: ReconcilerConfigV1;
  readonly databaseUrl: string;
  readonly reader: ChainLedgerReaderV1 | ((deps: { readonly pool: SerializableSqlPool }) => ChainLedgerReaderV1);
  readonly nowMs?: () => bigint;
  readonly logLine?: (line: string) => void;
  readonly poolMax?: number;
}): ComposedReconcilerV1 {
  const { config } = input;
  const poolMax = input.poolMax ?? 4;
  // The advisory lock holds one client from this same pool for the whole
  // duration of the enclosed work, which itself needs at least one more
  // client to run its queries. poolMax: 1 would deadlock every pass forever.
  if (!Number.isSafeInteger(poolMax) || poolMax < 2) {
    throw new Error('INVALID_POOL_MAX');
  }
  const pool = new Pool({ connectionString: input.databaseUrl, max: poolMax });
  const serializable = nodePostgresSerializablePool(pool);
  const logger = createRedactedLoggerV1({
    sink: jsonLineSinkV1(input.logLine ?? (line => process.stdout.write(`${line}\n`))),
    nowMs: input.nowMs ?? (() => BigInt(Date.now())),
  });

  const reader = typeof input.reader === 'function' ? input.reader({ pool: serializable }) : input.reader;

  const worker = new ChainAdmissionReconciliationWorkerV1(
    new PostgresPendingChainOrderSourceV1(serializable),
    [new MidnightIndexerAdmissionSourceV1(`indexer:${config.network}`, reader, {
      confirmationDepth: config.confirmationDepth,
    })],
    new ChainAdmissionReconciliationServiceV1(new PostgresChainAdmissionReconciliationRepository(serializable)),
    { batchSize: config.batchSize, requiredMatchingSources: config.requiredMatchingSources },
  );

  const acceptedSource = new PostgresAcceptedAdmissionSourceV1(serializable);
  const recheck = new ReorgRecheckServiceV1(reader, { confirmationDepth: config.confirmationDepth });
  const lock = new PostgresAdvisoryLockV1(serializable, LOCK_NAME);

  return {
    async runPass(): Promise<ReconcilerPassResultV1> {
      const empty: ReconcilerPassResultV1 = {
        ran: false, scanned: 0, accepted: 0, paused: 0, pending: 0, failed: 0, revoked: 0,
      };
      try {
        const outcome = await lock.runExclusively(async () => {
          const run = await worker.runOnce();

          // A failure in the reorg re-check (a second, independent read path)
          // must never discard the genuine acceptance counts `worker.runOnce()`
          // already committed. It gets its own try/catch so a thrown scan or
          // recheck failure here degrades to "no revocations observed this
          // pass" plus its own sanitized log line, rather than making the
          // whole pass look like it never ran.
          let revoked = 0;
          try {
            const accepted = await acceptedSource.listRecentlyAccepted({
              limit: config.batchSize, lookbackMs: config.reorgLookbackMs,
            });
            for (const record of accepted) {
              if (await recheck.check(record) !== 'REVOKED') continue;
              revoked += 1;
              // Order state is deliberately unchanged; this alerts an operator.
              logger.log({ level: 'error', event: 'chain.admission_revoked', code: 'ADMISSION_REVOKED' });
            }
          } catch {
            logger.log({ level: 'error', event: 'chain.recheck_failed', code: 'RECHECK_FAILED' });
          }
          return { run, revoked };
        });

        if (!outcome.ran) {
          logger.log({ level: 'info', event: 'chain.pass_skipped', code: 'LOCK_HELD' });
          return empty;
        }

        const { run, revoked } = outcome.result;
        logger.log({ level: run.failed > 0 ? 'warn' : 'info', event: 'chain.pass_complete' });
        return {
          ran: true,
          scanned: run.scanned, accepted: run.accepted, paused: run.paused,
          pending: run.pending, failed: run.failed, revoked,
        };
      } catch {
        // A catastrophic failure before or during worker.runOnce() (e.g. the
        // pending-order scan itself throwing) must never propagate silently.
        // It changes no order state and never carries the underlying error
        // message, which can hold a connection string; it only reports that a
        // pass failed so an operator can alert on the count. The next
        // scheduled pass still runs.
        logger.log({ level: 'error', event: 'chain.pass_failed', code: 'PASS_FAILED' });
        return empty;
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
