import { createHash } from 'node:crypto';

export interface OracleObservationV1 {
  readonly sourceId: string;
  readonly priceTicks: bigint;
  readonly observedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly payloadHash: string;
}

export interface ReferencePriceSelectionV1 {
  readonly priceTicks: bigint;
  readonly observedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly sourceIds: readonly string[];
  readonly referencePriceHash: string;
}

export class ReferencePriceError extends Error {
  constructor(readonly code: 'INVALID_QUORUM' | 'INVALID_OBSERVATION' | 'DUPLICATE_SOURCE' | 'STALE_ORACLE' | 'NO_QUORUM') {
    super(code);
    this.name = 'ReferencePriceError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;

function assertObservation(observation: OracleObservationV1, evaluationTimeMs: bigint): void {
  if (!IDENTIFIER.test(observation.sourceId) || !HASH.test(observation.payloadHash)
    || observation.priceTicks <= 0n || observation.observedAtMs < 0n || observation.observedAtMs > evaluationTimeMs
    || observation.expiresAtMs <= observation.observedAtMs || observation.expiresAtMs <= evaluationTimeMs) {
    throw new ReferencePriceError('INVALID_OBSERVATION');
  }
}

function canonical(observations: readonly OracleObservationV1[]): string {
  return observations
    .slice()
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map(item => [item.sourceId, item.priceTicks.toString(10), item.observedAtMs.toString(10), item.expiresAtMs.toString(10), item.payloadHash].join('\u0000'))
    .join('\u0001');
}

/**
 * Selects a public reference price from a fresh source quorum. The lower
 * median is used for even quorums to avoid floating-point arithmetic and to
 * make the result byte-identical across runtimes.
 */
export function selectReferencePriceV1(input: {
  readonly observations: readonly OracleObservationV1[];
  readonly evaluationTimeMs: bigint;
  readonly requiredSources: number;
}): ReferencePriceSelectionV1 {
  if (!Number.isSafeInteger(input.requiredSources) || input.requiredSources < 1) {
    throw new ReferencePriceError('INVALID_QUORUM');
  }
  if (input.evaluationTimeMs < 0n) throw new ReferencePriceError('INVALID_OBSERVATION');
  const sorted = input.observations.slice().sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sourceIds: string[] = [];
  for (const observation of sorted) {
    if (sourceIds.at(-1) === observation.sourceId) throw new ReferencePriceError('DUPLICATE_SOURCE');
    sourceIds.push(observation.sourceId);
    try { assertObservation(observation, input.evaluationTimeMs); } catch (error) {
      if (error instanceof ReferencePriceError && observation.expiresAtMs <= input.evaluationTimeMs) continue;
      throw error;
    }
  }
  const fresh = sorted.filter(observation => observation.expiresAtMs > input.evaluationTimeMs);
  if (fresh.length < input.requiredSources) {
    throw new ReferencePriceError(fresh.length === 0 ? 'STALE_ORACLE' : 'NO_QUORUM');
  }
  const byPrice = fresh.slice().sort((left, right) => left.priceTicks < right.priceTicks ? -1 : left.priceTicks > right.priceTicks ? 1 : left.sourceId.localeCompare(right.sourceId));
  const median = byPrice[Math.floor((byPrice.length - 1) / 2)]!;
  const canonicalSet = canonical(fresh);
  const referencePriceHash = createHash('sha256').update(`LUNARVEIL_REFERENCE_PRICE_V1\u0000${canonicalSet}`, 'utf8').digest('hex');
  return {
    priceTicks: median.priceTicks,
    observedAtMs: fresh.reduce((value, item) => item.observedAtMs > value ? item.observedAtMs : value, 0n),
    expiresAtMs: fresh.reduce((value, item) => item.expiresAtMs < value ? item.expiresAtMs : value, fresh[0]!.expiresAtMs),
    sourceIds: fresh.map(item => item.sourceId),
    referencePriceHash,
  };
}
