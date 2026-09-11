import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import { PostgresPendingChainOrderSourceV1 } from './pendingChainOrderSource.js';

function pool(rows: readonly Record<string, unknown>[], capture?: (text: string, values: readonly unknown[]) => void): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query(text: string, values: readonly unknown[] = []) {
          capture?.(text, values);
          return { rows: rows as never };
        },
        release() { /* pooled */ },
      };
    },
  };
}

describe('PostgresPendingChainOrderSourceV1', () => {
  it('returns only allowlisted public fields', async () => {
    const source = new PostgresPendingChainOrderSourceV1(pool([
      { id: 'order-1', marketId: 'market-1', epochId: 'epoch-1', commitment: '11'.repeat(32), state: 'PENDING_CHAIN' },
    ]));
    const orders = await source.listPending(10);
    expect(orders).toEqual([
      { orderId: 'order-1', marketId: 'market-1', epochId: 'epoch-1', commitment: '11'.repeat(32), state: 'PENDING_CHAIN' },
    ]);
    expect(Object.keys(orders[0]!).sort()).toEqual(['commitment', 'epochId', 'marketId', 'orderId', 'state']);
  });

  it('never selects ciphertext, signature or allocation columns', async () => {
    let sql = '';
    const source = new PostgresPendingChainOrderSourceV1(pool([], text => { sql = text; }));
    await source.listPending(10);
    for (const forbidden of ['ciphertext', 'clientSignature', 'envelopeSalt', 'envelopeNonce', 'ephemeralPublicKey', 'traderTagHash']) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain('PENDING_CHAIN');
  });

  it('rejects a malformed limit instead of scanning without bound', async () => {
    const source = new PostgresPendingChainOrderSourceV1(pool([]));
    for (const limit of [0, -1, 1.5, Number.NaN, 100_001]) {
      await expect(source.listPending(limit)).rejects.toThrow();
    }
  });

  it('fails closed on an unusable row rather than returning a partial order', async () => {
    const source = new PostgresPendingChainOrderSourceV1(pool([
      { id: 'order-1', marketId: 'market-1', epochId: 'epoch-1', commitment: '11'.repeat(32), state: 'ACCEPTED' },
    ]));
    await expect(source.listPending(10)).rejects.toThrow();
  });
});
