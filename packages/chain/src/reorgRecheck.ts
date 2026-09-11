import type { ChainLedgerReaderV1 } from './chainLedgerReader.js';
import { evaluateBlockDepthFinalityV1 } from './finalityPolicy.js';

export interface AcceptedAdmissionRecordV1 {
  readonly orderId: string;
  readonly marketId: string;
  readonly commitment: string;
  readonly txId: string;
  readonly leafIndex: string | undefined;
}

export type ReorgRecheckOutcomeV1 = 'INTACT' | 'REVOKED' | 'UNVERIFIABLE';

/**
 * Re-observes an already-accepted admission.
 *
 * It returns a verdict only and changes no state: there is no `PAUSED` order
 * state and nothing in this system demotes an `ACCEPTED` order. An unreadable
 * chain is `UNVERIFIABLE`, never `REVOKED` — an outage must not be reported as
 * a reorg.
 */
export class ReorgRecheckServiceV1 {
  private readonly confirmationDepth: number;

  constructor(
    private readonly reader: ChainLedgerReaderV1,
    options: { readonly confirmationDepth: number },
  ) {
    if (!Number.isSafeInteger(options.confirmationDepth) || options.confirmationDepth < 0) {
      throw new Error('INVALID_CONFIRMATION_DEPTH');
    }
    this.confirmationDepth = options.confirmationDepth;
  }

  async check(record: AcceptedAdmissionRecordV1): Promise<ReorgRecheckOutcomeV1> {
    try {
      const read = await this.reader.readAdmission({ marketId: record.marketId, commitment: record.commitment });
      if (typeof read !== 'object' || read === null) return 'UNVERIFIABLE';
      if (read.present === false) return 'REVOKED';
      if (read.present !== true || typeof read.txId !== 'string' || typeof read.inclusionHeight !== 'bigint') {
        return 'UNVERIFIABLE';
      }
      if (read.txId !== record.txId) return 'REVOKED';
      if (record.leafIndex !== undefined && read.leafIndex !== record.leafIndex) return 'REVOKED';

      const tipHeight = await this.reader.readTipHeight();
      if (typeof tipHeight !== 'bigint') return 'UNVERIFIABLE';
      return evaluateBlockDepthFinalityV1({
        inclusionHeight: read.inclusionHeight, tipHeight, confirmationDepth: this.confirmationDepth,
      }) === 'CONFIRMED' ? 'INTACT' : 'UNVERIFIABLE';
    } catch {
      return 'UNVERIFIABLE';
    }
  }
}
