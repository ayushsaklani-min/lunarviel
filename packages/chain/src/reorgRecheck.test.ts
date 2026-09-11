import { describe, expect, it } from 'vitest';

import type { ChainAdmissionReadV1, ChainLedgerReaderV1 } from './chainLedgerReader.js';
import { ReorgRecheckServiceV1, type AcceptedAdmissionRecordV1 } from './reorgRecheck.js';

const record: AcceptedAdmissionRecordV1 = {
  orderId: 'order-1', marketId: 'market-1', commitment: '11'.repeat(32), txId: 'tx-1', leafIndex: '3',
};

function reader(read: ChainAdmissionReadV1 | Error, tip: bigint | Error = 999n): ChainLedgerReaderV1 {
  return {
    async readAdmission() { if (read instanceof Error) throw read; return read; },
    async readTipHeight() { if (tip instanceof Error) throw tip; return tip; },
  };
}

describe('ReorgRecheckServiceV1', () => {
  it('reports INTACT when the same admission is still present and deep enough', async () => {
    const service = new ReorgRecheckServiceV1(
      reader({ present: true, txId: 'tx-1', leafIndex: '3', inclusionHeight: 100n }), { confirmationDepth: 12 },
    );
    expect(await service.check(record)).toBe('INTACT');
  });

  it('reports REVOKED when the commitment has disappeared', async () => {
    const service = new ReorgRecheckServiceV1(reader({ present: false }), { confirmationDepth: 12 });
    expect(await service.check(record)).toBe('REVOKED');
  });

  it('reports REVOKED when the admission now names a different transaction or leaf', async () => {
    const changedTx = new ReorgRecheckServiceV1(
      reader({ present: true, txId: 'tx-2', leafIndex: '3', inclusionHeight: 100n }), { confirmationDepth: 12 },
    );
    expect(await changedTx.check(record)).toBe('REVOKED');

    const changedLeaf = new ReorgRecheckServiceV1(
      reader({ present: true, txId: 'tx-1', leafIndex: '4', inclusionHeight: 100n }), { confirmationDepth: 12 },
    );
    expect(await changedLeaf.check(record)).toBe('REVOKED');
  });

  it('reports UNVERIFIABLE rather than REVOKED when the chain cannot be read', async () => {
    // An outage must never be mistaken for a reorg: that would raise false alarms.
    const readFailed = new ReorgRecheckServiceV1(reader(new Error('socket hang up')), { confirmationDepth: 12 });
    expect(await readFailed.check(record)).toBe('UNVERIFIABLE');

    const tipFailed = new ReorgRecheckServiceV1(
      reader({ present: true, txId: 'tx-1', leafIndex: '3', inclusionHeight: 100n }, new Error('timeout')),
      { confirmationDepth: 12 },
    );
    expect(await tipFailed.check(record)).toBe('UNVERIFIABLE');
  });

  it('reports UNVERIFIABLE while a re-observed inclusion is not yet deep enough', async () => {
    const service = new ReorgRecheckServiceV1(
      reader({ present: true, txId: 'tx-1', leafIndex: '3', inclusionHeight: 100n }, 105n), { confirmationDepth: 12 },
    );
    expect(await service.check(record)).toBe('UNVERIFIABLE');
  });
});
