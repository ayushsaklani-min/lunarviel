import type {
  ChainAdmissionObservationSourceV1,
  ChainAdmissionObservationV1,
  PendingChainOrderV1,
} from '@lunarveil/matcher';

import type { ChainAdmissionReadV1, ChainLedgerReaderV1 } from './chainLedgerReader.js';
import { evaluateBlockDepthFinalityV1 } from './finalityPolicy.js';

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const TX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/u;
const LEAF_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/u;

function isUsableRead(read: unknown): read is ChainAdmissionReadV1 {
  if (typeof read !== 'object' || read === null) return false;
  const candidate = read as { present?: unknown; txId?: unknown; leafIndex?: unknown; inclusionHeight?: unknown };
  if (candidate.present === false) return true;
  if (candidate.present !== true) return false;
  return typeof candidate.txId === 'string' && TX_ID_PATTERN.test(candidate.txId)
    && typeof candidate.leafIndex === 'string' && LEAF_INDEX_PATTERN.test(candidate.leafIndex)
    && typeof candidate.inclusionHeight === 'bigint' && candidate.inclusionHeight >= 0n;
}

/**
 * Observes chain admission for one order through an injected reader.
 *
 * It never throws into the worker: any transport, parse or consistency problem
 * becomes `UNAVAILABLE`, which consensus treats as no evidence. An inclusion
 * that is not yet `confirmationDepth` blocks deep is reported `NOT_FOUND` —
 * as far as this source is concerned the order is not admitted yet, so
 * consensus keeps it pending instead of accepting an unconfirmed admission.
 */
export class MidnightIndexerAdmissionSourceV1 implements ChainAdmissionObservationSourceV1 {
  private readonly confirmationDepth: number;

  constructor(
    readonly sourceId: string,
    private readonly reader: ChainLedgerReaderV1,
    options: { readonly confirmationDepth: number },
  ) {
    if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) throw new Error('INVALID_SOURCE_ID');
    if (!Number.isSafeInteger(options.confirmationDepth) || options.confirmationDepth < 0) {
      throw new Error('INVALID_CONFIRMATION_DEPTH');
    }
    this.confirmationDepth = options.confirmationDepth;
  }

  async observe(order: PendingChainOrderV1): Promise<ChainAdmissionObservationV1> {
    try {
      const read = await this.reader.readAdmission({ marketId: order.marketId, commitment: order.commitment });
      if (!isUsableRead(read)) return { sourceId: this.sourceId, outcome: 'UNAVAILABLE' };
      if (!read.present) return { sourceId: this.sourceId, outcome: 'NOT_FOUND' };

      const tipHeight = await this.reader.readTipHeight();
      if (typeof tipHeight !== 'bigint') return { sourceId: this.sourceId, outcome: 'UNAVAILABLE' };

      const finality = evaluateBlockDepthFinalityV1({
        inclusionHeight: read.inclusionHeight,
        tipHeight,
        confirmationDepth: this.confirmationDepth,
      });
      if (finality === 'INVALID') return { sourceId: this.sourceId, outcome: 'UNAVAILABLE' };
      if (finality === 'IMMATURE') return { sourceId: this.sourceId, outcome: 'NOT_FOUND' };

      return {
        sourceId: this.sourceId,
        outcome: 'INCLUDED',
        admission: {
          marketId: order.marketId,
          epochId: order.epochId,
          commitment: order.commitment,
          txId: read.txId,
          leafIndex: read.leafIndex,
        },
      };
    } catch {
      return { sourceId: this.sourceId, outcome: 'UNAVAILABLE' };
    }
  }
}
