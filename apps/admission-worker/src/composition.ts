import { Pool } from 'pg';

import { createRedactedLoggerV1, jsonLineSinkV1 } from '@lunarveil/api';
import {
  nodePostgresSerializablePool,
  PostgresAdvisoryLockV1,
  PostgresOrderAdmissionSubmissionRepositoryV1,
} from '@lunarveil/db';
import {
  OrderAdmissionSubmissionWorkerV1,
  type OrderAdmissionChainV1,
  type OrderAdmissionSubmissionRunV1,
} from '@lunarveil/matcher';

import type { AdmissionWorkerConfigV1 } from './config.js';

const EMPTY: OrderAdmissionSubmissionRunV1 = {
  scanned: 0, submitted: 0, alreadyAdmitted: 0, skipped: 0, uncertain: 0, failed: 0,
};

export function composeAdmissionWorkerV1(input: {
  readonly config: AdmissionWorkerConfigV1;
  readonly databaseUrl: string;
  readonly chain: OrderAdmissionChainV1;
  readonly nowMs?: () => bigint;
  readonly logLine?: (line: string) => void;
}) {
  const pool = new Pool({ connectionString: input.databaseUrl, max: 4 });
  const sql = nodePostgresSerializablePool(pool);
  const worker = new OrderAdmissionSubmissionWorkerV1(
    new PostgresOrderAdmissionSubmissionRepositoryV1(sql), input.chain, input.config.batchSize,
  );
  const lock = new PostgresAdvisoryLockV1(sql, 'lunarveil:order-admission-submission');
  const logger = createRedactedLoggerV1({
    sink: jsonLineSinkV1(input.logLine ?? (line => process.stdout.write(`${line}\n`))),
    nowMs: input.nowMs ?? (() => BigInt(Date.now())),
  });

  return {
    async runPass(): Promise<OrderAdmissionSubmissionRunV1> {
      try {
        const outcome = await lock.runExclusively(() => worker.runOnce());
        if (!outcome.ran) {
          logger.log({ level: 'info', event: 'admission.pass_skipped', code: 'LOCK_HELD' });
          return EMPTY;
        }
        const result = outcome.result;
        logger.log({
          level: result.uncertain > 0 || result.failed > 0 ? 'error' : 'info',
          event: 'admission.pass_complete',
          ...(result.uncertain > 0 ? { code: 'UNCERTAIN_OUTCOME' } : result.failed > 0 ? { code: 'PASS_PARTIAL' } : {}),
        });
        return result;
      } catch {
        logger.log({ level: 'error', event: 'admission.pass_failed', code: 'PASS_FAILED' });
        return EMPTY;
      }
    },
    async close(): Promise<void> {
      try { await input.chain.close?.(); } finally { await pool.end(); }
    },
  };
}
