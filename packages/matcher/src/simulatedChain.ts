import type {
  SimulatedAdmissionCandidateV1,
  SimulatedAdmissionOutcomeV1,
  SimulatedFinalizationV1,
  SimulatedOrderOutcomeV1,
} from '@lunarveil/db';
import { verifyBatchSolution, type BatchSolutionV1 } from '@lunarveil/matching-core';

import type { ClosedEpochBatchStoreV1 } from './batchPreparationService.js';
import {
  prepareClosedEpochBatchV1,
  type MatcherKeyResolverV1,
  type PreparedClosedEpochBatchV1,
} from './closedEpochMatching.js';
import type { OrderAdmissionPreflightV1 } from './orderAdmissionSubmissionWorker.js';

/** The simulated chain's durable operations. Implemented by `PostgresSimulatedChainRepositoryV1`. */
export interface SimulatedChainStoreV1 {
  expireStranded(): Promise<void>;
  listPendingAdmissions(limit: number): Promise<readonly SimulatedAdmissionCandidateV1[]>;
  admit(candidate: SimulatedAdmissionCandidateV1): Promise<SimulatedAdmissionOutcomeV1>;
  reject(orderId: string): Promise<void>;
  freezeClosedEpochs(limit: number): Promise<number>;
  finalizeEmptyEpochs(limit: number): Promise<number>;
  recoverStalledProving(): Promise<void>;
  invalidate(epochId: string): Promise<void>;
  finalize(input: SimulatedFinalizationV1): Promise<void>;
  rollEpochs(input: { readonly nowMs: bigint; readonly limit: number }): Promise<number>;
}

export interface SimulatedChainPassResultV1 {
  readonly admitted: number;
  readonly rejected: number;
  readonly frozen: number;
  readonly finalized: number;
  readonly invalidated: number;
  readonly maliciousSolutionsRejected: number;
  readonly epochsOpened: number;
}

export interface SimulatedChainEventV1 {
  readonly event:
    | 'simulated.order_admitted'
    | 'simulated.order_rejected'
    | 'simulated.malicious_solution_rejected'
    | 'simulated.epoch_finalized'
    | 'simulated.epoch_invalidated';
  /** Public identifiers and aggregates only. Never an order field. */
  readonly detail: Readonly<Record<string, string | number>>;
}

/**
 * Produces a deliberately wrong solution the way a malicious matcher might:
 * it moves the clearing price one tick while keeping the honest fingerprint.
 */
export function tamperBatchSolutionV1(solution: BatchSolutionV1): BatchSolutionV1 {
  return { ...solution, clearingPriceTicks: solution.clearingPriceTicks + 1n };
}

function orderOutcomes(prepared: PreparedClosedEpochBatchV1): Map<string, SimulatedOrderOutcomeV1> {
  const filled = new Map(prepared.solution.fills.map(fill => [fill.orderCommitment, fill.filledLots]));
  const outcomes = new Map<string, SimulatedOrderOutcomeV1>();
  for (const order of prepared.input.orders) {
    const lots = filled.get(order.commitment) ?? 0n;
    outcomes.set(order.commitment, lots === 0n ? 'EXPIRED' : lots >= order.quantityLots ? 'FILLED' : 'PARTIALLY_FILLED');
  }
  return outcomes;
}

function scrub(prepared: PreparedClosedEpochBatchV1): void {
  for (const opening of prepared.openings) {
    opening.blinding.fill(0);
    opening.order.marketId.fill(0);
    opening.order.ownerPublicKey.fill(0);
    opening.order.nonce.fill(0);
  }
}

/**
 * Development-only driver that plays the part of the Midnight chain so the
 * full order lifecycle can be demonstrated end to end:
 *
 *   PENDING_CHAIN -> ACCEPTED (simulated admission, after the real M3 preflight)
 *   OPEN -> CLOSED (the existing epoch close pass)
 *   CLOSED + simulated close root -> real in-memory decryption and `clearBatch`
 *   -> independent `verifyBatchSolution` re-check in place of the ZK proof
 *   -> FINALIZED, with per-order FILLED / PARTIALLY_FILLED / EXPIRED
 *   -> next epoch opened.
 *
 * What is simulated is exactly what needs a live chain: the admission
 * transaction, the chain-read root, the proof and the settlement transfer.
 * The matching itself is the production code path. The composition refuses
 * to build this outside `development`.
 */
export class SimulatedChainServiceV1 {
  constructor(
    private readonly options: {
      readonly store: SimulatedChainStoreV1;
      readonly batches: ClosedEpochBatchStoreV1;
      readonly preflight: OrderAdmissionPreflightV1;
      readonly keys: MatcherKeyResolverV1;
      readonly nowMs: () => bigint;
      readonly maliciousMatcher?: boolean;
      readonly batchSize?: number;
      readonly onEvent?: (event: SimulatedChainEventV1) => void;
    },
  ) {
    const size = options.batchSize ?? 25;
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('INVALID_BATCH_SIZE');
  }

  private emit(event: SimulatedChainEventV1): void {
    this.options.onEvent?.(event);
  }

  async runOnce(): Promise<SimulatedChainPassResultV1> {
    const { store, batches } = this.options;
    const limit = this.options.batchSize ?? 25;

    await store.recoverStalledProving();
    await store.expireStranded();

    let admitted = 0;
    let rejected = 0;
    for (const candidate of await store.listPendingAdmissions(limit)) {
      try {
        await this.options.preflight.validate(candidate);
      } catch {
        // The same M3 preflight the real admission worker runs: an order the
        // circuit could not accept is never admitted.
        await store.reject(candidate.orderId);
        rejected += 1;
        this.emit({ event: 'simulated.order_rejected', detail: { orderId: candidate.orderId } });
        continue;
      }
      const outcome = await store.admit(candidate);
      if (outcome.outcome === 'ADMITTED') {
        admitted += 1;
        this.emit({ event: 'simulated.order_admitted', detail: { orderId: candidate.orderId, leafIndex: outcome.leafIndex.toString() } });
      }
    }

    const frozen = await store.freezeClosedEpochs(limit);
    let finalized = await store.finalizeEmptyEpochs(limit);
    let invalidated = 0;
    let maliciousSolutionsRejected = 0;

    for (const candidate of await batches.listReady(limit)) {
      let prepared: PreparedClosedEpochBatchV1 | undefined;
      try {
        try {
          prepared = await prepareClosedEpochBatchV1(candidate, await batches.loadFrozenOrders(candidate.epochId), this.options.keys);
        } catch {
          await store.invalidate(candidate.epochId);
          invalidated += 1;
          this.emit({ event: 'simulated.epoch_invalidated', detail: { epochId: candidate.epochId } });
          continue;
        }

        let rejectedSolutions = 0;
        if (this.options.maliciousMatcher === true) {
          const forged = tamperBatchSolutionV1(prepared.solution);
          if (!verifyBatchSolution(prepared.input, forged)) {
            rejectedSolutions += 1;
            this.emit({ event: 'simulated.malicious_solution_rejected', detail: { epochId: candidate.epochId } });
          }
        }
        // Stand-in for the fair-clearing proof: an independent recomputation
        // must reproduce the candidate exactly. A mismatch never finalizes.
        if (!verifyBatchSolution(prepared.input, prepared.solution)) {
          await store.invalidate(candidate.epochId);
          invalidated += 1;
          this.emit({ event: 'simulated.epoch_invalidated', detail: { epochId: candidate.epochId } });
          continue;
        }

        const started = await batches.beginProving({ candidate, solution: prepared.solution });
        if (started.outcome === 'CONFLICT') continue;
        await store.finalize({
          epochId: candidate.epochId,
          solutionCommitment: prepared.solution.canonicalSolutionHash,
          clearingPriceTicks: prepared.solution.clearingPriceTicks,
          totalVolumeLots: prepared.solution.totalVolumeLots,
          matchedOrderCount: prepared.solution.fills.filter(fill => fill.filledLots > 0n).length,
          rejectedSolutionCount: rejectedSolutions,
          orderOutcomes: orderOutcomes(prepared),
        });
        finalized += 1;
        maliciousSolutionsRejected += rejectedSolutions;
        this.emit({
          event: 'simulated.epoch_finalized',
          detail: {
            epochId: candidate.epochId,
            clearingPriceTicks: prepared.solution.clearingPriceTicks.toString(),
            totalVolumeLots: prepared.solution.totalVolumeLots.toString(),
          },
        });
      } finally {
        if (prepared !== undefined) scrub(prepared);
      }
    }

    const epochsOpened = await store.rollEpochs({ nowMs: this.options.nowMs(), limit });
    return { admitted, rejected, frozen, finalized, invalidated, maliciousSolutionsRejected, epochsOpened };
  }
}
