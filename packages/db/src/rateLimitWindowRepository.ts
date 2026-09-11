import type { SerializableSqlPool } from './orderEnvelopeRepository.js';

const KEY_PATTERN = /^[\x21-\x7e]{1,256}$/u;
const MAX_WINDOW_MS = 86_400_000n;

export interface RateLimitDecisionV1 {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class RateLimitRepositoryError extends Error {
  constructor(readonly code: 'INVALID_RATE_LIMIT' | 'INVALID_KEY' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'RateLimitRepositoryError';
  }
}

interface WindowRow extends Record<string, unknown> {
  readonly count: number;
  readonly retryAfterMs: string | number;
}

/**
 * One atomic upsert per decision. The database clock is the single authoritative
 * clock, so independent API processes share exactly one window per key. The
 * counter saturates one above the limit, so a sustained flood cannot overflow it.
 */
const CONSUME = `
  INSERT INTO "ApiRateLimitWindow" ("key", "windowStartedAt", "count", "updatedAt")
  VALUES ($1, NOW(), 1, NOW())
  ON CONFLICT ("key") DO UPDATE SET
    "windowStartedAt" = CASE
      WHEN NOW() - "ApiRateLimitWindow"."windowStartedAt" >= $2::bigint * INTERVAL '1 millisecond'
        THEN NOW() ELSE "ApiRateLimitWindow"."windowStartedAt" END,
    "count" = CASE
      WHEN NOW() - "ApiRateLimitWindow"."windowStartedAt" >= $2::bigint * INTERVAL '1 millisecond' THEN 1
      WHEN "ApiRateLimitWindow"."count" > $3::int THEN "ApiRateLimitWindow"."count"
      ELSE "ApiRateLimitWindow"."count" + 1 END,
    "updatedAt" = NOW()
  RETURNING
    "count",
    GREATEST(0, CEIL(EXTRACT(EPOCH FROM
      ("windowStartedAt" + $2::bigint * INTERVAL '1 millisecond') - NOW()) * 1000))::bigint AS "retryAfterMs"
`;

const PRUNE = `
  DELETE FROM "ApiRateLimitWindow"
  WHERE "windowStartedAt" < NOW() - $1::bigint * INTERVAL '1 millisecond'
  RETURNING "key"
`;

/**
 * Durable fixed-window limiter shared across API processes. It stores only an
 * opaque caller-supplied key and a counter; it never sees request bodies,
 * order material, wallet identity or any decrypted value.
 */
export class PostgresRateLimitWindowRepository {
  constructor(
    private readonly pool: SerializableSqlPool,
    private readonly limit: number,
    private readonly windowMs: bigint = 60_000n,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000_000) {
      throw new RateLimitRepositoryError('INVALID_RATE_LIMIT');
    }
    if (typeof windowMs !== 'bigint' || windowMs < 1n || windowMs > MAX_WINDOW_MS) {
      throw new RateLimitRepositoryError('INVALID_RATE_LIMIT');
    }
  }

  /**
   * Fails closed: an invalid key or an unavailable database refuses the request
   * rather than silently removing the limit.
   */
  async consume(key: string): Promise<RateLimitDecisionV1> {
    const fallbackSeconds = Math.max(1, Number((this.windowMs + 999n) / 1_000n));
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      return { allowed: false, retryAfterSeconds: fallbackSeconds };
    }
    const client = await this.pool.connect().catch(() => undefined);
    if (client === undefined) return { allowed: false, retryAfterSeconds: fallbackSeconds };
    try {
      const result = await client.query<WindowRow>(CONSUME, [key, this.windowMs.toString(), this.limit]);
      const row = result.rows[0];
      if (row === undefined || !Number.isSafeInteger(row.count) || row.count < 1) {
        return { allowed: false, retryAfterSeconds: fallbackSeconds };
      }
      if (row.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
      const remainingMs = BigInt(row.retryAfterMs);
      const retryAfterSeconds = Number((remainingMs + 999n) / 1_000n);
      return { allowed: false, retryAfterSeconds: Math.min(fallbackSeconds, Math.max(1, retryAfterSeconds)) };
    } catch {
      return { allowed: false, retryAfterSeconds: fallbackSeconds };
    } finally {
      client.release();
    }
  }

  /** Removes windows that can no longer deny a request. Safe to run on a schedule. */
  async pruneExpired(): Promise<number> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ readonly key: string }>(PRUNE, [(this.windowMs * 2n).toString()]);
      return result.rows.length;
    } catch {
      throw new RateLimitRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }
}
