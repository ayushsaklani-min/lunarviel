import type { DueEpochV1, EpochCloseOutcomeV1 } from '@lunarveil/db';

import {
  EpochLifecycleError,
  transitionEpochLifecycleV1,
  type EpochLifecycleSnapshotV1,
} from './epochLifecycle.js';

export interface EpochLifecycleStore {
  listDueForClose(input: { readonly nowMs: bigint; readonly limit: number }): Promise<readonly DueEpochV1[]>;
  close(input: {
    readonly epochId: string;
    readonly expectedConfigHash: string;
    readonly nowMs: bigint;
  }): Promise<EpochCloseOutcomeV1>;
}

export interface EpochClosePassResultV1 {
  readonly scanned: number;
  readonly closed: number;
  readonly skipped: number;
  readonly refused: number;
}

/**
 * Closes epochs whose scheduled close has passed.
 *
 * The decision itself is the pure `transitionEpochLifecycleV1` machine, run
 * against the epoch's frozen parameters. This service only supplies the
 * snapshot and persists the outcome — the rule about which transitions are
 * legal lives in one place, not two.
 *
 * ## Why a refusal is not a failure
 *
 * An epoch whose frozen parameters the state machine rejects (an order count
 * above its maximum, say, or parameters that no longer validate) is counted
 * `refused` and left `OPEN`. Closing it would freeze a root over a
 * configuration the system cannot reason about. Leaving it open is visible,
 * recoverable and safe; forcing it closed is none of those.
 *
 * ## Concurrency
 *
 * `close` re-checks state and config hash under a row lock, so two workers
 * racing on the same epoch produce one `CLOSED` and one `SKIPPED`. The pass
 * as a whole is still expected to run under an advisory lock, which keeps
 * replicas from duplicating the scan work.
 */
export class EpochCloseServiceV1 {
  private readonly batchSize: number;

  constructor(
    private readonly store: EpochLifecycleStore,
    private readonly options: { readonly nowMs: () => bigint; readonly batchSize?: number },
  ) {
    const batchSize = options.batchSize ?? 25;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error('INVALID_BATCH_SIZE');
    }
    this.batchSize = batchSize;
  }

  async runOnce(): Promise<EpochClosePassResultV1> {
    const nowMs = this.options.nowMs();
    const due = await this.store.listDueForClose({ nowMs, limit: this.batchSize });

    let closed = 0;
    let skipped = 0;
    let refused = 0;

    for (const epoch of due) {
      const snapshot: EpochLifecycleSnapshotV1 = {
        state: 'OPEN',
        parameters: {
          marketId: epoch.marketId,
          epochId: epoch.epochId,
          sequence: epoch.sequence,
          ruleVersion: epoch.ruleVersion,
          configHash: epoch.configHash,
          tickSizeAtomic: epoch.tickSizeAtomic,
          lotSizeAtomic: epoch.lotSizeAtomic,
          feeBps: epoch.feeBps,
          ...(epoch.maxPriceCollarBps === undefined ? {} : { maxPriceCollarBps: epoch.maxPriceCollarBps }),
        },
        orderCount: epoch.admittedOrderCount,
        maxOrders: epoch.maxOrders,
      };

      try {
        const next = transitionEpochLifecycleV1(snapshot, { type: 'CLOSE', configHash: epoch.configHash });
        if (next.state !== 'CLOSED') {
          refused += 1;
          continue;
        }
      } catch (error) {
        // A parameter the machine rejects means this epoch must not be closed.
        if (error instanceof EpochLifecycleError) {
          refused += 1;
          continue;
        }
        throw error;
      }

      const result = await this.store.close({
        epochId: epoch.epochId,
        expectedConfigHash: epoch.configHash,
        nowMs,
      });
      if (result.outcome === 'CLOSED') closed += 1;
      else skipped += 1;
    }

    return { scanned: due.length, closed, skipped, refused };
  }
}
