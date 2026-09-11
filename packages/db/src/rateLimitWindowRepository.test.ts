import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import { PostgresRateLimitWindowRepository, RateLimitRepositoryError } from './rateLimitWindowRepository.js';

function poolReturning(rows: readonly Record<string, unknown>[], onQuery?: (text: string, values: readonly unknown[]) => void): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query(text: string, values: readonly unknown[] = []) {
          onQuery?.(text, values);
          return { rows: rows as never };
        },
        release() { /* pooled */ },
      };
    },
  };
}

const failingPool: SerializableSqlPool = {
  async connect() { throw new Error('connection refused'); },
};

describe('PostgresRateLimitWindowRepository', () => {
  it('rejects an invalid limit or window at construction', () => {
    const pool = poolReturning([]);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => new PostgresRateLimitWindowRepository(pool, limit)).toThrow(RateLimitRepositoryError);
    }
    expect(() => new PostgresRateLimitWindowRepository(pool, 10, 0n)).toThrow(RateLimitRepositoryError);
    expect(() => new PostgresRateLimitWindowRepository(pool, 10, 86_400_001n)).toThrow(RateLimitRepositoryError);
  });

  it('allows a request while the shared counter stays within the limit', async () => {
    let seen: readonly unknown[] = [];
    const limiter = new PostgresRateLimitWindowRepository(
      poolReturning([{ count: 5, retryAfterMs: '30000' }], (_text, values) => { seen = values; }),
      5,
      60_000n,
    );
    expect(await limiter.consume('ip:1.2.3.4:/v1/orders')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(seen).toEqual(['ip:1.2.3.4:/v1/orders', '60000', 5]);
  });

  it('denies and reports the remaining window once the counter passes the limit', async () => {
    const limiter = new PostgresRateLimitWindowRepository(poolReturning([{ count: 6, retryAfterMs: '1500' }]), 5, 60_000n);
    expect(await limiter.consume('ip:1.2.3.4:/v1/orders')).toEqual({ allowed: false, retryAfterSeconds: 2 });
  });

  it('never sends a key it did not validate and fails closed on a malformed key', async () => {
    let queried = false;
    const limiter = new PostgresRateLimitWindowRepository(
      poolReturning([{ count: 1, retryAfterMs: '0' }], () => { queried = true; }),
      5,
      60_000n,
    );
    for (const key of ['', ' ', 'a b', 'key\n', 'x'.repeat(257), 'é']) {
      expect(await limiter.consume(key)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    }
    expect(queried).toBe(false);
  });

  it('fails closed when the database is unavailable or answers unusably', async () => {
    const unavailable = new PostgresRateLimitWindowRepository(failingPool, 5, 60_000n);
    expect(await unavailable.consume('ip:1.2.3.4:/v1/orders')).toEqual({ allowed: false, retryAfterSeconds: 60 });

    for (const rows of [[], [{ count: 0, retryAfterMs: '0' }], [{ count: 'many', retryAfterMs: '0' }]]) {
      const odd = new PostgresRateLimitWindowRepository(poolReturning(rows), 5, 60_000n);
      expect(await odd.consume('ip:1.2.3.4:/v1/orders')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    }
  });

  it('caps the advertised retry hint at one window', async () => {
    const limiter = new PostgresRateLimitWindowRepository(poolReturning([{ count: 9, retryAfterMs: '999999999' }]), 5, 60_000n);
    expect(await limiter.consume('ip:1.2.3.4:/v1/orders')).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});
