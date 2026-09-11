export interface MatcherWorkerConfigV1 {
  readonly intervalMs: number;
  readonly batchSize: number;
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

/** Fails closed: a malformed value stops startup rather than defaulting silently. */
export function parseMatcherWorkerConfigV1(env: Env = process.env): MatcherWorkerConfigV1 {
  return {
    // An epoch closes at its scheduled time, so the interval bounds how late
    // that can be. Ten seconds keeps the lag small without polling hard.
    intervalMs: integer(env.LUNARVEIL_MATCHER_INTERVAL_MS, 10_000, 1_000, 3_600_000, 'INVALID_INTERVAL'),
    batchSize: integer(env.LUNARVEIL_MATCHER_BATCH_SIZE, 25, 1, 100, 'INVALID_BATCH_SIZE'),
  };
}
