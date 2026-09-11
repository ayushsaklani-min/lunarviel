import { createHash } from 'node:crypto';

import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

const LOCK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type AdvisoryLockOutcomeV1<T> =
  | { readonly ran: true; readonly result: T }
  | { readonly ran: false };

export class AdvisoryLockError extends Error {
  constructor(readonly code: 'INVALID_LOCK_NAME' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'AdvisoryLockError';
  }
}

/** Stable signed 64-bit key derived from the lock name. */
function lockKey(name: string): string {
  const digest = createHash('sha256').update(`LUNARVEIL_ADVISORY_LOCK_V1 ${name}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}

/**
 * Session-scoped advisory lock. The lock and its release must happen on the
 * same connection, so one client is held for the duration of the work.
 * A lock held elsewhere is not an error: the pass is simply skipped.
 */
export class PostgresAdvisoryLockV1 {
  private readonly key: string;

  constructor(private readonly pool: SerializableSqlPool, lockName: string) {
    if (typeof lockName !== 'string' || !LOCK_NAME_PATTERN.test(lockName)) {
      throw new AdvisoryLockError('INVALID_LOCK_NAME');
    }
    this.key = lockKey(lockName);
  }

  async runExclusively<T>(work: () => Promise<T>): Promise<AdvisoryLockOutcomeV1<T>> {
    const client = await this.pool.connect();
    let held = false;
    try {
      const acquired = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS "locked"', [this.key]);
      if (acquired.rows[0]?.locked !== true) return { ran: false };
      held = true;
      return { ran: true, result: await work() };
    } finally {
      if (held) {
        // Never let an unlock failure mask the original outcome.
        try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [this.key]); } catch { /* released on disconnect */ }
      }
      client.release();
    }
  }
}
