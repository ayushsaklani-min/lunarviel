import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { sealOrderEnvelopeV1 } from '@lunarveil/crypto';
import { walletIdentityHashV1 } from '@lunarveil/matcher';
import { startLunarveilApiV1, type LunarveilRuntimeConfigV1, type StartedLunarveilApiV1 } from '@lunarveil/api';

import { composeLunarveilApiV1, type ComposedLunarveilApiV1 } from './composition.js';
import {
  developmentEnvelopeSignatureV1,
  developmentTraderTagHashV1,
  developmentWalletSignatureV1,
} from './developmentAdapters.js';

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
const fixtureSchema = `lunarveil_e2e_${randomUUID().replaceAll('-', '')}`;
// Prisma is a workspace-local dependency of @lunarveil/db, so it must be
// resolved from that package rather than from this one or the repository root.
const dbRequire = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
const prismaCli = join(dirname(dbRequire.resolve('prisma/package.json')), 'build/index.js');
const schemaPath = fileURLToPath(new URL('../../../packages/db/prisma/schema.prisma', import.meta.url));

const MARKET_ID = 'market-e2e';
const EPOCH_ID = 'epoch-e2e';

function config(overrides: Partial<LunarveilRuntimeConfigV1> = {}): LunarveilRuntimeConfigV1 {
  return {
    environment: 'development',
    host: '127.0.0.1',
    port: 0,
    bodyLimitBytes: 64 * 1024,
    allowedOrigins: [],
    trustProxy: false,
    ...overrides,
  };
}

/** The API accepts unpadded base64url, not standard base64. */
function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
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
let composed: ComposedLunarveilApiV1;
let started: StartedLunarveilApiV1;

(url ? describe : describe.skip)('end-to-end encrypted order admission', () => {
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

    inspector = new Pool({
      connectionString: url.toString(), max: 2,
      options: `-c search_path=${fixtureSchema},public -c timezone=UTC`,
    });

    await inspector.query(`INSERT INTO "Market" (
      "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress", "tickSizeAtomic",
      "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch", "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
    ) VALUES ($1, 'NIGHT-USDCX', 'NIGHT', 'USDCX', 'addr-e2e', '1', '1', 60, 4, 2, 'v1', NOW())`, [MARKET_ID]);
    await inspector.query(`INSERT INTO "Epoch" (
      "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt", "onchainStartIndex",
      "configHash", "ruleVersion", "updatedAt"
    ) VALUES ($1, $2, '1', 'OPEN', NOW(), NOW() + INTERVAL '1 hour', '0', $3, 'v1', NOW())`,
    [EPOCH_ID, MARKET_ID, 'ab'.repeat(32)]);

    composed = await composeLunarveilApiV1({
      config: config(), databaseUrl: target.toString(), logLine: () => undefined,
      // This suite exercises the development adapters deliberately; the real
      // ledger verifier is the default and is covered end to end by
      // `@lunarveil/api`'s walletSessionContract integration test.
      developmentWalletSignatures: true,
    });
    started = await startLunarveilApiV1(composed.dependencies, config());
  }, 180_000);

  afterAll(async () => {
    await started?.app.close();
    await composed?.close();
    await inspector?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`);
      await admin.end();
    }
  });

  it('serves the public catalog the composition root reads from the real database', async () => {
    const markets = await fetch(`${started.address}/v1/markets`);
    expect(markets.status).toBe(200);
    expect(await markets.json()).toEqual({
      markets: [expect.objectContaining({ id: MARKET_ID, marketKey: 'NIGHT-USDCX', status: 'ACTIVE' })],
    });

    const epoch = await fetch(`${started.address}/v1/markets/${MARKET_ID}/epoch`);
    expect(epoch.status).toBe(200);
    expect(await epoch.json()).toMatchObject({ id: EPOCH_ID, state: 'OPEN', sequence: '1' });
  });

  it('accepts an encrypted order over HTTP and stores only ciphertext', async () => {
    const walletIdentity = `wallet-${randomUUID()}`;
    const domain = 'https://app.lunarveil.test';

    const challengeResponse = await fetch(`${started.address}/v1/sessions/challenges`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, walletIdentity }),
    });
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { id: string; nonce: string };

    const signature = developmentWalletSignatureV1({
      domain, challengeId: challenge.id, nonce: challenge.nonce, walletIdentity,
      secret: composed.developmentSecret,
    });
    const sessionResponse = await fetch(`${started.address}/v1/sessions/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: challenge.id, signature: base64Url(signature) }),
    });
    expect(sessionResponse.status).toBe(200);
    const token = (await sessionResponse.json() as { token: string }).token;

    const walletIdentityHash = walletIdentityHashV1(walletIdentity);
    const traderTagHash = developmentTraderTagHashV1(walletIdentityHash, composed.developmentSecret);
    const clientRequestId = randomUUID();
    const commitment = createHash('sha256').update(clientRequestId).digest('hex');

    const matcherKeyResponse = await fetch(`${started.address}/v1/matcher-key`);
    expect(matcherKeyResponse.status).toBe(200);
    const publicKey = await matcherKeyResponse.json() as {
      version: 1; keyId: string; algorithm: 'X25519-HKDF-SHA256-AES-256-GCM';
      publicKey: string; activeFromMs: string; expiresAtMs: string;
    };

    const secretOrder = new TextEncoder().encode('{"side":"BUY","priceTicks":"1234","quantityLots":"7"}');
    const envelope = await sealOrderEnvelopeV1({
      header: { clientRequestId, marketId: MARKET_ID, epochId: EPOCH_ID, commitment, traderTagHash },
      matcherKey: {
        version: publicKey.version, keyId: publicKey.keyId, algorithm: publicKey.algorithm,
        publicKey: publicKey.publicKey,
        activeFromMs: BigInt(publicKey.activeFromMs), expiresAtMs: BigInt(publicKey.expiresAtMs),
      },
      plaintext: secretOrder,
      nowMs: BigInt(Date.now()),
    });

    const clientSignature = developmentEnvelopeSignatureV1({
      walletIdentityHash, commitment, clientRequestId, secret: composed.developmentSecret,
    });

    const order = await fetch(`${started.address}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope, clientSignature: base64Url(clientSignature) }),
    });
    expect(order.status).toBe(200);
    expect(await order.json()).toMatchObject({ state: 'PENDING_CHAIN', replayed: false });

    // The row must exist and must carry no plaintext order material.
    const stored = await inspector.query<{
      ciphertext: Buffer; commitment: string; traderTagHash: string; state: string;
    }>(
      'SELECT "ciphertext", "commitment", "traderTagHash", "state" FROM "OrderEnvelope" WHERE "clientRequestId" = $1',
      [clientRequestId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ commitment, traderTagHash, state: 'PENDING_CHAIN' });

    const rowText = JSON.stringify(stored.rows[0]);
    expect(rowText).not.toContain('BUY');
    expect(rowText).not.toContain('1234');
    expect(rowText).not.toContain('quantityLots');
    expect(stored.rows[0]!.ciphertext.length).toBeGreaterThan(0);
    expect(stored.rows[0]!.ciphertext.includes(Buffer.from('BUY'))).toBe(false);

    // Replaying the exact request is idempotent rather than a second order.
    const replay = await fetch(`${started.address}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ envelope, clientSignature: base64Url(clientSignature) }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, state: 'PENDING_CHAIN' });
    const count = await inspector.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM "OrderEnvelope"');
    expect(count.rows[0]?.total).toBe('1');
  }, 60_000);

  it('refuses an unauthenticated or wrongly bound submission without persisting it', async () => {
    const before = await inspector.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM "OrderEnvelope"');

    const noToken = await fetch(`${started.address}/v1/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope: {}, clientSignature: 'AA' }),
    });
    expect(noToken.status).toBeGreaterThanOrEqual(400);

    const badToken = await fetch(`${started.address}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify({ envelope: {}, clientSignature: 'AA' }),
    });
    expect(badToken.status).toBeGreaterThanOrEqual(400);

    const after = await inspector.query<{ total: string }>('SELECT COUNT(*)::text AS total FROM "OrderEnvelope"');
    expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
  });

  it('reports readiness honestly while chain, prover and KMS have no adapter', async () => {
    const status = await fetch(`${started.address}/v1/system/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      state: 'DEGRADED',
      components: [
        { name: 'DATABASE', state: 'READY' },
        { name: 'MATCHER', state: 'READY' },
        { name: 'CHAIN_SOURCE', state: 'UNAVAILABLE' },
        { name: 'PROVER', state: 'UNAVAILABLE' },
        { name: 'KMS', state: 'UNAVAILABLE' },
      ],
    });

    // Liveness is true, readiness is false. That is the accurate report today.
    expect((await fetch(`${started.address}/healthz`)).status).toBe(200);
    const readiness = await fetch(`${started.address}/readyz`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({ status: 'not_ready', code: 'DEPENDENCY_NOT_READY' });
  });
});
