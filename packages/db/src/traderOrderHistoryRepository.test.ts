import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import {
  PostgresTraderOrderHistoryRepositoryV1,
  TraderOrderHistoryError,
} from './traderOrderHistoryRepository.js';

const TAG = 'ab'.repeat(32);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    clientRequestId: '4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c',
    marketId: 'market-1',
    epochId: 'epoch-1',
    commitment: 'cd'.repeat(32),
    state: 'PENDING_CHAIN',
    createdAtMs: '1800000000000',
    acceptedAtMs: null,
    chainAdmissionTxId: null,
    leafIndex: null,
    ...overrides,
  };
}

function pool(
  rows: readonly Record<string, unknown>[],
  capture?: { text?: string; values?: readonly unknown[] },
): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      return {
        async query(text: string, values: readonly unknown[] = []) {
          if (capture !== undefined) { capture.text = text; capture.values = values; }
          return { rows: rows as never };
        },
        release() { /* pooled */ },
      };
    },
  };
}

describe('PostgresTraderOrderHistoryRepositoryV1', () => {
  it('exposes a finalized admission submission tx without trusting unfinished attempts', async () => {
    const capture: { text?: string; values?: readonly unknown[] } = {};
    const repository = new PostgresTraderOrderHistoryRepositoryV1(pool([
      row({ admissionSubmittedTxId: '00ab'.repeat(8) }),
    ], capture));
    const [order] = await repository.listForTrader({ traderTagHash: TAG, limit: 10 });
    expect(order?.admissionSubmittedTxId).toBe('00ab'.repeat(8));
    expect(capture.text).toContain(`"state" = 'SUBMITTED'`);
    await expect(new PostgresTraderOrderHistoryRepositoryV1(pool([
      row({ admissionSubmittedTxId: 'bad tx id' }),
    ])).listForTrader({ traderTagHash: TAG, limit: 10 })).rejects.toThrow('INVALID_ROW');
  });

  it('selects only public workflow columns, scoped to one trader tag', async () => {
    const capture: { text?: string; values?: readonly unknown[] } = {};
    const repository = new PostgresTraderOrderHistoryRepositoryV1(pool([row()], capture));

    const orders = await repository.listForTrader({ traderTagHash: TAG, limit: 10 });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      orderId: 'order-1',
      state: 'PENDING_CHAIN',
      createdAtMs: 1_800_000_000_000n,
      acceptedAtMs: undefined,
      chainAdmissionTxId: undefined,
    });

    expect(capture.values).toEqual([TAG, 10]);
    expect(capture.text).toContain('"traderTagHash" = $1');
    // The projection must never grow a ciphertext or signature column.
    expect(capture.text).not.toMatch(/ciphertext|clientSignature|ephemeralPublicKey|envelopeSalt|envelopeNonce|encryptionKeyId/u);
  });

  it('carries admission evidence once an order is accepted', async () => {
    const repository = new PostgresTraderOrderHistoryRepositoryV1(pool([
      row({ state: 'ACCEPTED', acceptedAtMs: '1800000060000', chainAdmissionTxId: 'tx-1', leafIndex: '3' }),
    ]));

    const orders = await repository.listForTrader({ traderTagHash: TAG, limit: 10 });
    expect(orders[0]).toMatchObject({
      state: 'ACCEPTED',
      acceptedAtMs: 1_800_000_060_000n,
      chainAdmissionTxId: 'tx-1',
      leafIndex: '3',
    });
  });

  it('rejects a malformed trader tag or limit before querying', async () => {
    const capture: { text?: string } = {};
    const repository = new PostgresTraderOrderHistoryRepositoryV1(pool([row()], capture));

    await expect(repository.listForTrader({ traderTagHash: 'short', limit: 10 }))
      .rejects.toThrow(new TraderOrderHistoryError('INVALID_TRADER_TAG'));
    await expect(repository.listForTrader({ traderTagHash: TAG.toUpperCase(), limit: 10 }))
      .rejects.toThrow(new TraderOrderHistoryError('INVALID_TRADER_TAG'));
    await expect(repository.listForTrader({ traderTagHash: TAG, limit: 0 }))
      .rejects.toThrow(new TraderOrderHistoryError('INVALID_LIMIT'));
    await expect(repository.listForTrader({ traderTagHash: TAG, limit: 201 }))
      .rejects.toThrow(new TraderOrderHistoryError('INVALID_LIMIT'));
    expect(capture.text).toBeUndefined();
  });

  it('fails closed on a row it cannot validate', async () => {
    for (const bad of [
      row({ state: 'SOMETHING_ELSE' }),
      row({ commitment: 'not-a-commitment' }),
      row({ createdAtMs: 'not-a-number' }),
      row({ leafIndex: '-1' }),
    ]) {
      const repository = new PostgresTraderOrderHistoryRepositoryV1(pool([bad]));
      await expect(repository.listForTrader({ traderTagHash: TAG, limit: 10 }))
        .rejects.toThrow(new TraderOrderHistoryError('INVALID_ROW'));
    }
  });

  it('never leaks the underlying database error', async () => {
    const failing: SerializableSqlPool = {
      async connect(): Promise<SerializableSqlClient> {
        return {
          async query() { throw new Error('connection to server at "10.0.0.1" failed'); },
          release() { /* pooled */ },
        };
      },
    };
    const repository = new PostgresTraderOrderHistoryRepositoryV1(failing);
    const error = await repository.listForTrader({ traderTagHash: TAG, limit: 10 })
      .catch((thrown: unknown) => thrown);
    expect((error as TraderOrderHistoryError).code).toBe('DATABASE_FAILURE');
    expect(String(error)).not.toContain('10.0.0.1');
  });
});
