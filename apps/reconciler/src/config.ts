export interface ReconcilerConfigV1 {
  readonly network: 'preview' | 'preprod';
  readonly indexerUrl: string;
  readonly indexerWsUrl: string;
  readonly confirmationDepth: number;
  readonly requiredMatchingSources: number;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly reorgLookbackMs: number;
}

export class ReconcilerConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReconcilerConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function integer(value: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new ReconcilerConfigError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ReconcilerConfigError(code);
  return parsed;
}

function url(value: string | undefined, protocol: string, code: string): string {
  if (typeof value !== 'string' || value === '') throw new ReconcilerConfigError(code);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== protocol || parsed.username || parsed.password) throw new Error('invalid');
    return parsed.toString();
  } catch {
    throw new ReconcilerConfigError(code);
  }
}

/** Fails closed: a malformed value stops startup rather than defaulting silently. */
export function parseReconcilerConfigV1(env: Env = process.env): ReconcilerConfigV1 {
  const network = env.LUNARVEIL_CHAIN_NETWORK;
  if (network !== 'preview' && network !== 'preprod') throw new ReconcilerConfigError('INVALID_CHAIN_NETWORK');
  return {
    network,
    indexerUrl: url(env.LUNARVEIL_INDEXER_URL, 'https:', 'INVALID_INDEXER_URL'),
    indexerWsUrl: url(env.LUNARVEIL_INDEXER_WS_URL, 'wss:', 'INVALID_INDEXER_WS_URL'),
    // A depth of 0 accepts on first inclusion with no finality wait at all.
    // evaluateBlockDepthFinalityV1 itself still treats 0 as meaningful at the
    // pure-policy level; this floor only prevents the reconciler from ever
    // being configured to disable finality entirely.
    confirmationDepth: integer(env.LUNARVEIL_CHAIN_CONFIRMATION_DEPTH, 12, 1, 100_000, 'INVALID_CONFIRMATION_DEPTH'),
    requiredMatchingSources: integer(env.LUNARVEIL_CHAIN_REQUIRED_SOURCES, 1, 1, 16, 'INVALID_REQUIRED_SOURCES'),
    intervalMs: integer(env.LUNARVEIL_RECONCILER_INTERVAL_MS, 30_000, 1_000, 3_600_000, 'INVALID_INTERVAL'),
    batchSize: integer(env.LUNARVEIL_RECONCILER_BATCH_SIZE, 100, 1, 1_000, 'INVALID_BATCH_SIZE'),
    reorgLookbackMs: integer(env.LUNARVEIL_REORG_RECHECK_LOOKBACK_MS, 3_600_000, 1_000, 86_400_000, 'INVALID_REORG_LOOKBACK'),
  };
}
