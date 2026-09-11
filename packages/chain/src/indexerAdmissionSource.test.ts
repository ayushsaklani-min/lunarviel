import { describe, expect, it } from 'vitest';

import type { PendingChainOrderV1 } from '@lunarveil/matcher';

import type { ChainAdmissionReadV1, ChainLedgerReaderV1 } from './chainLedgerReader.js';
import { MidnightIndexerAdmissionSourceV1 } from './indexerAdmissionSource.js';

const order: PendingChainOrderV1 = {
  orderId: 'order-1',
  marketId: 'market-1',
  epochId: 'epoch-1',
  commitment: '11'.repeat(32),
  state: 'PENDING_CHAIN',
};

function reader(read: ChainAdmissionReadV1 | Error, tip: bigint | Error): ChainLedgerReaderV1 {
  return {
    async readAdmission() { if (read instanceof Error) throw read; return read; },
    async readTipHeight() { if (tip instanceof Error) throw tip; return tip; },
  };
}

const included: ChainAdmissionReadV1 = {
  present: true, txId: 'tx-1', leafIndex: '3', inclusionHeight: 100n,
};

describe('MidnightIndexerAdmissionSourceV1', () => {
  it('reports INCLUDED with the order-bound admission once it is deep enough', async () => {
    const source = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader(included, 112n), { confirmationDepth: 12 });
    expect(await source.observe(order)).toEqual({
      sourceId: 'preview-indexer',
      outcome: 'INCLUDED',
      admission: {
        marketId: 'market-1', epochId: 'epoch-1', commitment: '11'.repeat(32),
        txId: 'tx-1', leafIndex: '3',
      },
    });
  });

  it('reports NOT_FOUND while an inclusion is still immature', async () => {
    // Immature is deliberately reported as not-yet-admitted so consensus keeps
    // the order pending rather than accepting an unconfirmed admission.
    const source = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader(included, 111n), { confirmationDepth: 12 });
    expect(await source.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'NOT_FOUND' });
  });

  it('reports NOT_FOUND when the commitment is absent', async () => {
    const source = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader({ present: false }, 999n), { confirmationDepth: 12 });
    expect(await source.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'NOT_FOUND' });
  });

  it('reports UNAVAILABLE instead of throwing when the reader fails', async () => {
    const admissionFailed = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader(new Error('socket hang up'), 999n), { confirmationDepth: 12 });
    expect(await admissionFailed.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'UNAVAILABLE' });

    const tipFailed = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader(included, new Error('timeout')), { confirmationDepth: 12 });
    expect(await tipFailed.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'UNAVAILABLE' });
  });

  it('reports UNAVAILABLE for a malformed or inconsistent read rather than trusting it', async () => {
    const cases: unknown[] = [
      { present: true, txId: '', leafIndex: '3', inclusionHeight: 100n },
      { present: true, txId: 'tx-1', leafIndex: 'three', inclusionHeight: 100n },
      { present: true, txId: 'tx-1', leafIndex: '3', inclusionHeight: -1n },
      { present: true, txId: 'tx\n1', leafIndex: '3', inclusionHeight: 100n },
      { present: true, txId: 'x'.repeat(300), leafIndex: '3', inclusionHeight: 100n },
      undefined,
      null,
    ];
    for (const read of cases) {
      const source = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader(read as ChainAdmissionReadV1, 999n), { confirmationDepth: 12 });
      expect(await source.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'UNAVAILABLE' });
    }
  });

  it('reports UNAVAILABLE when the tip is behind the inclusion', async () => {
    const source = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader(included, 99n), { confirmationDepth: 12 });
    expect(await source.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'UNAVAILABLE' });
  });

  it('rejects an invalid source id or depth at construction', () => {
    const ok = reader(included, 112n);
    expect(() => new MidnightIndexerAdmissionSourceV1('', ok, { confirmationDepth: 12 })).toThrow();
    expect(() => new MidnightIndexerAdmissionSourceV1('bad id\n', ok, { confirmationDepth: 12 })).toThrow();
    expect(() => new MidnightIndexerAdmissionSourceV1('preview', ok, { confirmationDepth: -1 })).toThrow();
    expect(() => new MidnightIndexerAdmissionSourceV1('preview', ok, { confirmationDepth: 1.5 })).toThrow();
  });
});
