import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generateMatcherDecryptionKeyV1, matcherPublicKeyV1, sealOrderEnvelopeV1 } from '@lunarveil/crypto';
import { nodePostgresSerializablePool, PostgresOrderEnvelopeRepository } from './orderEnvelopeRepository.js';
import { PostgresPublicMarketCatalogRepository } from './publicMarketCatalogRepository.js';
import { PostgresSettlementParticipantPayloadRepository } from './settlementParticipantPayloadRepository.js';
import { PostgresChainAdmissionReconciliationRepository } from './chainAdmissionReconciliationRepository.js';
import { PostgresRateLimitWindowRepository } from './rateLimitWindowRepository.js';
import { PostgresPendingChainOrderSourceV1 } from './pendingChainOrderSource.js';
import { PostgresAcceptedAdmissionSourceV1 } from './acceptedAdmissionSource.js';
import { MarketContractRegistryDbError, PostgresMarketContractRegistryV1 } from './marketContractRegistry.js';
import { PostgresTraderOrderHistoryRepositoryV1 } from './traderOrderHistoryRepository.js';
import { PostgresAdvisoryLockV1 } from './advisoryLock.js';
import { PostgresOrderAdmissionSubmissionRepositoryV1 } from './orderAdmissionSubmissionRepository.js';

// The verified M3 Preview deployment address; the registry only accepts a
// real whole-byte hex address, so the fixture must carry a real-shaped one.
const MARKET_CONTRACT_ADDRESS = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';

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
const fixtureSchema = `lunarveil_full_${randomUUID().replaceAll('-', '')}`;
const prismaCli = join(dirname(createRequire(import.meta.url).resolve('prisma/package.json')), 'build/index.js');
const schemaPath = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
let pool: Pool;
let admin: Pool;
let createdSchema = false;

function prisma(args: string[]): { status: number | null; stdout: string } {
  if (!url) throw new Error('Disposable database is required');
  const target = new URL(url);
  target.searchParams.set('schema', fixtureSchema);
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    env: { ...process.env, DATABASE_URL: target.toString(), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  // Engine/parser errors can contain connection material; expose only schema diffs.
  return { status: result.status, stdout: result.status === 2 ? result.stdout : '' };
}

async function seedEpoch(id: string, sequence: string, state = 'OPEN') {
  await pool.query(`INSERT INTO "Epoch" (
    "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt", "onchainStartIndex",
    "configHash", "ruleVersion", "updatedAt"
  ) VALUES ($1, 'market-full', $2, $3, '2026-09-06T00:00:00Z', '2026-09-06T00:01:00Z', '0', $4, 'rules-v1', NOW())`,
  [id, sequence, state, 'ab'.repeat(32)]);
}

async function envelope() {
  const nowMs = 1_800_000_000_000n;
  const key = await generateMatcherDecryptionKeyV1({ keyId: 'full-schema-key', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 60_000n });
  const plaintext = new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}');
  try {
    return await sealOrderEnvelopeV1({
      header: { clientRequestId: randomUUID(), marketId: 'market-full', epochId: 'epoch-full',
        commitment: randomUUID().replaceAll('-', '').repeat(2), traderTagHash: '22'.repeat(32) },
      matcherKey: matcherPublicKeyV1(key), plaintext, nowMs,
    });
  } finally { plaintext.fill(0); }
}

(url ? describe : describe.skip)('full PostgreSQL schema and repositories', () => {
  beforeAll(async () => {
    if (!url) throw new Error('Disposable database is required');
    admin = new Pool({ connectionString: url.toString(), max: 1 });
    const database = await admin.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== decodeURIComponent(url.pathname.slice(1))) throw new Error('Disposable database guard failed');
    // The identifier is generated locally, never supplied through the URL.
    await admin.query(`CREATE SCHEMA "${fixtureSchema}"`);
    createdSchema = true;
    const migration = prisma(['migrate', 'deploy', '--schema', schemaPath]);
    if (migration.status !== 0) throw new Error('Full-schema migration failed; private engine diagnostics suppressed');
    pool = new Pool({ connectionString: url.toString(), max: 4,
      options: `-c search_path=${fixtureSchema},public -c timezone=UTC` });
    await pool.query(`INSERT INTO "Market" (
      "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress", "tickSizeAtomic",
      "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch", "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
    ) VALUES ('market-full', 'NIGHT-USDCX', 'night', 'usdcx', '${MARKET_CONTRACT_ADDRESS}', '1', '100', 60, 4, 2, 'rules-v1', NOW())`);
    await seedEpoch('epoch-full', '7');
    await pool.query(`INSERT INTO "BatchSolutionRecord" (
      "id", "epochId", "ruleVersion", "solutionCommitment", "status", "sanitizedOrderCount", "updatedAt"
    ) VALUES ('batch-full', 'epoch-full', 'rules-v1', 'test-solution', 'PROVED', 2, NOW())`);
    await pool.query(`INSERT INTO "SettlementSession" (
      "id", "batchId", "adapterType", "idempotencyKey", "state", "updatedAt"
    ) VALUES ('session-full', 'batch-full', 'pairwise-v1', 'session-full-request', 'COLLECTING', NOW())`);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try {
        if (createdSchema) {
          const database = await admin.query<{ name: string }>('SELECT current_database() AS name');
          if (database.rows[0]?.name === decodeURIComponent(url!.pathname.slice(1))
            && /^lunarveil_full_[0-9a-f]{32}$/.test(fixtureSchema)) {
            await admin.query(`DROP SCHEMA "${fixtureSchema}" CASCADE`);
          }
        }
      } finally { await admin.end(); }
    }
  });

  it('applies every migration once and matches the complete Prisma datamodel', () => {
    expect(prisma(['migrate', 'deploy', '--schema', schemaPath]).status).toBe(0);
    const diff = prisma(['migrate', 'diff', '--from-schema-datasource', schemaPath,
      '--to-schema-datamodel', schemaPath, '--exit-code']);
    expect(diff, 'Migration chain must match the Prisma model').toEqual({ status: 0, stdout: '' });
  }, 90_000);

  it('inserts and replays encrypted orders with real timestamps, enums and foreign keys', async () => {
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));
    const input = { envelope: await envelope(), clientSignature: new Uint8Array([7]) };
    const first = await repository.submit(input);
    expect(first.replayed).toBe(false);
    expect(await repository.submit(input)).toEqual({ ...first, replayed: true });
    const stored = await pool.query('SELECT "updatedAt", "state" FROM "OrderEnvelope" WHERE "id" = $1', [first.record.id]);
    expect(stored.rows[0]?.updatedAt).toBeInstanceOf(Date);
    expect(stored.rows[0]?.state).toBe('PENDING_CHAIN');
    const reconciliation = new PostgresChainAdmissionReconciliationRepository(nodePostgresSerializablePool(pool));
    await pool.query('UPDATE "OrderEnvelope" SET "updatedAt" = $2 WHERE "id" = $1', [first.record.id, new Date('2020-01-01Z')]);
    const decision = { action: 'ACCEPT', code: 'ADMISSION_CONFIRMED', sourceIds: ['node-a', 'indexer-b'],
      admission: { marketId: input.envelope.marketId, epochId: input.envelope.epochId,
        commitment: input.envelope.commitment, txId: 'public-test-tx', leafIndex: '0' } } as const;
    expect(await reconciliation.apply(first.record.id, decision)).toEqual({ state: 'ACCEPTED', replayed: false });
    expect(await reconciliation.apply(first.record.id, decision)).toEqual({ state: 'ACCEPTED', replayed: true });
    const accepted = await pool.query('SELECT "updatedAt", "acceptedAt" FROM "OrderEnvelope" WHERE "id" = $1', [first.record.id]);
    expect(accepted.rows[0]?.updatedAt.getTime()).toBe(accepted.rows[0]?.acceptedAt.getTime());
  });

  it('claims each pending admission once and preserves uncertain outcomes for reconciliation', async () => {
    const orders = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));
    const submissions = new PostgresOrderAdmissionSubmissionRepositoryV1(nodePostgresSerializablePool(pool));
    const firstInput = { envelope: await envelope(), clientSignature: new Uint8Array([7]) };
    const first = await orders.submit(firstInput);

    const candidates = await submissions.listCandidates(10);
    const candidate = candidates.find(value => value.orderId === first.record.id);
    expect(candidate).toEqual({
      orderId: first.record.id,
      clientRequestId: firstInput.envelope.clientRequestId,
      marketId: 'market-full',
      epochId: 'epoch-full',
      epochSequence: 7n,
      contractAddress: MARKET_CONTRACT_ADDRESS,
      commitment: firstInput.envelope.commitment,
    });
    expect(await submissions.claim(first.record.id)).toEqual({ claimed: true });
    expect(await submissions.claim(first.record.id)).toEqual({ claimed: false, state: 'ATTEMPTING' });
    await submissions.markUncertain(first.record.id);
    expect((await submissions.listCandidates(10)).some(value => value.orderId === first.record.id)).toBe(false);

    const stored = await pool.query(
      'SELECT "state", "publicTxId", "lastErrorCode" FROM "OrderAdmissionSubmission" WHERE "orderId" = $1',
      [first.record.id],
    );
    expect(stored.rows).toEqual([{
      state: 'UNCERTAIN', publicTxId: null, lastErrorCode: 'SUBMISSION_OUTCOME_UNCERTAIN',
    }]);
  });

  it('rejects an order referencing a missing epoch without persisting anything', async () => {
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));
    const original = await envelope();
    await expect(repository.submit({ envelope: { ...original, epochId: 'missing-epoch' }, clientSignature: new Uint8Array([7]) }))
      .rejects.toMatchObject({ code: 'DATABASE_FAILURE' });
    const stored = await pool.query('SELECT "id" FROM "OrderEnvelope" WHERE "clientRequestId" = $1', [original.clientRequestId]);
    expect(stored.rows).toEqual([]);
  });

  it('returns only public catalog fields and the newest nonterminal epoch using exact bigint ordering', async () => {
    const catalog = new PostgresPublicMarketCatalogRepository(nodePostgresSerializablePool(pool));
    const markets = await catalog.listMarkets();
    expect(markets).toEqual([{ id: 'market-full', marketKey: 'NIGHT-USDCX', baseAssetId: 'night', quoteAssetId: 'usdcx',
      tickSizeAtomic: '1', lotSizeAtomic: '100', epochDurationSeconds: 60, maxOrdersPerEpoch: 4,
      minBatchPrivacy: 2, matchingRuleVersion: 'rules-v1', status: 'ACTIVE' }]);
    await seedEpoch('epoch-later', '9007199254740993', 'PROVING');
    await seedEpoch('epoch-finalized', '9007199254740994', 'FINALIZED');
    await seedEpoch('epoch-invalidated', '9007199254740995', 'INVALIDATED');
    expect(await catalog.currentEpoch('market-full')).toEqual({ id: 'epoch-later', marketId: 'market-full',
      sequence: '9007199254740993', state: 'PROVING', orderCount: 0, maxOrders: 4,
      scheduledCloseAtMs: String(Date.parse('2026-09-06T00:01:00Z')), ruleVersion: 'rules-v1', configHash: 'ab'.repeat(32) });
    expect(await catalog.currentEpoch('missing-market')).toBeUndefined();
  });

  it('fails closed on malformed catalog rows', async () => {
    const catalog = new PostgresPublicMarketCatalogRepository(nodePostgresSerializablePool(pool));
    await pool.query('UPDATE "Market" SET "maxOrdersPerEpoch" = -1 WHERE "id" = $1', ['market-full']);
    try { await expect(catalog.listMarkets()).rejects.toMatchObject({ code: 'INVALID_DATABASE_RECORD' }); }
    finally { await pool.query('UPDATE "Market" SET "maxOrdersPerEpoch" = 4 WHERE "id" = $1', ['market-full']); }
  });

  it('stores firm-up ciphertext once, rejects changed reuse and returns only a receipt', async () => {
    const repository = new PostgresSettlementParticipantPayloadRepository(nodePostgresSerializablePool(pool));
    const input = { sessionId: 'session-full', traderTagHash: 'aa'.repeat(32), ciphertextPayload: new Uint8Array([1, 2, 3]) };
    const first = await repository.submit(input);
    expect(first.replayed).toBe(false);
    expect(first.record).not.toHaveProperty('ciphertextPayload');
    expect(await repository.submit(input)).toEqual({ ...first, replayed: true });
    await expect(repository.submit({ ...input, ciphertextPayload: new Uint8Array([4, 5]) }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const rows = await pool.query('SELECT "ciphertextPayload" FROM "SettlementParticipantPayload" WHERE "id" = $1', [first.record.id]);
    expect(rows.rows[0]?.ciphertextPayload).toEqual(Buffer.from(input.ciphertextPayload));
  });

  it('handles concurrent identical firm-up retries without duplicate rows', async () => {
    const repository = new PostgresSettlementParticipantPayloadRepository(nodePostgresSerializablePool(pool));
    const input = { sessionId: 'session-full', traderTagHash: 'bb'.repeat(32), ciphertextPayload: new Uint8Array([8, 9]) };
    const results = await Promise.all([repository.submit(input), repository.submit(input)]);
    expect(results.filter(result => !result.replayed)).toHaveLength(1);
    expect(results[0]?.record).toEqual(results[1]?.record);
  });

  it('rejects missing sessions and internal ID collisions without leaving payload rows', async () => {
    const repository = new PostgresSettlementParticipantPayloadRepository(nodePostgresSerializablePool(pool), { newId: () => 'payload-collision' });
    const input = { sessionId: 'session-full', traderTagHash: 'cc'.repeat(32), ciphertextPayload: new Uint8Array([8]) };
    await repository.submit(input);
    await expect(repository.submit({ ...input, traderTagHash: 'dd'.repeat(32) })).rejects.toMatchObject({ code: 'DATABASE_CONFLICT' });
    const other = new PostgresSettlementParticipantPayloadRepository(nodePostgresSerializablePool(pool));
    await expect(other.submit({ ...input, sessionId: 'missing-session' })).rejects.toMatchObject({ code: 'DATABASE_FAILURE' });
    const rows = await pool.query('SELECT "id" FROM "SettlementParticipantPayload" WHERE "traderTagHash" = $1', ['dd'.repeat(32)]);
    expect(rows.rows).toEqual([]);
  });
  it('shares one rate-limit window across independent limiter instances', async () => {
    const key = `ip:198.51.100.7:/v1/orders:${randomUUID()}`;
    const processA = new PostgresRateLimitWindowRepository(nodePostgresSerializablePool(pool), 3, 60_000n);
    const processB = new PostgresRateLimitWindowRepository(nodePostgresSerializablePool(pool), 3, 60_000n);

    // Two separate limiter instances stand in for two horizontally scaled API processes.
    expect(await processA.consume(key)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await processB.consume(key)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await processA.consume(key)).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const denied = await processB.consume(key);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);

    const stored = await pool.query<{ count: number }>('SELECT "count" FROM "ApiRateLimitWindow" WHERE "key" = $1', [key]);
    expect(stored.rows[0]?.count).toBe(4);

    // The counter saturates one above the limit instead of growing without bound.
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await processA.consume(key)).allowed).toBe(false);
    const saturated = await pool.query<{ count: number }>('SELECT "count" FROM "ApiRateLimitWindow" WHERE "key" = $1', [key]);
    expect(saturated.rows[0]?.count).toBe(4);
  });

  it('starts a new window after the configured interval and keeps keys independent', async () => {
    const key = `ip:198.51.100.8:/v1/orders:${randomUUID()}`;
    const other = `ip:198.51.100.9:/v1/orders:${randomUUID()}`;
    const limiter = new PostgresRateLimitWindowRepository(nodePostgresSerializablePool(pool), 1, 60_000n);

    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(false);
    expect((await limiter.consume(other)).allowed).toBe(true);

    // Age the window using the database clock rather than sleeping through it.
    await pool.query(`UPDATE "ApiRateLimitWindow" SET "windowStartedAt" = NOW() - INTERVAL '61 seconds' WHERE "key" = $1`, [key]);
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(false);
    expect((await limiter.consume(other)).allowed).toBe(false);
  });

  it('prunes only windows that can no longer deny a request', async () => {
    const stale = `ip:198.51.100.10:/v1/orders:${randomUUID()}`;
    const fresh = `ip:198.51.100.11:/v1/orders:${randomUUID()}`;
    const limiter = new PostgresRateLimitWindowRepository(nodePostgresSerializablePool(pool), 5, 60_000n);
    await limiter.consume(stale);
    await limiter.consume(fresh);
    await pool.query(`UPDATE "ApiRateLimitWindow" SET "windowStartedAt" = NOW() - INTERVAL '10 minutes' WHERE "key" = $1`, [stale]);

    expect(await limiter.pruneExpired()).toBeGreaterThanOrEqual(1);
    const remaining = await pool.query<{ key: string }>('SELECT "key" FROM "ApiRateLimitWindow" WHERE "key" = ANY($1)', [[stale, fresh]]);
    expect(remaining.rows.map(row => row.key)).toEqual([fresh]);
  });

  it('scans pending chain orders in a deterministic order against the real schema', async () => {
    const source = new PostgresPendingChainOrderSourceV1(nodePostgresSerializablePool(pool));
    const before = await source.listPending(50);

    const envelopeA = await envelope();
    const envelopeB = await envelope();
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));
    const storedA = await repository.submit({ envelope: envelopeA, clientSignature: new Uint8Array([1]) });
    const storedB = await repository.submit({ envelope: envelopeB, clientSignature: new Uint8Array([1]) });

    const after = await source.listPending(50);
    const added = after.filter(order => !before.some(existing => existing.orderId === order.orderId));
    expect(added.map(order => order.orderId)).toEqual([storedA.record.id, storedB.record.id]);
    for (const order of added) {
      expect(Object.keys(order).sort()).toEqual(['commitment', 'epochId', 'marketId', 'orderId', 'state']);
      expect(order.state).toBe('PENDING_CHAIN');
    }

    // Repeated scans are stable.
    expect((await source.listPending(50)).map(order => order.orderId)).toEqual(after.map(order => order.orderId));
  });

  it('grants the advisory lock to only one holder at a time', async () => {
    const lockName = `lunarveil:test:${randomUUID().slice(0, 8)}`;
    const first = new PostgresAdvisoryLockV1(nodePostgresSerializablePool(pool), lockName);
    const second = new PostgresAdvisoryLockV1(nodePostgresSerializablePool(pool), lockName);

    let innerRan = false;
    const outer = await first.runExclusively(async () => {
      // A second holder must be refused while the first still holds the lock.
      const blocked = await second.runExclusively(async () => { innerRan = true; return 'inner'; });
      expect(blocked).toEqual({ ran: false });
      return 'outer';
    });
    expect(outer).toEqual({ ran: true, result: 'outer' });
    expect(innerRan).toBe(false);

    // The lock is available again once released.
    expect(await second.runExclusively(async () => 'after')).toEqual({ ran: true, result: 'after' });
  });

  it('lists only recently accepted admissions within the lookback window', async () => {
    const source = new PostgresAcceptedAdmissionSourceV1(nodePostgresSerializablePool(pool));
    const sealed = await envelope();
    const repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));
    const stored = await repository.submit({ envelope: sealed, clientSignature: new Uint8Array([1]) });

    await pool.query(
      `UPDATE "OrderEnvelope" SET "state" = 'ACCEPTED', "chainAdmissionTxId" = $2, "leafIndex" = '3',
       "acceptedAt" = NOW(), "updatedAt" = NOW() WHERE "id" = $1`,
      [stored.record.id, 'tx-recheck'],
    );

    const recent = await source.listRecentlyAccepted({ limit: 50, lookbackMs: 3_600_000 });
    expect(recent.some(row => row.orderId === stored.record.id && row.marketId === 'market-full'
      && row.txId === 'tx-recheck' && row.leafIndex === '3')).toBe(true);

    // Ageing the acceptance past the window removes it from the scan.
    await pool.query(`UPDATE "OrderEnvelope" SET "acceptedAt" = NOW() - INTERVAL '2 hours' WHERE "id" = $1`, [stored.record.id]);
    const aged = await source.listRecentlyAccepted({ limit: 50, lookbackMs: 3_600_000 });
    expect(aged.some(row => row.orderId === stored.record.id)).toBe(false);
  });

  it('resolves a market to its deployed contract address, and fails closed otherwise', async () => {
    const registry = new PostgresMarketContractRegistryV1(nodePostgresSerializablePool(pool));

    expect(await registry.resolveContractAddress('market-full')).toBe(MARKET_CONTRACT_ADDRESS);
    // An unknown market is a normal condition, not a failure.
    expect(await registry.resolveContractAddress('market-absent')).toBeUndefined();

    await pool.query(`INSERT INTO "Market" (
      "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress", "tickSizeAtomic",
      "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch", "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
    ) VALUES ('market-malformed', 'BAD-PAIR', 'night', 'usdcx', 'not-an-address', '1', '100', 60, 4, 2, 'rules-v1', NOW())`);
    // A market whose stored address is unusable must never be silently treated
    // as a market without a contract.
    await expect(registry.resolveContractAddress('market-malformed'))
      .rejects.toThrow(new MarketContractRegistryDbError('INVALID_ROW'));
  });
  it("lists only the calling trader's own orders, with no ciphertext column", async () => {
    const repository = new PostgresTraderOrderHistoryRepositoryV1(nodePostgresSerializablePool(pool));
    const orders = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));

    const mine = await orders.submit({ envelope: await envelope(), clientSignature: new Uint8Array([1]) });
    // A second order under a different trader tag must never be returned.
    const theirs = await envelope();
    await pool.query(
      `INSERT INTO "OrderEnvelope" ("id", "clientRequestId", "marketId", "epochId", "commitment",
        "encryptionKeyId", "envelopeAlgorithm", "ephemeralPublicKey", "envelopeSalt", "envelopeNonce",
        "ciphertext", "traderTagHash", "clientSignature", "state", "updatedAt")
       VALUES (gen_random_uuid(), gen_random_uuid(), 'market-full', 'epoch-full', $1,
        'k', 'a', 'e', 's', 'n', '\x01', $2, '\x01', 'PENDING_CHAIN', NOW())`,
      [theirs.commitment, '99'.repeat(32)],
    );

    const listed = await repository.listForTrader({ traderTagHash: '22'.repeat(32), limit: 50 });
    expect(listed.some(order => order.orderId === mine.record.id)).toBe(true);
    expect(listed.every(order => order.commitment !== theirs.commitment)).toBe(true);
    expect(listed.every(order => !Object.keys(order).includes('ciphertext'))).toBe(true);

    const foreign = await repository.listForTrader({ traderTagHash: '99'.repeat(32), limit: 50 });
    expect(foreign.some(order => order.commitment === theirs.commitment)).toBe(true);
    expect(foreign.some(order => order.orderId === mine.record.id)).toBe(false);
  });
});
