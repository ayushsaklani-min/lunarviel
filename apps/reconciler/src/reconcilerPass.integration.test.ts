import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
} from '@lunarveil/crypto';
import type {
  ChainLedgerReaderV1,
  ContractActionSourceV1,
  ContractActionV1,
  ContractStateCommitmentIndexV1,
} from '@lunarveil/chain';
import { ContractActionAdmissionReaderV1 } from '@lunarveil/chain';
import {
  PostgresMarketContractRegistryV1,
  PostgresOrderEnvelopeRepository,
  nodePostgresSerializablePool,
} from '@lunarveil/db';

import { composeReconcilerV1 } from './composition.js';
import type { ReconcilerConfigV1 } from './config.js';

const integrationUrl = process.env.LUNARVEIL_POSTGRES_INTEGRATION_URL;

function disposableUrl(): URL | undefined {
  if (integrationUrl === undefined) return undefined;
  try {
    const url = new URL(integrationUrl);
    if (['postgres:', 'postgresql:'].includes(url.protocol)
      && /^lunarveil_test_[a-z0-9_]+$/i.test(decodeURIComponent(url.pathname.slice(1)))) return url;
  } catch { /* Never print connection strings. */ }
  throw new Error('Integration URL must target a disposable lunarveil_test_* PostgreSQL database');
}

const url = disposableUrl();
const fixtureSchema = `lunarveil_recon_${randomUUID().replaceAll('-', '')}`;
// Prisma is a workspace-local dependency of @lunarveil/db, so it must be
// resolved from that package rather than from this one or the repository root.
const dbRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const prismaCli = join(dirname(dbRequire.resolve('prisma/package.json')), 'build/index.js');
const schemaPath = fileURLToPath(new URL('../../../packages/db/prisma/schema.prisma', import.meta.url));

const MARKET_ID = 'market-reconciler';
// A real whole-byte hex contract address: the registry refuses a placeholder.
const MARKET_CONTRACT_ADDRESS = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';
const EPOCH_ID = 'epoch-reconciler';
const nowMs = 1_800_000_000_000n;

function config(overrides: Partial<ReconcilerConfigV1> = {}): ReconcilerConfigV1 {
  return {
    network: 'preview',
    indexerUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    confirmationDepth: 12,
    requiredMatchingSources: 1,
    intervalMs: 30_000,
    batchSize: 100,
    reorgLookbackMs: 3_600_000,
    ...overrides,
  };
}

async function envelope(overrides: Partial<{ clientRequestId: string; commitment: string }> = {}) {
  const matcher = await generateMatcherDecryptionKeyV1({
    keyId: 'matcher-reconciler-2026-09',
    activeFromMs: nowMs - 1n,
    expiresAtMs: nowMs + 60_000n,
  });
  return sealOrderEnvelopeV1({
    header: {
      clientRequestId: overrides.clientRequestId ?? randomUUID(),
      marketId: MARKET_ID,
      epochId: EPOCH_ID,
      commitment: overrides.commitment ?? randomUUID().replaceAll('-', '').padEnd(64, '0'),
      traderTagHash: '22'.repeat(32),
    },
    matcherKey: matcherPublicKeyV1(matcher),
    plaintext: new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}'),
    nowMs,
  });
}

function prisma(args: readonly string[]): number | null {
  if (!url) throw new Error('Disposable database is required');
  const target = new URL(url);
  target.searchParams.set('schema', fixtureSchema);
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    env: { ...process.env, DATABASE_URL: target.toString(), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
  });
  return result.status;
}

let admin: Pool;
let inspector: Pool;
let schemaUrl: string;

(url ? describe : describe.skip)('reconciler locked scan pass', () => {
  beforeAll(async () => {
    if (!url) throw new Error('Disposable database is required');
    admin = new Pool({ connectionString: url.toString(), max: 1 });
    const database = await admin.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== decodeURIComponent(url.pathname.slice(1))) {
      throw new Error('Disposable database guard failed');
    }
    // The identifier is generated locally, never supplied through the URL.
    await admin.query(`CREATE SCHEMA "${fixtureSchema}"`);
    if (prisma(['migrate', 'deploy', '--schema', schemaPath]) !== 0) {
      throw new Error('Migration failed; private engine diagnostics suppressed');
    }

    const target = new URL(url);
    target.searchParams.set('options', `-c search_path=${fixtureSchema},public -c timezone=UTC`);
    schemaUrl = target.toString();

    inspector = new Pool({
      connectionString: url.toString(), max: 4,
      options: `-c search_path=${fixtureSchema},public -c timezone=UTC`,
    });

    await inspector.query(`INSERT INTO "Market" (
      "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress", "tickSizeAtomic",
      "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch", "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
    ) VALUES ($1, 'NIGHT-USDCX', 'NIGHT', 'USDCX', $2, '1', '1', 60, 4, 2, 'v1', NOW())`,
    [MARKET_ID, MARKET_CONTRACT_ADDRESS]);
    await inspector.query(`INSERT INTO "Epoch" (
      "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt", "onchainStartIndex",
      "configHash", "ruleVersion", "updatedAt"
    ) VALUES ($1, $2, '1', 'OPEN', NOW(), NOW() + INTERVAL '1 hour', '0', $3, 'v1', NOW())`,
    [EPOCH_ID, MARKET_ID, 'ab'.repeat(32)]);
  }, 180_000);

  afterAll(async () => {
    if (inspector) await inspector.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`);
      await admin.end();
    }
  });

  it('accepts a pending order once its admission is deep enough, and not before', async () => {
    const sealed = await envelope();
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(inspector));
    const stored = await repository.submit({ envelope: sealed, clientSignature: new Uint8Array([1]) });

    // Immature: the pass must leave the order pending.
    let tip = 105n;
    const reader: ChainLedgerReaderV1 = {
      async readAdmission() { return { present: true, txId: 'tx-e2e', leafIndex: '0', inclusionHeight: 100n }; },
      async readTipHeight() { return tip; },
    };
    const reconciler = composeReconcilerV1({
      config: config(), databaseUrl: schemaUrl, reader, logLine: () => undefined,
    });
    try {
      const immature = await reconciler.runPass();
      expect(immature.ran).toBe(true);
      expect(immature.accepted).toBe(0);
      const stillPending = await inspector.query<{ state: string }>('SELECT "state" FROM "OrderEnvelope" WHERE "id" = $1', [stored.record.id]);
      expect(stillPending.rows[0]?.state).toBe('PENDING_CHAIN');

      // Mature: the same admission is now accepted.
      tip = 200n;
      const mature = await reconciler.runPass();
      expect(mature.accepted).toBeGreaterThanOrEqual(1);
      const accepted = await inspector.query<{ state: string; chainAdmissionTxId: string }>(
        'SELECT "state", "chainAdmissionTxId" FROM "OrderEnvelope" WHERE "id" = $1', [stored.record.id],
      );
      expect(accepted.rows[0]).toMatchObject({ state: 'ACCEPTED', chainAdmissionTxId: 'tx-e2e' });
    } finally {
      await reconciler.close();
    }
  }, 120_000);

  it('never accepts while the chain is unreadable', async () => {
    const sealed = await envelope();
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(inspector));
    const stored = await repository.submit({ envelope: sealed, clientSignature: new Uint8Array([1]) });

    const reader: ChainLedgerReaderV1 = {
      async readAdmission() { throw new Error('indexer down'); },
      async readTipHeight() { throw new Error('indexer down'); },
    };
    const reconciler = composeReconcilerV1({ config: config(), databaseUrl: schemaUrl, reader, logLine: () => undefined });
    try {
      const result = await reconciler.runPass();
      expect(result.accepted).toBe(0);
      const row = await inspector.query<{ state: string }>('SELECT "state" FROM "OrderEnvelope" WHERE "id" = $1', [stored.record.id]);
      expect(row.rows[0]?.state).toBe('PENDING_CHAIN');
    } finally {
      await reconciler.close();
    }
  }, 120_000);

  it('reports a revoked admission without changing order state', async () => {
    const sealed = await envelope();
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(inspector));
    const stored = await repository.submit({ envelope: sealed, clientSignature: new Uint8Array([1]) });
    await inspector.query(
      `UPDATE "OrderEnvelope" SET "state" = 'ACCEPTED', "chainAdmissionTxId" = 'tx-gone', "leafIndex" = '0',
       "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = $1`, [stored.record.id],
    );

    const lines: string[] = [];
    const reader: ChainLedgerReaderV1 = {
      async readAdmission() { return { present: false }; },
      async readTipHeight() { return 999n; },
    };
    const reconciler = composeReconcilerV1({
      config: config(), databaseUrl: schemaUrl, reader, logLine: line => lines.push(line),
    });
    try {
      const result = await reconciler.runPass();
      expect(result.revoked).toBeGreaterThanOrEqual(1);
      expect(lines.some(line => line.includes('ADMISSION_REVOKED'))).toBe(true);

      // The order stays ACCEPTED: nothing demotes it.
      const row = await inspector.query<{ state: string }>('SELECT "state" FROM "OrderEnvelope" WHERE "id" = $1', [stored.record.id]);
      expect(row.rows[0]?.state).toBe('ACCEPTED');
    } finally {
      await reconciler.close();
    }
  }, 120_000);
  it('accepts through the real market registry, contract-action reader and ledger decoder', async () => {
    // The only fakes here are the indexer transport and the Compact-generated
    // decoder. The market lookup, the admitting-transaction search, consensus
    // and the durable transition are all the production path against real
    // PostgreSQL.
    const commitment = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const sealed = await envelope({ commitment });
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(inspector));
    const stored = await repository.submit({ envelope: sealed, clientSignature: new Uint8Array([1]) });

    const action = (height: bigint, txId: string, leaves: readonly string[]): ContractActionV1 => ({
      address: MARKET_CONTRACT_ADDRESS,
      stateHex: `00${leaves.join('')}`,
      txId,
      blockHeight: height,
    });
    const history: readonly ContractActionV1[] = [
      action(700n, 'deploy-tx', []),
      action(800n, 'admitting-tx', [commitment]),
      action(850n, 'later-tx', [commitment, 'cd'.repeat(32)]),
    ];
    const actions: ContractActionSourceV1 = {
      async readLatestAction() { return history[history.length - 1]; },
      async readActionAtHeight(input) {
        let found: ContractActionV1 | undefined;
        for (const candidate of history) if (candidate.blockHeight <= input.blockHeight) found = candidate;
        return found;
      },
    };
    const membership: ContractStateCommitmentIndexV1 = {
      async locate(input) {
        const leaves: readonly string[] = input.stateHex.slice(2).match(/.{64}/gu) ?? [];
        const index = leaves.indexOf(input.commitment);
        return index < 0 ? { member: false } : { member: true, leafIndex: String(index) };
      },
    };

    const reconciler = composeReconcilerV1({
      config: config(),
      databaseUrl: schemaUrl,
      logLine: () => undefined,
      reader: ({ pool }) => new ContractActionAdmissionReaderV1({
        registry: new PostgresMarketContractRegistryV1(pool),
        actions,
        membership,
        readTipHeight: async () => 900n,
      }),
    });
    try {
      const result = await reconciler.runPass();
      expect(result.ran).toBe(true);
      const row = await inspector.query<{ state: string; chainAdmissionTxId: string; leafIndex: string }>(
        'SELECT "state", "chainAdmissionTxId", "leafIndex" FROM "OrderEnvelope" WHERE "id" = $1', [stored.record.id],
      );
      // The recorded transaction is the one that actually admitted the
      // commitment, not the latest action on the contract.
      expect(row.rows[0]).toMatchObject({ state: 'ACCEPTED', chainAdmissionTxId: 'admitting-tx', leafIndex: '0' });
    } finally {
      await reconciler.close();
    }
  }, 120_000);
});
