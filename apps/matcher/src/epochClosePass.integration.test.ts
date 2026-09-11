import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { composeMatcherWorkerV1, type ComposedMatcherWorkerV1 } from './composition.js';
import type { MatcherWorkerConfigV1 } from './config.js';

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
const fixtureSchema = `lunarveil_epoch_${randomUUID().replaceAll('-', '')}`;
const dbRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const prismaCli = join(dirname(dbRequire.resolve('prisma/package.json')), 'build/index.js');
const schemaPath = fileURLToPath(new URL('../../../packages/db/prisma/schema.prisma', import.meta.url));

const MARKET_ID = 'market-epoch';
const CONFIG_HASH = 'ab'.repeat(32);
const NOW = 1_800_000_000_000n;

function config(overrides: Partial<MatcherWorkerConfigV1> = {}): MatcherWorkerConfigV1 {
  return { intervalMs: 10_000, batchSize: 25, ...overrides };
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

// Sequences must be unique per market, so they come from a counter rather
// than anything derived from the epoch id.
let nextSequence = 1n;

async function seedEpoch(id: string, options: {
  readonly closeOffsetMs: number;
  readonly state?: string;
  readonly configHash?: string;
}): Promise<void> {
  const closeAt = new Date(Number(NOW) + options.closeOffsetMs).toISOString();
  await inspector.query(`INSERT INTO "Epoch" (
    "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt", "onchainStartIndex",
    "configHash", "ruleVersion", "updatedAt"
  ) VALUES ($1, $2, $3, $4, '2027-01-15T07:00:00Z', $5, '0', $6, 'rules-v1', NOW())`,
  [id, MARKET_ID, nextSequence++, options.state ?? 'OPEN', closeAt, options.configHash ?? CONFIG_HASH]);
}

async function stateOf(epochId: string): Promise<{ state: string; orderCount: number; closedAt: Date | null }> {
  const row = await inspector.query<{ state: string; orderCount: number; closedAt: Date | null }>(
    'SELECT "state", "orderCount", "closedAt" FROM "Epoch" WHERE "id" = $1', [epochId],
  );
  const value = row.rows[0];
  if (value === undefined) throw new Error('epoch missing');
  return value;
}

(url ? describe : describe.skip)('epoch close pass against real PostgreSQL', () => {
  beforeAll(async () => {
    if (!url) throw new Error('Disposable database is required');
    admin = new Pool({ connectionString: url.toString(), max: 1 });
    const database = await admin.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== decodeURIComponent(url.pathname.slice(1))) {
      throw new Error('Disposable database guard failed');
    }
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
    ) VALUES ($1, 'NIGHT-USDCX', 'NIGHT', 'USDCX', $2, '5', '100', 300, 4, 2, 'rules-v1', NOW())`,
    [MARKET_ID, '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91']);
  }, 180_000);

  afterAll(async () => {
    if (inspector) await inspector.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`);
      await admin.end();
    }
  });

  it('closes an epoch whose scheduled close has passed, and leaves a future one open', async () => {
    await seedEpoch('epoch-due', { closeOffsetMs: -60_000 });
    await seedEpoch('epoch-future', { closeOffsetMs: 600_000 });

    const worker = composeMatcherWorkerV1({
      config: config(), databaseUrl: schemaUrl, nowMs: () => NOW, logLine: () => undefined,
    });
    try {
      const result = await worker.runPass();
      expect(result.closed).toBeGreaterThanOrEqual(1);

      const due = await stateOf('epoch-due');
      expect(due.state).toBe('CLOSED');
      expect(due.closedAt).not.toBeNull();

      // A future epoch must not be touched: closing early would freeze a root
      // before its orders had their full window.
      expect((await stateOf('epoch-future')).state).toBe('OPEN');
    } finally {
      await worker.close();
    }
  }, 120_000);

  it('is idempotent: a second pass closes nothing again', async () => {
    await seedEpoch('epoch-twice', { closeOffsetMs: -60_000 });

    const worker = composeMatcherWorkerV1({
      config: config(), databaseUrl: schemaUrl, nowMs: () => NOW, logLine: () => undefined,
    });
    try {
      await worker.runPass();
      const closedAt = (await stateOf('epoch-twice')).closedAt;

      const second = await worker.runPass();
      expect(second.closed).toBe(0);
      // The original close time stands; a repeat pass must not rewrite it.
      expect((await stateOf('epoch-twice')).closedAt?.getTime()).toBe(closedAt?.getTime());
    } finally {
      await worker.close();
    }
  }, 120_000);

  it('records the admitted order count, not the pending one', async () => {
    await seedEpoch('epoch-counted', { closeOffsetMs: -60_000 });

    // Two admitted orders and one still awaiting chain admission. Only the
    // admitted ones are part of the set this epoch closes over.
    for (const [index, state] of [['1', 'ACCEPTED'], ['2', 'ACCEPTED'], ['3', 'PENDING_CHAIN']] as const) {
      await inspector.query(
        `INSERT INTO "OrderEnvelope" ("id", "clientRequestId", "marketId", "epochId", "commitment",
          "encryptionKeyId", "envelopeAlgorithm", "ephemeralPublicKey", "envelopeSalt", "envelopeNonce",
          "ciphertext", "traderTagHash", "clientSignature", "state", "updatedAt")
         VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'epoch-counted', $2,
          'k', 'a', 'e', 's', 'n', '\\x01', $3, '\\x01', $4, NOW())`,
        [MARKET_ID, index.repeat(64), '22'.repeat(32), state],
      );
    }

    const worker = composeMatcherWorkerV1({
      config: config(), databaseUrl: schemaUrl, nowMs: () => NOW, logLine: () => undefined,
    });
    try {
      await worker.runPass();
      const closed = await stateOf('epoch-counted');
      expect(closed.state).toBe('CLOSED');
      expect(closed.orderCount).toBe(2);
    } finally {
      await worker.close();
    }
  }, 120_000);

  it('refuses to close an epoch with more admitted orders than the market allows', async () => {
    await seedEpoch('epoch-overfull', { closeOffsetMs: -60_000 });
    for (let index = 0; index < 5; index += 1) {
      await inspector.query(
        `INSERT INTO "OrderEnvelope" ("id", "clientRequestId", "marketId", "epochId", "commitment",
          "encryptionKeyId", "envelopeAlgorithm", "ephemeralPublicKey", "envelopeSalt", "envelopeNonce",
          "ciphertext", "traderTagHash", "clientSignature", "state", "updatedAt")
         VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'epoch-overfull', $2,
          'k', 'a', 'e', 's', 'n', '\\x01', $3, '\\x01', 'ACCEPTED', NOW())`,
        [MARKET_ID, `a${index}`.repeat(32), '33'.repeat(32)],
      );
    }

    const lines: string[] = [];
    const worker = composeMatcherWorkerV1({
      config: config(), databaseUrl: schemaUrl, nowMs: () => NOW, logLine: line => lines.push(line),
    });
    try {
      const result = await worker.runPass();
      expect(result.refused).toBeGreaterThanOrEqual(1);
      // Left OPEN and reported loudly: visible and recoverable beats forced.
      expect((await stateOf('epoch-overfull')).state).toBe('OPEN');
      expect(lines.some(line => line.includes('EPOCH_CLOSE_REFUSED'))).toBe(true);
    } finally {
      await worker.close();
    }
  }, 120_000);

  it('never closes an epoch that has already moved past OPEN', async () => {
    await seedEpoch('epoch-settling', { closeOffsetMs: -60_000, state: 'SETTLING' });

    const worker = composeMatcherWorkerV1({
      config: config(), databaseUrl: schemaUrl, nowMs: () => NOW, logLine: () => undefined,
    });
    try {
      await worker.runPass();
      expect((await stateOf('epoch-settling')).state).toBe('SETTLING');
    } finally {
      await worker.close();
    }
  }, 120_000);
});
