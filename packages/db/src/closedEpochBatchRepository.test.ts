import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import {
  ClosedEpochBatchRepositoryError,
  PostgresClosedEpochBatchRepositoryV1,
} from './closedEpochBatchRepository.js';

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

describe('PostgresClosedEpochBatchRepositoryV1', () => {
  it('selects only chain-frozen, oracle-free closed epochs and validates their public root evidence', async () => {
    let sql = '';
    const repository = new PostgresClosedEpochBatchRepositoryV1(pool([
      {
        epochId: 'epoch-7', marketId: 'market-1', sequence: '7', ruleVersion: 'm3a-v1',
        configHash: 'ab'.repeat(32), closeRoot: 'closed-root-7', closedAt: new Date('2026-09-10T00:00:00.000Z'),
        orderCount: 2, maxOrdersPerEpoch: 4, onchainEndIndexExclusive: '2',
      },
    ], text => { sql = text; }));

    await expect(repository.listReady(10)).resolves.toEqual([{
      epochId: 'epoch-7', marketId: 'market-1', epochSequence: 7n, ruleVersion: 'm3a-v1',
      configHash: 'ab'.repeat(32), inputRoot: 'closed-root-7', closedAtMs: 1788998400000n,
      orderCount: 2, maxOrders: 4,
    }]);
    expect(sql).toContain('e."state" = \'CLOSED\'');
    expect(sql).toContain('e."closeRoot" IS NOT NULL');
    expect(sql).toContain('e."referencePriceHash" IS NULL');
    expect(sql).not.toContain('ciphertext');
  });

  it('loads ciphertext only through the matcher-only frozen-order path', async () => {
    let sql = '';
    const repository = new PostgresClosedEpochBatchRepositoryV1(pool([
      {
        id: 'order-1', leafIndex: '0', clientRequestId: '4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c',
        marketId: 'market-1', epochId: 'epoch-7', commitment: '11'.repeat(32), encryptionKeyId: 'matcher-1',
        envelopeVersion: 1, envelopeAlgorithm: 'X25519-HKDF-SHA256-AES-256-GCM',
        ephemeralPublicKey: 'a'.repeat(43), envelopeSalt: 'b'.repeat(22), envelopeNonce: 'c'.repeat(16),
        ciphertext: Buffer.from([1, 2, 3, 4]), traderTagHash: '22'.repeat(32),
      },
    ], text => { sql = text; }));

    const rows = await repository.loadFrozenOrders('epoch-7');
    expect(rows[0]).toMatchObject({ orderId: 'order-1', leafIndex: 0n });
    expect(rows[0]!.envelope.ciphertext).toBe(Buffer.from([1, 2, 3, 4]).toString('base64url'));
    expect(sql).toContain('"ciphertext"');
    expect(sql).toContain('"state" = \'ACCEPTED\'');
  });

  it('rejects malformed roots and cannot scan unbounded', async () => {
    const malformed = new PostgresClosedEpochBatchRepositoryV1(pool([
      {
        epochId: 'epoch-7', marketId: 'market-1', sequence: '7', ruleVersion: 'm3a-v1',
        configHash: 'ab'.repeat(32), closeRoot: 'closed-root-7', closedAt: new Date(),
        orderCount: 3, maxOrdersPerEpoch: 4, onchainEndIndexExclusive: '2',
      },
    ]));
    await expect(malformed.listReady(10)).rejects.toEqual(new ClosedEpochBatchRepositoryError('INVALID_ROW'));
    await expect(malformed.listReady(0)).rejects.toEqual(new ClosedEpochBatchRepositoryError('INVALID_INPUT'));
  });
});
