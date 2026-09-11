import { describe, expect, it } from 'vitest';

import { MidnightIndexerAdmissionSourceV1, ReorgRecheckServiceV1 } from '@lunarveil/chain';
import type { PendingChainOrderV1 } from '@lunarveil/matcher';

import { parseReconcilerConfigV1 } from './config.js';
import { createIndexerChainLedgerReaderV1 } from './indexerReader.js';

const config = parseReconcilerConfigV1({
  LUNARVEIL_CHAIN_NETWORK: 'preview',
  LUNARVEIL_INDEXER_URL: 'https://indexer.example.invalid/api/v4/graphql',
  LUNARVEIL_INDEXER_WS_URL: 'wss://indexer.example.invalid/api/v4/graphql/ws',
});

const order: PendingChainOrderV1 = {
  orderId: 'order-1',
  marketId: 'market-1',
  epochId: 'epoch-1',
  commitment: '11'.repeat(32),
  state: 'PENDING_CHAIN',
};

/**
 * These tests never touch the network: `readAdmission` throws synchronously
 * before this reader would need `readTipHeight` or an HTTP call, for either
 * consumer path exercised below.
 */
describe('createIndexerChainLedgerReaderV1 — readAdmission fails closed by throwing', () => {
  it('MidnightIndexerAdmissionSourceV1 reports UNAVAILABLE, never a false NOT_FOUND/INCLUDED', async () => {
    const reader = createIndexerChainLedgerReaderV1(config);
    const source = new MidnightIndexerAdmissionSourceV1('preview-indexer', reader, { confirmationDepth: 12 });

    await expect(reader.readAdmission({ marketId: order.marketId, commitment: order.commitment })).rejects.toThrow('INDEXER_ADMISSION_UNRESOLVED');
    expect(await source.observe(order)).toEqual({ sourceId: 'preview-indexer', outcome: 'UNAVAILABLE' });
  });

  it('ReorgRecheckServiceV1 reports UNVERIFIABLE, never REVOKED, for an unreadable admission', async () => {
    const reader = createIndexerChainLedgerReaderV1(config);
    const recheck = new ReorgRecheckServiceV1(reader, { confirmationDepth: 12 });

    const outcome = await recheck.check({
      orderId: order.orderId,
      marketId: order.marketId,
      commitment: order.commitment,
      txId: 'tx-1',
      leafIndex: '3',
    });

    expect(outcome).toBe('UNVERIFIABLE');
    expect(outcome).not.toBe('REVOKED');
  });
});
