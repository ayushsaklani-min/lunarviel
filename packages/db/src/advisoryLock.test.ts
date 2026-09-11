import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import { PostgresAdvisoryLockV1 } from './advisoryLock.js';

function lockPool(acquired: boolean, log: string[] = []): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query(text: string) {
          log.push(text.trim().split('\n')[0]!.trim());
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: acquired }] as never };
          return { rows: [] as never };
        },
        release() { log.push('RELEASE'); },
      };
    },
  };
}

describe('PostgresAdvisoryLockV1', () => {
  it('runs the work and releases the lock when it is acquired', async () => {
    const log: string[] = [];
    const lock = new PostgresAdvisoryLockV1(lockPool(true, log), 'lunarveil:reconciler');
    const outcome = await lock.runExclusively(async () => 'done');
    expect(outcome).toEqual({ ran: true, result: 'done' });
    expect(log.some(entry => entry.includes('pg_advisory_unlock'))).toBe(true);
    expect(log.at(-1)).toBe('RELEASE');
  });

  it('skips the work when the lock is held elsewhere', async () => {
    let ran = false;
    const lock = new PostgresAdvisoryLockV1(lockPool(false), 'lunarveil:reconciler');
    const outcome = await lock.runExclusively(async () => { ran = true; return 'done'; });
    expect(outcome).toEqual({ ran: false });
    expect(ran).toBe(false);
  });

  it('releases the lock even when the work throws', async () => {
    const log: string[] = [];
    const lock = new PostgresAdvisoryLockV1(lockPool(true, log), 'lunarveil:reconciler');
    await expect(lock.runExclusively(async () => { throw new Error('pass failed'); })).rejects.toThrow('pass failed');
    expect(log.some(entry => entry.includes('pg_advisory_unlock'))).toBe(true);
    expect(log.at(-1)).toBe('RELEASE');
  });

  it('rejects a malformed lock name', () => {
    expect(() => new PostgresAdvisoryLockV1(lockPool(true), '')).toThrow();
    expect(() => new PostgresAdvisoryLockV1(lockPool(true), 'x'.repeat(129))).toThrow();
  });
});
