import { describe, expect, it } from 'vitest';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';
import {
  PostgresPublicMarketCatalogRepository,
  PublicMarketCatalogRepositoryError,
} from './publicMarketCatalogRepository.js';

type Row = Record<string, unknown>;

class FakeCatalogClient implements SerializableSqlClient {
  readonly commands: Array<{ text: string; values: readonly unknown[] }> = [];
  released = 0;
  markets: readonly Row[] = [
    {
      id: 'market-2', marketKey: 'ZUSD-NIGHT', baseAssetId: 'ZUSD', quoteAssetId: 'NIGHT',
      tickSizeAtomic: '10', lotSizeAtomic: '100', epochDurationSeconds: 60,
      maxOrdersPerEpoch: 100, minBatchPrivacy: 4, matchingRuleVersion: 'v1', status: 'ACTIVE',
    },
    {
      id: 'market-1', marketKey: 'NIGHT-USDCX', baseAssetId: 'NIGHT', quoteAssetId: 'USDCX',
      tickSizeAtomic: '1', lotSizeAtomic: '10', epochDurationSeconds: 60,
      maxOrdersPerEpoch: 100, minBatchPrivacy: 4, matchingRuleVersion: 'v1', status: 'ADMISSION_PAUSED',
    },
  ];
  epochs: readonly Row[] = [{
    id: 'epoch-8', marketId: 'market-1', sequence: '8', state: 'PENDING_FIRMUP', orderCount: 12,
    maxOrders: 100, scheduledCloseAt: new Date('2026-09-04T12:00:00.000Z'), ruleVersion: 'v1', configHash: 'ab'.repeat(32),
  }];

  async query<RowType extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.commands.push({ text, values });
    if (text.includes('FROM "Market"')) return { rows: this.markets as RowType[] };
    if (text.includes('FROM "Epoch"')) return { rows: this.epochs as RowType[] };
    throw new Error(`Unexpected SQL: ${text}`);
  }

  release(): void { this.released += 1; }
}

function pool(client: FakeCatalogClient): SerializableSqlPool {
  return { async connect() { return client; } };
}

describe('PostgresPublicMarketCatalogRepository', () => {
  it('returns only allowlisted public market and current-epoch fields', async () => {
    const client = new FakeCatalogClient();
    const repository = new PostgresPublicMarketCatalogRepository(pool(client));

    expect(await repository.listMarkets()).toEqual(client.markets);
    expect(await repository.currentEpoch('market-1')).toEqual({
      id: 'epoch-8', marketId: 'market-1', sequence: '8', state: 'PENDING_FIRMUP', orderCount: 12,
      maxOrders: 100, scheduledCloseAtMs: '1788523200000', ruleVersion: 'v1', configHash: 'ab'.repeat(32),
    });
    expect(client.commands[0]?.text).toContain('ORDER BY "marketKey" ASC, "id" ASC');
    expect(client.commands[1]?.values).toEqual(['market-1']);
    expect(client.commands.map((command) => command.text).join('\n')).not.toContain('OrderEnvelope');
    expect(client.released).toBe(2);
  });

  it('returns undefined without an active lifecycle epoch', async () => {
    const client = new FakeCatalogClient();
    client.epochs = [];
    const repository = new PostgresPublicMarketCatalogRepository(pool(client));

    expect(await repository.currentEpoch('market-1')).toBeUndefined();
  });

  it('fails closed for malformed public records and connection failures', async () => {
    const client = new FakeCatalogClient();
    client.markets = [{ ...client.markets[0], status: 'UNKNOWN' }];
    const repository = new PostgresPublicMarketCatalogRepository(pool(client));

    await expect(repository.listMarkets()).rejects.toMatchObject({ code: 'INVALID_DATABASE_RECORD' });
    await expect(repository.currentEpoch('')).rejects.toMatchObject({ code: 'INVALID_DATABASE_RECORD' });
    const unavailable = new PostgresPublicMarketCatalogRepository({
      async connect() { throw new Error('network secret should not escape'); },
    });
    await expect(unavailable.listMarkets()).rejects.toEqual(new PublicMarketCatalogRepositoryError('DATABASE_FAILURE'));
  });
});
