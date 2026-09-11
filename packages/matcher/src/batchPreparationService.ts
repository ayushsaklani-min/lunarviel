import type {
  BeginProvingOutcomeV1,
  ClosedEpochBatchCandidateV1,
  ClosedEpochEncryptedOrderV1,
} from '@lunarveil/db';

import {
  prepareClosedEpochBatchV1,
  type ClosedEpochMatchingContextV1,
  type MatcherKeyResolverV1,
  type PreparedClosedEpochBatchV1,
} from './closedEpochMatching.js';

export interface ClosedEpochBatchStoreV1 {
  listReady(limit: number): Promise<readonly ClosedEpochBatchCandidateV1[]>;
  loadFrozenOrders(epochId: string): Promise<readonly ClosedEpochEncryptedOrderV1[]>;
  beginProving(input: {
    readonly candidate: ClosedEpochBatchCandidateV1;
    readonly solution: PreparedClosedEpochBatchV1['solution'];
  }): Promise<BeginProvingOutcomeV1>;
}

export interface BatchPreparationRunV1 {
  readonly scanned: number;
  readonly started: number;
  readonly replayed: number;
  readonly rejected: number;
  readonly failed: number;
}

function context(candidate: ClosedEpochBatchCandidateV1): ClosedEpochMatchingContextV1 {
  return candidate;
}

/** Zeroes owned opening buffers after the synchronous proof hand-off boundary. */
function clearOpenings(batch: PreparedClosedEpochBatchV1): void {
  for (const opening of batch.openings) {
    opening.blinding.fill(0);
    opening.order.marketId.fill(0);
    opening.order.ownerPublicKey.fill(0);
    opening.order.nonce.fill(0);
  }
}

/**
 * Turns only fully chain-frozen epochs into proof work. A malformed encrypted
 * opening is rejected before any lifecycle mutation. No private error detail
 * crosses this service boundary.
 */
export class BatchPreparationServiceV1 {
  constructor(
    private readonly store: ClosedEpochBatchStoreV1,
    private readonly keys: MatcherKeyResolverV1,
    private readonly batchSize = 10,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('INVALID_BATCH_SIZE');
  }

  async runOnce(): Promise<BatchPreparationRunV1> {
    const candidates = await this.store.listReady(this.batchSize);
    let started = 0;
    let replayed = 0;
    let rejected = 0;
    let failed = 0;
    for (const candidate of candidates) {
      let prepared: PreparedClosedEpochBatchV1 | undefined;
      try {
        const orders = await this.store.loadFrozenOrders(candidate.epochId);
        prepared = await prepareClosedEpochBatchV1(context(candidate), orders, this.keys);
        const outcome = await this.store.beginProving({ candidate, solution: prepared.solution });
        if (outcome.outcome === 'STARTED') started += 1;
        else if (outcome.outcome === 'REPLAYED') replayed += 1;
        else rejected += 1;
      } catch {
        // A malformed/undecryptable opening or a database race must not
        // advance the epoch. The caller logs one fixed public code.
        failed += 1;
      } finally {
        if (prepared) clearOpenings(prepared);
      }
    }
    return { scanned: candidates.length, started, replayed, rejected, failed };
  }
}
