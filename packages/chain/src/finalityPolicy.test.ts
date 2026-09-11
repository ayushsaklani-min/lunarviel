import { describe, expect, it } from 'vitest';

import { evaluateBlockDepthFinalityV1 } from './finalityPolicy.js';

describe('evaluateBlockDepthFinalityV1', () => {
  it('confirms only at or beyond the configured depth', () => {
    // depth 12 means the tip must be 12 blocks past the inclusion block.
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 111n, confirmationDepth: 12 })).toBe('IMMATURE');
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 112n, confirmationDepth: 12 })).toBe('CONFIRMED');
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 999n, confirmationDepth: 12 })).toBe('CONFIRMED');
  });

  it('treats a depth of zero as immediate confirmation', () => {
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 100n, confirmationDepth: 0 })).toBe('CONFIRMED');
  });

  it('rejects an inclusion ahead of the tip rather than guessing', () => {
    // A tip behind the inclusion means an inconsistent or stale read: never confirm.
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 101n, tipHeight: 100n, confirmationDepth: 12 })).toBe('INVALID');
  });

  it('rejects malformed heights and depths instead of defaulting', () => {
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: -1n, tipHeight: 100n, confirmationDepth: 12 })).toBe('INVALID');
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: -1n, confirmationDepth: 12 })).toBe('INVALID');
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 200n, confirmationDepth: -1 })).toBe('INVALID');
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 200n, confirmationDepth: 1.5 })).toBe('INVALID');
    expect(evaluateBlockDepthFinalityV1({ inclusionHeight: 100n, tipHeight: 200n, confirmationDepth: Number.NaN })).toBe('INVALID');
  });
});
