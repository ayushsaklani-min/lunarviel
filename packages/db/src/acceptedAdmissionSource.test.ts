import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import { AcceptedAdmissionSourceError, PostgresAcceptedAdmissionSourceV1 } from './acceptedAdmissionSource.js';

function pool(rows: readonly Record<string, unknown>[]): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query(_text: string, _values: readonly unknown[] = []) {
          return { rows: rows as never };
        },
        release() { /* pooled */ },
      };
    },
  };
}

describe('PostgresAcceptedAdmissionSourceV1', () => {
  it('reads a 255-character txId written by the chain admission write path', async () => {
    // @lunarveil/chain's TX_ID_PATTERN (indexerAdmissionSource.ts) accepts up
    // to 255 characters from [A-Za-z0-9._:-]. A txId legal to write must
    // remain legal to read here, or every subsequent reorg re-check pass
    // throws INVALID_ROW forever.
    const maxLengthTxId = 'a'.repeat(255);
    const source = new PostgresAcceptedAdmissionSourceV1(pool([
      { id: 'order-1', marketId: 'market-1', commitment: '11'.repeat(32), chainAdmissionTxId: maxLengthTxId, leafIndex: '3' },
    ]));
    const rows = await source.listRecentlyAccepted({ limit: 10, lookbackMs: 1_000 });
    expect(rows).toEqual([
      { orderId: 'order-1', marketId: 'market-1', commitment: '11'.repeat(32), txId: maxLengthTxId, leafIndex: '3' },
    ]);
  });

  it('reads a txId containing every character class the write path allows', async () => {
    const txId = '_leading.and:trailing-punctuation_';
    const source = new PostgresAcceptedAdmissionSourceV1(pool([
      { id: 'order-1', marketId: 'market-1', commitment: '11'.repeat(32), chainAdmissionTxId: txId, leafIndex: null },
    ]));
    const rows = await source.listRecentlyAccepted({ limit: 10, lookbackMs: 1_000 });
    expect(rows).toEqual([
      { orderId: 'order-1', marketId: 'market-1', commitment: '11'.repeat(32), txId, leafIndex: undefined },
    ]);
  });

  it('still fails closed on a txId longer than the write path can ever produce', async () => {
    const source = new PostgresAcceptedAdmissionSourceV1(pool([
      { id: 'order-1', marketId: 'market-1', commitment: '11'.repeat(32), chainAdmissionTxId: 'a'.repeat(256), leafIndex: '3' },
    ]));
    await expect(source.listRecentlyAccepted({ limit: 10, lookbackMs: 1_000 })).rejects.toThrow(AcceptedAdmissionSourceError);
  });

  it('rejects a malformed limit or lookback instead of scanning without bound', async () => {
    const source = new PostgresAcceptedAdmissionSourceV1(pool([]));
    for (const limit of [0, -1, 1.5, Number.NaN, 1_001]) {
      await expect(source.listRecentlyAccepted({ limit, lookbackMs: 1_000 })).rejects.toThrow();
    }
    for (const lookbackMs of [0, -1, 1.5, Number.NaN]) {
      await expect(source.listRecentlyAccepted({ limit: 10, lookbackMs })).rejects.toThrow();
    }
  });
});
