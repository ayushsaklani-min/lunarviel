import { describe, expect, it } from 'vitest';

import { ReferencePriceError, selectReferencePriceV1, type OracleObservationV1 } from './referencePrice.js';

const now = 1_000n;
const observation = (sourceId: string, priceTicks: bigint, overrides: Partial<OracleObservationV1> = {}): OracleObservationV1 => ({
  sourceId, priceTicks, observedAtMs: 900n, expiresAtMs: 1_100n, payloadHash: (sourceId.charCodeAt(0).toString(16).padStart(2, '0')).repeat(32), ...overrides,
});

describe('reference price selector V1', () => {
  it('selects a deterministic lower median and canonical public hash', () => {
    const result = selectReferencePriceV1({
      observations: [observation('source-b', 120n), observation('source-a', 100n), observation('source-c', 110n), observation('source-d', 130n)],
      evaluationTimeMs: now, requiredSources: 3,
    });
    expect(result.priceTicks).toBe(110n);
    expect(result.sourceIds).toEqual(['source-a', 'source-b', 'source-c', 'source-d']);
    expect(result.referencePriceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.expiresAtMs).toBe(1_100n);
  });

  it('fails closed for stale data, insufficient fresh quorum and duplicate sources', () => {
    expect(() => selectReferencePriceV1({ observations: [observation('source-a', 100n, { expiresAtMs: 999n })], evaluationTimeMs: now, requiredSources: 1 })).toThrowError(new ReferencePriceError('STALE_ORACLE'));
    expect(() => selectReferencePriceV1({ observations: [observation('source-a', 100n)], evaluationTimeMs: now, requiredSources: 2 })).toThrowError(new ReferencePriceError('NO_QUORUM'));
    expect(() => selectReferencePriceV1({ observations: [observation('source-a', 100n), observation('source-a', 101n)], evaluationTimeMs: now, requiredSources: 1 })).toThrowError(new ReferencePriceError('DUPLICATE_SOURCE'));
  });

  it('rejects invalid prices, future observations and malformed hashes', () => {
    expect(() => selectReferencePriceV1({ observations: [observation('source-a', 0n)], evaluationTimeMs: now, requiredSources: 1 })).toThrowError(new ReferencePriceError('INVALID_OBSERVATION'));
    expect(() => selectReferencePriceV1({ observations: [observation('source-a', 1n, { observedAtMs: 1_001n })], evaluationTimeMs: now, requiredSources: 1 })).toThrowError(new ReferencePriceError('INVALID_OBSERVATION'));
    expect(() => selectReferencePriceV1({ observations: [observation('source-a', 1n, { payloadHash: 'bad' })], evaluationTimeMs: now, requiredSources: 1 })).toThrowError(new ReferencePriceError('INVALID_OBSERVATION'));
  });
});
