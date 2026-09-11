import type { StoredOrderEnvelopeRecordV1 } from '@lunarveil/db';

import type { ChainAdmissionObservationV1 } from './chainAdmissionConsensus.js';
import {
  ChainAdmissionReconciliationServiceV1,
  type ChainAdmissionReconciliationServiceResultV1,
} from './chainAdmissionReconciliationService.js';

export interface PendingChainOrderV1 extends Pick<StoredOrderEnvelopeRecordV1, 'marketId' | 'epochId' | 'commitment' | 'state'> {
  readonly orderId: string;
}

export interface ChainAdmissionPendingOrderSourceV1 {
  listPending(limit: number): Promise<readonly PendingChainOrderV1[]>;
}

export interface ChainAdmissionObservationSourceV1 {
  readonly sourceId: string;
  observe(order: PendingChainOrderV1): Promise<ChainAdmissionObservationV1>;
}

export interface ChainAdmissionReconciliationWorkerOptionsV1 {
  readonly batchSize?: number;
  readonly requiredMatchingSources: number;
}

export interface ChainAdmissionReconciliationWorkerRunV1 {
  readonly scanned: number;
  readonly reconciled: number;
  readonly accepted: number;
  readonly paused: number;
  readonly pending: number;
  readonly failed: number;
  readonly results: readonly {
    readonly orderId: string;
    readonly result?: ChainAdmissionReconciliationServiceResultV1;
    readonly failed: boolean;
  }[];
}

const DEFAULT_BATCH_SIZE = 100;

function safeSourceFailure(sourceId: string): ChainAdmissionObservationV1 {
  return { sourceId, outcome: 'UNAVAILABLE' };
}

function assertBatchSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new Error('INVALID_WORKER_BATCH_SIZE');
}

/**
 * One-shot worker boundary. Scheduling, finality and source authentication are
 * injected concerns; this class only gathers public observations and delegates
 * every mutation to the consensus/reconciliation service.
 */
export class ChainAdmissionReconciliationWorkerV1 {
  private readonly batchSize: number;

  constructor(
    private readonly pendingOrders: ChainAdmissionPendingOrderSourceV1,
    private readonly sources: readonly ChainAdmissionObservationSourceV1[],
    private readonly reconciliation: ChainAdmissionReconciliationServiceV1,
    private readonly options: ChainAdmissionReconciliationWorkerOptionsV1,
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    assertBatchSize(this.batchSize);
    if (!Number.isSafeInteger(options.requiredMatchingSources) || options.requiredMatchingSources < 1) {
      throw new Error('INVALID_WORKER_QUORUM');
    }
    const ids = sources.map(source => source.sourceId).sort((left, right) => left.localeCompare(right));
    if (new Set(ids).size !== ids.length || ids.length === 0) throw new Error('INVALID_WORKER_SOURCES');
  }

  async runOnce(): Promise<ChainAdmissionReconciliationWorkerRunV1> {
    const orders = [...await this.pendingOrders.listPending(this.batchSize)]
      .sort((left, right) => left.orderId.localeCompare(right.orderId));
    let accepted = 0;
    let paused = 0;
    let pending = 0;
    let failed = 0;
    const results: Array<{ orderId: string; result?: ChainAdmissionReconciliationServiceResultV1; failed: boolean }> = [];

    for (const order of orders) {
      try {
        if (order.state !== 'PENDING_CHAIN') throw new Error('ORDER_NOT_PENDING');
        const observations = await Promise.all(this.sources
          .slice()
          .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
          .map(async source => {
            try {
              const observation = await source.observe(order);
              return observation.sourceId === source.sourceId ? observation : safeSourceFailure(source.sourceId);
            } catch {
              return safeSourceFailure(source.sourceId);
            }
          }));
        const result = await this.reconciliation.reconcile(order.orderId, {
          order,
          requiredMatchingSources: this.options.requiredMatchingSources,
          observations,
        });
        results.push({ orderId: order.orderId, result, failed: false });
        if (!result.persisted) pending += 1;
        else if (result.decision.action === 'ACCEPT') accepted += 1;
        else paused += 1;
      } catch {
        failed += 1;
        results.push({ orderId: order.orderId, failed: true });
      }
    }
    return { scanned: orders.length, reconciled: accepted + paused, accepted, paused, pending, failed, results };
  }
}
