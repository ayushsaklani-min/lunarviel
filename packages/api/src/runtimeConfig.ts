export type LunarveilRuntimeEnvironmentV1 = 'development' | 'staging' | 'production';

export interface LunarveilRuntimeConfigV1 {
  readonly environment: LunarveilRuntimeEnvironmentV1;
  readonly host: string;
  readonly port: number;
  readonly bodyLimitBytes: number;
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: boolean;
}

export interface RateLimitDecisionV1 {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

/** Small in-memory fixed-window limiter for one API process. */
export class InMemoryRateLimiterV1 {
  private readonly windows = new Map<string, { readonly startedAtMs: bigint; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: bigint = 60_000n) {
    if (!Number.isSafeInteger(limit) || limit < 1 || windowMs < 1n) throw new Error('INVALID_RATE_LIMIT');
  }

  consume(key: string, nowMs: bigint): RateLimitDecisionV1 {
    if (!key || nowMs < 0n) return { allowed: false, retryAfterSeconds: 60 };
    const current = this.windows.get(key);
    if (current === undefined || nowMs - current.startedAtMs >= this.windowMs) {
      this.windows.set(key, { startedAtMs: nowMs, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= this.limit) {
      const remainingMs = this.windowMs - (nowMs - current.startedAtMs);
      return { allowed: false, retryAfterSeconds: Math.max(1, Number((remainingMs + 999n) / 1_000n)) };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export class LunarveilRuntimeConfigError extends Error {
  constructor(readonly code: 'INVALID_ENVIRONMENT' | 'INVALID_HOST' | 'INVALID_PORT' | 'INVALID_ORIGINS' | 'PRODUCTION_CONFIG_INCOMPLETE') {
    super(code);
    this.name = 'LunarveilRuntimeConfigError';
  }
}

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function environment(value: string | undefined): LunarveilRuntimeEnvironmentV1 {
  if (value === undefined || value === '') return 'development';
  if (value === 'development' || value === 'staging' || value === 'production') return value;
  throw new LunarveilRuntimeConfigError('INVALID_ENVIRONMENT');
}

function port(value: string | undefined): number {
  if (value === undefined || value === '') return 4_000;
  if (!/^[0-9]+$/u.test(value)) throw new LunarveilRuntimeConfigError('INVALID_PORT');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new LunarveilRuntimeConfigError('INVALID_PORT');
  return parsed;
}

function origins(value: string | undefined, current: LunarveilRuntimeEnvironmentV1): readonly string[] {
  const values = (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (current !== 'development' && values.length === 0) throw new LunarveilRuntimeConfigError('INVALID_ORIGINS');
  return [...new Set(values.map(item => {
    try {
      const url = new URL(item);
      // Plaintext http is allowed only for a loopback host, and only in
      // development. Without this a local frontend on http://127.0.0.1 cannot
      // be allowlisted at all, so the browser UI is unreachable in
      // development while every non-browser client still works. Production
      // stays https-only. See ADR-0040.
      const loopbackDevelopment = current === 'development'
        && url.protocol === 'http:'
        && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
      if ((url.protocol !== 'https:' && !loopbackDevelopment)
        || url.username || url.password || url.search || url.hash
        || url.pathname !== '/' || /\s/u.test(item)) throw new Error('Invalid origin');
      return url.origin;
    } catch { throw new LunarveilRuntimeConfigError('INVALID_ORIGINS'); }
  }))];
}

/** Parses deployment settings without returning any secret-bearing env value. */
export function parseLunarveilRuntimeConfigV1(env: RuntimeEnv = process.env): LunarveilRuntimeConfigV1 {
  const current = environment(env.LUNARVEIL_ENV);
  const configuredOrigins = origins(env.LUNARVEIL_ALLOWED_ORIGINS, current);
  if (current === 'production') {
    const required = ['LUNARVEIL_DATABASE_URL', 'LUNARVEIL_KMS_PROVIDER', 'LUNARVEIL_CHAIN_NETWORK'];
    if (required.some(key => typeof env[key] !== 'string' || env[key]!.trim() === '')) {
      throw new LunarveilRuntimeConfigError('PRODUCTION_CONFIG_INCOMPLETE');
    }
  }
  const host = env.LUNARVEIL_API_HOST ?? '127.0.0.1';
  if (!/^[A-Za-z0-9.:-]+$/u.test(host) || host.length > 255) throw new LunarveilRuntimeConfigError('INVALID_HOST');
  return {
    environment: current,
    host,
    port: port(env.LUNARVEIL_API_PORT),
    bodyLimitBytes: 64 * 1024,
    allowedOrigins: configuredOrigins,
    trustProxy: env.LUNARVEIL_TRUST_PROXY === 'true',
  };
}
