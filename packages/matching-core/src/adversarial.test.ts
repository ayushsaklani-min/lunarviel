import { describe, expect, it } from 'vitest';

import { finalizeSolution } from './canonical.js';
import { clearBatch, verifyBatchSolution } from './clearBatch.js';
import { batch, order } from './test-fixtures.js';
import type { BatchSolutionPayloadV1, BatchSolutionV1 } from './types.js';

function rehash(solution: BatchSolutionV1, changes: Partial<BatchSolutionPayloadV1>): BatchSolutionV1 {
  return finalizeSolution({
    version: 1,
    marketId: solution.marketId,
    epochId: solution.epochId,
    ruleVersion: solution.ruleVersion,
    clearingPriceTicks: solution.clearingPriceTicks,
    totalVolumeLots: solution.totalVolumeLots,
    fills: solution.fills,
    activeOrderCommitments: solution.activeOrderCommitments,
    removedConstraintViolations: solution.removedConstraintViolations,
    inputRoot: solution.inputRoot,
    configHash: solution.configHash,
    ...(solution.referencePriceHash === undefined ? {} : { referencePriceHash: solution.referencePriceHash }),
    ...changes,
  });
}

describe('malicious matcher fixtures', () => {
  const input = batch([
    order({ commitment: 'buy-better', traderTag: 'trader-a', side: 'BUY', quantityLots: 5n, limitPriceTicks: 110n }),
    order({ commitment: 'buy-worse', traderTag: 'trader-b', side: 'BUY', quantityLots: 5n, limitPriceTicks: 100n }),
    order({ commitment: 'sell', traderTag: 'trader-c', side: 'SELL', quantityLots: 5n, limitPriceTicks: 90n }),
  ]);
  const valid = clearBatch(input);

  it('accepts only the exact reference solution', () => {
    expect(verifyBatchSolution(input, valid)).toBe(true);
  });

  it.each([
    ['omitted accepted order', () => rehash(valid, { activeOrderCommitments: ['buy-better', 'sell'] })],
    ['manipulated clearing price', () => rehash(valid, { clearingPriceTicks: valid.clearingPriceTicks + 1n })],
    ['worse-price priority', () => rehash(valid, {
      fills: [
        { orderCommitment: 'buy-worse', filledLots: 5n },
        { orderCommitment: 'sell', filledLots: 5n },
      ],
    })],
    ['overfill', () => rehash(valid, {
      totalVolumeLots: 6n,
      fills: [
        { orderCommitment: 'buy-better', filledLots: 6n },
        { orderCommitment: 'sell', filledLots: 6n },
      ],
    })],
    ['fake commitment', () => rehash(valid, {
      fills: [
        { orderCommitment: 'fake-order', filledLots: 5n },
        { orderCommitment: 'sell', filledLots: 5n },
      ],
    })],
  ])('rejects %s even when the attacker recomputes the SHA-256 hash', (_name, mutate) => {
    expect(verifyBatchSolution(input, mutate())).toBe(false);
  });

  it('rejects a partial FOK allocation with a recomputed hash', () => {
    const fokInput = batch([
      order({ commitment: 'fok-buy', traderTag: 'trader-a', side: 'BUY', quantityLots: 5n, limitPriceTicks: 100n, tif: 'FOK', allowPartial: false }),
      order({ commitment: 'sell', traderTag: 'trader-b', side: 'SELL', quantityLots: 5n, limitPriceTicks: 100n }),
    ]);
    const fokValid = clearBatch(fokInput);
    const malicious = rehash(fokValid, {
      totalVolumeLots: 2n,
      fills: [
        { orderCommitment: 'fok-buy', filledLots: 2n },
        { orderCommitment: 'sell', filledLots: 2n },
      ],
    });
    expect(verifyBatchSolution(fokInput, malicious)).toBe(false);
  });
});
