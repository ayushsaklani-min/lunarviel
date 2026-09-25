import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { commitOrderIntentV1, sealOrderEnvelopeV1, type OrderIntentV1 } from '@lunarveil/crypto';
import {
  SHARED_DEVELOPMENT_MATCHER_KEY_ID,
  SharedDevelopmentMatcherKeyStoreV1,
  type MatcherKeyResolverV1,
} from '@lunarveil/matcher';

import { composeMatcherWorkerV1 } from './composition.js';
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
const fixtureSchema = `lunarveil_sim_${randomUUID().replaceAll('-', '')}`;
const dbRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const prismaCli = join(dirname(dbRequire.resolve('prisma/package.json')), 'build/index.js');
const schemaPath = fileURLToPath(new URL('../../../packages/db/prisma/schema.prisma', import.meta.url));

const SEED = '5a'.repeat(32);
const NOW = 1_800_000_000_000n;
const CONTRACT = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';

let admin: Pool;
let inspector: Pool;
let schemaUrl: string;
let keys: MatcherKeyResolverV1;
let store: SharedDevelopmentMatcherKeyStoreV1;

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

function config(maliciousMatcher = false): MatcherWorkerConfigV1 {
  return { intervalMs: 10_000, batchSize: 25, simulatedChain: { matcherKeySeedHex: SEED, maliciousMatcher } };
}

async function seedMarket(marketId: string, contract: string): Promise<void> {
  await inspector.query(`INSERT INTO "Market" (
    "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress", "tickSizeAtomic",
    "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch", "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
  ) VALUES ($1, $1, 'NIGHT', 'USDCX', $2, '1', '100', 60, 4, 2, 'rules-v1', NOW())`, [marketId, contract]);
  await inspector.query(`INSERT INTO "Epoch" (
    "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt", "onchainStartIndex",
    "configHash", "ruleVersion", "updatedAt"
  ) VALUES ($1, $2, 1, 'OPEN', to_timestamp($3::bigint / 1000.0), to_timestamp($4::bigint / 1000.0), '0', $5, 'rules-v1', NOW())`,
  [`${marketId}-e1`, marketId, (NOW - 1_000n).toString(), (NOW + 60_000n).toString(), 'ab'.repeat(32)]);
}

/** Seals and inserts one pending order exactly as the API would store it. */
async function submitOrder(input: {
  readonly marketId: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantityLots: bigint;
  readonly price: bigint;
  readonly trader: string;
  readonly corruptCommitment?: boolean;
}): Promise<string> {
  const owner = createHash('sha256').update(input.trader).digest();
  const nonce = new Uint8Array(createHash('sha256').update(`nonce:${randomUUID()}`).digest());
  const blinding = new Uint8Array(createHash('sha256').update(`blinding:${randomUUID()}`).digest());
  const order: OrderIntentV1 = {
    version: 1,
    marketId: new Uint8Array(createHash('sha256').update(input.marketId, 'utf8').digest()),
    epochSequence: 1n,
    ownerPublicKey: new Uint8Array(owner),
    side: input.side,
    orderType: 'LIMIT',
    quantityLots: input.quantityLots,
    limitPriceTicks: input.price,
    minFillLots: 0n,
    tif: 'GFE',
    allowPartial: true,
    nonce,
    createdAtMs: NOW - 500n,
    expiresAtMs: NOW + 3_600_000n,
  };
  const realCommitment = Buffer.from(commitOrderIntentV1(order, blinding)).toString('hex');
  const commitment = input.corruptCommitment === true ? createHash('sha256').update(realCommitment).digest('hex') : realCommitment;
  const plaintext = new TextEncoder().encode(JSON.stringify({
    version: 1,
    ownerPublicKey: owner.toString('hex'),
    side: order.side,
    orderType: 'LIMIT',
    quantityLots: order.quantityLots.toString(),
    limitPriceTicks: order.limitPriceTicks.toString(),
    minFillLots: '0',
    tif: 'GFE',
    allowPartial: true,
    blinding: Array.from(blinding),
    nonce: Array.from(nonce),
    createdAtMs: order.createdAtMs.toString(),
    expiresAtMs: order.expiresAtMs.toString(),
  }));
  const traderTagHash = createHash('sha256').update(`tag:${input.trader}`).digest('hex');
  const envelope = await sealOrderEnvelopeV1({
    header: { clientRequestId: randomUUID(), marketId: input.marketId, epochId: `${input.marketId}-e1`, commitment, traderTagHash },
    matcherKey: store.activePublicKey(NOW),
    plaintext,
    nowMs: NOW - 100n,
  });
  const id = randomUUID();
  await inspector.query(`INSERT INTO "OrderEnvelope" (
    "id", "clientRequestId", "marketId", "epochId", "commitment", "encryptionKeyId", "envelopeAlgorithm",
    "ephemeralPublicKey", "envelopeSalt", "envelopeNonce", "ciphertext", "traderTagHash", "clientSignature",
    "state", "createdAt", "updatedAt"
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '\\x01', 'PENDING_CHAIN', clock_timestamp(), NOW())`, [
    id, envelope.clientRequestId, envelope.marketId, envelope.epochId, envelope.commitment, envelope.encryptionKeyId,
    envelope.algorithm, envelope.ephemeralPublicKey, envelope.salt, envelope.nonce,
    Buffer.from(envelope.ciphertext, 'base64url'), envelope.traderTagHash,
  ]);
  return id;
}

async function orderRow(id: string): Promise<{ state: string; leafIndex: string | null; chainAdmissionTxId: string | null }> {
  const row = (await inspector.query('SELECT "state", "leafIndex", "chainAdmissionTxId" FROM "OrderEnvelope" WHERE "id" = $1', [id])).rows[0];
  if (row === undefined) throw new Error('order missing');
  return row;
}

async function runPass(at: bigint, malicious = false): Promise<void> {
  const worker = composeMatcherWorkerV1({
    config: config(malicious), databaseUrl: schemaUrl, nowMs: () => at, logLine: () => undefined, simulatedChainKeys: keys,
  });
  try {
    await worker.runPass();
  } finally {
    await worker.close();
  }
}

(url ? describe : describe.skip)('simulated chain pass against real PostgreSQL', () => {
  beforeAll(async () => {
    if (!url) throw new Error('Disposable database is required');
    admin = new Pool({ connectionString: url.toString(), max: 1 });
    await admin.query(`CREATE SCHEMA "${fixtureSchema}"`);
    if (prisma(['migrate', 'deploy', '--schema', schemaPath]) !== 0) {
      throw new Error('Migration failed; private engine diagnostics suppressed');
    }
    const target = new URL(url);
    target.searchParams.set('options', `-c search_path=${fixtureSchema},public -c timezone=UTC`);
    schemaUrl = target.toString();
    inspector = new Pool({ connectionString: url.toString(), max: 4, options: `-c search_path=${fixtureSchema},public -c timezone=UTC` });

    store = await SharedDevelopmentMatcherKeyStoreV1.create({
      environment: 'development', seedHex: SEED, keyId: SHARED_DEVELOPMENT_MATCHER_KEY_ID,
      activeFromMs: 0n, expiresAtMs: NOW + 86_400_000n,
    });
    keys = {
      resolveExistingEnvelopeKey: async keyId => ({
        ...store.activePublicKey(NOW),
        privateKey: await store.resolvePrivateKey({ keyId, privateKeyRef: store.privateKeyRef }),
      }),
    };
  }, 180_000);

  afterAll(async () => {
    if (inspector) await inspector.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`);
      await admin.end();
    }
  });

  it('admits, freezes, matches, verifies, finalizes and rolls an epoch end to end', async () => {
    await seedMarket('market-sim', CONTRACT);
    const buyer = await submitOrder({ marketId: 'market-sim', side: 'BUY', quantityLots: 10n, price: 101n, trader: 'alice' });
    const seller = await submitOrder({ marketId: 'market-sim', side: 'SELL', quantityLots: 6n, price: 100n, trader: 'bob' });
    const lowBid = await submitOrder({ marketId: 'market-sim', side: 'BUY', quantityLots: 5n, price: 90n, trader: 'carol' });
    const forged = await submitOrder({ marketId: 'market-sim', side: 'BUY', quantityLots: 5n, price: 101n, trader: 'mallory', corruptCommitment: true });

    // While the epoch is open: valid orders are admitted at contiguous leaves;
    // an envelope whose opening does not match its commitment never is.
    await runPass(NOW);
    expect(await orderRow(buyer)).toMatchObject({ state: 'ACCEPTED', leafIndex: '0' });
    expect(await orderRow(seller)).toMatchObject({ state: 'ACCEPTED', leafIndex: '1' });
    expect(await orderRow(lowBid)).toMatchObject({ state: 'ACCEPTED', leafIndex: '2' });
    expect((await orderRow(forged)).state).toBe('REJECTED');
    expect((await orderRow(buyer)).chainAdmissionTxId).toMatch(/^simulated:[0-9a-f]{64}$/u);

    // After the scheduled close: the whole lifecycle completes in one pass.
    const after = NOW + 61_000n;
    await runPass(after);

    const epoch = (await inspector.query(
      `SELECT "state", "orderCount", "closeRoot", "finalSolutionCommitment", "batchProofTxId", "settlementTxId"
       FROM "Epoch" WHERE "id" = 'market-sim-e1'`,
    )).rows[0];
    expect(epoch).toMatchObject({ state: 'FINALIZED', orderCount: 3 });
    expect(epoch.closeRoot).toMatch(/^simulated:/u);
    expect(epoch.batchProofTxId).toMatch(/^simulated:/u);
    expect(epoch.settlementTxId).toMatch(/^simulated:/u);

    const batch = (await inspector.query(
      `SELECT "status", "clearingPriceTicks", "publicVolume", "sanitizedMatchedCount", "rejectedSolutionCount", "encryptedSolution"
       FROM "BatchSolutionRecord" WHERE "epochId" = 'market-sim-e1'`,
    )).rows[0];
    expect(batch).toMatchObject({ status: 'FINALIZED_SIMULATED', publicVolume: '6', sanitizedMatchedCount: 2, rejectedSolutionCount: 0, encryptedSolution: null });
    expect(BigInt(batch.clearingPriceTicks)).toBeGreaterThanOrEqual(100n);
    expect(BigInt(batch.clearingPriceTicks)).toBeLessThanOrEqual(101n);

    expect((await orderRow(buyer)).state).toBe('PARTIALLY_FILLED');
    expect((await orderRow(seller)).state).toBe('FILLED');
    expect((await orderRow(lowBid)).state).toBe('EXPIRED');

    // The next epoch opened with the frozen configuration carried over.
    const next = (await inspector.query(
      `SELECT "sequence"::text AS "sequence", "state", "configHash", "ruleVersion",
         (extract(epoch from "scheduledCloseAt") * 1000)::bigint::text AS "closeAt"
       FROM "Epoch" WHERE "marketId" = 'market-sim' AND "state" = 'OPEN'`,
    )).rows;
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ sequence: '2', configHash: 'ab'.repeat(32), ruleVersion: 'rules-v1', closeAt: (after + 60_000n).toString() });

    // A repeat pass is a no-op: nothing re-finalizes, no second epoch opens.
    await runPass(after + 1_000n);
    const openCount = await inspector.query(`SELECT COUNT(*)::int AS n FROM "Epoch" WHERE "marketId" = 'market-sim' AND "state" = 'OPEN'`);
    expect(openCount.rows[0].n).toBe(1);
    expect((await orderRow(seller)).state).toBe('FILLED');
  }, 120_000);

  it('rejects a malicious matcher solution and still finalizes the honest one', async () => {
    await seedMarket('market-mal', 'ab'.repeat(32));
    await submitOrder({ marketId: 'market-mal', side: 'BUY', quantityLots: 4n, price: 105n, trader: 'dave' });
    await submitOrder({ marketId: 'market-mal', side: 'SELL', quantityLots: 4n, price: 100n, trader: 'erin' });
    await runPass(NOW, true);
    await runPass(NOW + 61_000n, true);

    const batch = (await inspector.query(
      `SELECT b."rejectedSolutionCount", b."publicVolume", e."state"
       FROM "BatchSolutionRecord" b JOIN "Epoch" e ON e."id" = b."epochId" WHERE b."epochId" = 'market-mal-e1'`,
    )).rows[0];
    expect(batch).toMatchObject({ rejectedSolutionCount: 1, publicVolume: '4', state: 'FINALIZED' });
  }, 120_000);

  it('recovers an epoch stranded in PROVING by deterministic replay', async () => {
    await seedMarket('market-crash', 'cd'.repeat(32));
    await submitOrder({ marketId: 'market-crash', side: 'BUY', quantityLots: 3n, price: 100n, trader: 'frank' });
    await submitOrder({ marketId: 'market-crash', side: 'SELL', quantityLots: 3n, price: 100n, trader: 'grace' });
    await runPass(NOW);
    await runPass(NOW + 61_000n);
    // Simulate a crash after beginProving: roll the finalization back by hand.
    await inspector.query(`UPDATE "Epoch" SET "state" = 'PROVING', "finalSolutionCommitment" = NULL WHERE "id" = 'market-crash-e1'`);
    await inspector.query(`UPDATE "OrderEnvelope" SET "state" = 'ACCEPTED' WHERE "epochId" = 'market-crash-e1'`);

    await runPass(NOW + 62_000n);
    const epoch = (await inspector.query(`SELECT "state" FROM "Epoch" WHERE "id" = 'market-crash-e1'`)).rows[0];
    expect(epoch.state).toBe('FINALIZED');
    const states = await inspector.query(`SELECT "state" FROM "OrderEnvelope" WHERE "epochId" = 'market-crash-e1'`);
    expect(states.rows.map(row => row.state).sort()).toEqual(['FILLED', 'FILLED']);
  }, 120_000);

  it('refuses to compose the simulator without its matcher keys', () => {
    expect(() => composeMatcherWorkerV1({ config: config(), databaseUrl: schemaUrl, logLine: () => undefined }))
      .toThrow('SIMULATED_CHAIN_KEYS_MISMATCH');
  });
});
