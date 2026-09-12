import type { SanitizedDependencyState } from '@lunarveil/api';

const PROOF_SERVER_VERSION = '8.1.0';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeDependencyProbeConfigV1 {
  /** Official Midnight indexer GraphQL endpoint; it receives a public tip-only query. */
  readonly indexerUrl?: string;
  /** Controlled proof server base URL. This probe sends no proof payload or witness. */
  readonly proofServerUrl?: string;
}

export interface RuntimeDependencyProbesV1 {
  chainSource(): Promise<SanitizedDependencyState>;
  prover(): Promise<SanitizedDependencyState>;
}

export interface RuntimeDependencyProbeOptionsV1 {
  readonly fetchImpl?: FetchLike;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

function validEndpoint(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function withPath(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReadyStatus(value: unknown): value is { readonly status: 'ok' } {
  return isRecord(value) && value.status === 'ok';
}

/**
 * Cache the sanitized outcome briefly. The public status endpoint must not
 * become a fan-out mechanism for unbounded indexer/prover health traffic.
 */
function cachedProbe(input: {
  readonly execute: () => Promise<SanitizedDependencyState>;
  readonly nowMs: () => number;
  readonly cacheTtlMs: number;
}): () => Promise<SanitizedDependencyState> {
  let cached: { readonly expiresAtMs: number; readonly state: SanitizedDependencyState } | undefined;
  return async () => {
    const now = input.nowMs();
    if (cached !== undefined && now < cached.expiresAtMs) return cached.state;
    const state = await input.execute();
    cached = { state, expiresAtMs: now + input.cacheTtlMs };
    return state;
  };
}

async function fetchResponse(input: {
  readonly fetchImpl: FetchLike;
  readonly url: string;
  readonly init: RequestInit;
  readonly timeoutMs: number;
}): Promise<Response | undefined> {
  try {
    return await input.fetchImpl(input.url, { ...input.init, signal: AbortSignal.timeout(input.timeoutMs) });
  } catch {
    return undefined;
  }
}

async function probeIndexer(input: {
  readonly indexerUrl?: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
}): Promise<SanitizedDependencyState> {
  const indexerUrl = validEndpoint(input.indexerUrl);
  if (indexerUrl === undefined) return 'UNAVAILABLE';
  const response = await fetchResponse({
    fetchImpl: input.fetchImpl,
    url: indexerUrl,
    timeoutMs: input.timeoutMs,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // This asks only for public tip metadata. Never probe with an order,
      // commitment opening, witness or wallet material.
      body: JSON.stringify({ query: '{ block { height } }' }),
    },
  });
  if (response === undefined || !response.ok) return 'DEGRADED';
  try {
    const body: unknown = await response.json();
    const height = isRecord(body) && isRecord(body.data) && isRecord(body.data.block)
      ? body.data.block.height
      : undefined;
    return typeof height === 'number' && Number.isSafeInteger(height) && height >= 0
      ? 'READY'
      : 'DEGRADED';
  } catch {
    return 'DEGRADED';
  }
}

async function probeProofServer(input: {
  readonly proofServerUrl?: string;
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
}): Promise<SanitizedDependencyState> {
  const proofServerUrl = validEndpoint(input.proofServerUrl);
  if (proofServerUrl === undefined) return 'UNAVAILABLE';
  const health = await fetchResponse({
    fetchImpl: input.fetchImpl, url: withPath(proofServerUrl, 'health'), timeoutMs: input.timeoutMs, init: { method: 'GET' },
  });
  const ready = await fetchResponse({
    fetchImpl: input.fetchImpl, url: withPath(proofServerUrl, 'ready'), timeoutMs: input.timeoutMs, init: { method: 'GET' },
  });
  const version = await fetchResponse({
    fetchImpl: input.fetchImpl, url: withPath(proofServerUrl, 'version'), timeoutMs: input.timeoutMs, init: { method: 'GET' },
  });
  if (health === undefined || ready === undefined || version === undefined
    || !health.ok || !ready.ok || !version.ok) return 'DEGRADED';
  try {
    const [healthBody, readyBody, versionBody] = await Promise.all([
      health.json(), ready.json(), version.text(),
    ]);
    return isReadyStatus(healthBody) && isReadyStatus(readyBody) && versionBody.trim() === PROOF_SERVER_VERSION
      ? 'READY'
      : 'DEGRADED';
  } catch {
    return 'DEGRADED';
  }
}

/**
 * Runtime-only dependency checks. Readiness reflects observed capability, not
 * a configured URL: transport errors, malformed replies and version drift all
 * fail closed. KMS is intentionally not included here until an HSM-backed
 * X25519 resolver exists; an HTTP liveness check alone would not make private
 * matcher keys usable.
 */
export function createRuntimeDependencyProbesV1(
  config: RuntimeDependencyProbeConfigV1,
  options: RuntimeDependencyProbeOptionsV1 = {},
): RuntimeDependencyProbesV1 {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const nowMs = options.nowMs ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new Error('INVALID_DEPENDENCY_PROBE_OPTIONS');
  }
  return {
    chainSource: cachedProbe({
      nowMs, cacheTtlMs,
      execute: () => probeIndexer({
        ...(config.indexerUrl === undefined ? {} : { indexerUrl: config.indexerUrl }),
        fetchImpl,
        timeoutMs,
      }),
    }),
    prover: cachedProbe({
      nowMs, cacheTtlMs,
      execute: () => probeProofServer({
        ...(config.proofServerUrl === undefined ? {} : { proofServerUrl: config.proofServerUrl }),
        fetchImpl,
        timeoutMs,
      }),
    }),
  };
}
