export interface SimulatedChainConfigV1 {
  /** 32 bytes of hex shared with the API server (`LUNARVEIL_DEV_MATCHER_KEY_SEED`). */
  readonly matcherKeySeedHex: string;
  readonly maliciousMatcher: boolean;
}

export interface MatcherWorkerConfigV1 {
  readonly intervalMs: number;
  readonly batchSize: number;
  /** Present only when the development-only simulated chain is enabled. */
  readonly simulatedChain?: SimulatedChainConfigV1;
}

export class MatcherWorkerConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MatcherWorkerConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function integer(value: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new MatcherWorkerConfigError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new MatcherWorkerConfigError(code);
  return parsed;
}

function flag(value: string | undefined, code: string): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new MatcherWorkerConfigError(code);
}

/**
 * The simulated chain writes invented admissions, roots, proofs and
 * settlements. It is refused unless the environment is explicitly
 * `development`, and it needs the shared development matcher key seed.
 */
function simulatedChain(env: Env): SimulatedChainConfigV1 | undefined {
  const enabled = flag(env.LUNARVEIL_SIMULATED_CHAIN, 'INVALID_SIMULATED_CHAIN');
  const maliciousMatcher = flag(env.LUNARVEIL_DEMO_MALICIOUS_MATCHER, 'INVALID_MALICIOUS_MATCHER');
  if (!enabled) {
    if (maliciousMatcher) throw new MatcherWorkerConfigError('MALICIOUS_MATCHER_REQUIRES_SIMULATED_CHAIN');
    return undefined;
  }
  if (env.LUNARVEIL_ENV !== 'development') throw new MatcherWorkerConfigError('SIMULATED_CHAIN_REQUIRES_DEVELOPMENT');
  const seed = env.LUNARVEIL_DEV_MATCHER_KEY_SEED;
  if (seed === undefined || !/^(?:[0-9a-fA-F]{2}){32}$/u.test(seed)) {
    throw new MatcherWorkerConfigError('SIMULATED_CHAIN_REQUIRES_MATCHER_KEY_SEED');
  }
  return { matcherKeySeedHex: seed, maliciousMatcher };
}

/** Fails closed: a malformed value stops startup rather than defaulting silently. */
export function parseMatcherWorkerConfigV1(env: Env = process.env): MatcherWorkerConfigV1 {
  const simulated = simulatedChain(env);
  return {
    ...(simulated === undefined ? {} : { simulatedChain: simulated }),
    // An epoch closes at its scheduled time, so the interval bounds how late
    // that can be. Ten seconds keeps the lag small without polling hard.
    intervalMs: integer(env.LUNARVEIL_MATCHER_INTERVAL_MS, 10_000, 1_000, 3_600_000, 'INVALID_INTERVAL'),
    batchSize: integer(env.LUNARVEIL_MATCHER_BATCH_SIZE, 25, 1, 100, 'INVALID_BATCH_SIZE'),
  };
}
