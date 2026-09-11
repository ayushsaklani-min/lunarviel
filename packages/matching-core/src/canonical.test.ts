import { describe, expect, it } from 'vitest';

import {
  finalizeSolution,
  parseBatchSolution,
  serializeBatchSolution,
  serializeCanonicalSolutionPayload,
  toWireSolution,
} from './canonical.js';
import { clearBatch } from './clearBatch.js';
import { batch, order } from './test-fixtures.js';

describe('canonical batch solution transport', () => {
  const solution = clearBatch(batch([
    order({ commitment: 'buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 10n, limitPriceTicks: 105n }),
    order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: 10n, limitPriceTicks: 100n }),
  ]));

  it('encodes every bigint as a canonical decimal string and round-trips', () => {
    const wire = toWireSolution(solution);
    expect(wire.clearingPriceTicks).toBe('100');
    expect(wire.totalVolumeLots).toBe('10');
    expect(wire.fills.map(fill => fill.filledLots)).toEqual(['10', '10']);
    expect(parseBatchSolution(serializeBatchSolution(solution))).toEqual(solution);
  });

  it('produces the same hash for reordered arrays and object construction', () => {
    const reordered = finalizeSolution({
      configHash: solution.configHash,
      inputRoot: solution.inputRoot,
      removedConstraintViolations: [...solution.removedConstraintViolations].reverse(),
      activeOrderCommitments: [...solution.activeOrderCommitments].reverse(),
      fills: [...solution.fills].reverse(),
      totalVolumeLots: solution.totalVolumeLots,
      clearingPriceTicks: solution.clearingPriceTicks,
      ruleVersion: solution.ruleVersion,
      epochId: solution.epochId,
      marketId: solution.marketId,
      version: 1,
    });

    expect(reordered).toEqual(solution);
    expect(serializeCanonicalSolutionPayload(reordered)).toBe(serializeCanonicalSolutionPayload(solution));
  });

  it('changes the hash when an accepted commitment changes', () => {
    const changed = finalizeSolution({
      ...solution,
      activeOrderCommitments: solution.activeOrderCommitments.map(value => value === 'buy' ? 'buy-changed' : value),
    });
    expect(changed.canonicalSolutionHash).not.toBe(solution.canonicalSolutionHash);
  });

  it('rejects noncanonical decimal strings, unknown fields, and altered hashes', () => {
    const wire = toWireSolution(solution) as unknown as Record<string, unknown>;
    expect(() => parseBatchSolution(JSON.stringify({ ...wire, totalVolumeLots: '010' }))).toThrow('INVALID_TOTALVOLUMELOTS');
    expect(() => parseBatchSolution(JSON.stringify({ ...wire, secret: 'leak' }))).toThrow('INVALID_SOLUTION_FIELD');
    expect(() => parseBatchSolution(JSON.stringify({ ...wire, totalVolumeLots: '11' }))).toThrow('SOLUTION_HASH_MISMATCH');
  });
});
