import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
} from '@lunarveil/crypto';

import {
  OrderEnvelopeRepositoryError,
  PostgresOrderEnvelopeRepository,
  nodePostgresSerializablePool,
} from './orderEnvelopeRepository.js';
import { PostgresChainAdmissionReconciliationRepository } from './chainAdmissionReconciliationRepository.js';

const integrationUrl = process.env.LUNARVEIL_POSTGRES_INTEGRATION_URL;
function configuredDatabaseName(): string | undefined {
  if (integrationUrl === undefined) return undefined;
  try {
    const url = new URL(integrationUrl);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (['postgres:', 'postgresql:'].includes(url.protocol)
      && /^lunarveil_test_[a-z0-9_]+$/i.test(name)) return name;
  } catch { /* Never print a connection string or parser exception. */ }
  throw new Error('Integration URL must target a disposable lunarveil_test_* PostgreSQL database');
}
const expectedDatabaseName = configuredDatabaseName();
const isolatedDatabase = expectedDatabaseName !== undefined
  && /^lunarveil_test_[a-z0-9_]+$/i.test(expectedDatabaseName);
const describeIntegration = isolatedDatabase ? describe : describe.skip;
const nowMs = 1_800_000_000_000n;
const envelopeMigrationPath = fileURLToPath(new URL(
  '../prisma/migrations/202609040001_order_envelope_transport_v1/migration.sql',
  import.meta.url,
));
const reconciliationMigrationPath = fileURLToPath(new URL(
  '../prisma/migrations/202609040002_chain_admission_reconciliation_v1/migration.sql',
  import.meta.url,
));

let pool: Pool | undefined;
let repository: PostgresOrderEnvelopeRepository | undefined;
let reconciliationRepository: PostgresChainAdmissionReconciliationRepository | undefined;
let createdOrderTable = false;
let createdReconciliationTable = false;
let createdReconciliationType = false;

async function testEnvelope(overrides: Partial<{ clientRequestId: string; commitment: string }> = {}) {
  const matcher = await generateMatcherDecryptionKeyV1({
    keyId: 'matcher-integration-2026-09',
    activeFromMs: nowMs - 1n,
    expiresAtMs: nowMs + 60_000n,
  });
  return sealOrderEnvelopeV1({
    header: {
      clientRequestId: overrides.clientRequestId ?? randomUUID(),
      marketId: 'NIGHT-USDCX',
      epochId: 'epoch-integration-7',
      commitment: overrides.commitment ?? '11'.repeat(32),
      traderTagHash: '22'.repeat(32),
    },
    matcherKey: matcherPublicKeyV1(matcher),
    plaintext: new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}'),
    nowMs,
  });
}

describeIntegration('PostgresOrderEnvelopeRepository integration', () => {
  beforeAll(async () => {
    // The URL guard prevents this test from ever cleaning up a non-disposable DB.
    if (integrationUrl === undefined || expectedDatabaseName === undefined) {
      throw new Error('LUNARVEIL_POSTGRES_INTEGRATION_URL must be configured');
    }
    pool = new Pool({ connectionString: integrationUrl, max: 1 });
    const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (database.rows[0]?.name !== expectedDatabaseName || !isolatedDatabase) {
      throw new Error('integration database must be named lunarveil_test_*');
    }
    await pool.query(`
      CREATE TABLE "OrderEnvelope" (
        "id" text PRIMARY KEY,
        "clientRequestId" uuid NOT NULL UNIQUE,
        "marketId" text NOT NULL,
        "epochId" text NOT NULL,
        "commitment" text NOT NULL UNIQUE,
        "encryptionKeyId" text NOT NULL,
        "ciphertext" bytea NOT NULL,
        "traderTagHash" text NOT NULL,
        "clientSignature" bytea NOT NULL,
        "chainAdmissionTxId" text,
        "leafIndex" text,
        "state" text NOT NULL,
        "acceptedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL
      )
    `);
    createdOrderTable = true;
    await pool.query('BEGIN');
    try {
      await pool.query(readFileSync(envelopeMigrationPath, 'utf8'));
      await pool.query(readFileSync(reconciliationMigrationPath, 'utf8'));
      await pool.query('COMMIT');
    } catch {
      await pool.query('ROLLBACK');
      throw new Error('Integration fixture migration failed');
    }
    createdReconciliationType = true;
    createdReconciliationTable = true;
    repository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool));
    reconciliationRepository = new PostgresChainAdmissionReconciliationRepository(nodePostgresSerializablePool(pool));
  }, 10_000);

  afterAll(async () => {
    if (pool === undefined) return;
    try {
      if (createdOrderTable && isolatedDatabase) {
        const database = await pool.query<{ name: string }>('SELECT current_database() AS name');
        if (database.rows[0]?.name === expectedDatabaseName) {
          if (createdReconciliationTable) await pool.query('DROP TABLE "OrderAdmissionReconciliation"');
          if (createdReconciliationType) await pool.query('DROP TYPE "OrderAdmissionReconciliationState"');
          await pool.query('DROP TABLE "OrderEnvelope"');
        }
      }
    } finally {
      await pool.end();
    }
  });

  it('persists only the encrypted transport and handles replay and duplicate commitment', async () => {
    if (repository === undefined || pool === undefined) throw new Error('repository not initialized');
    const firstEnvelope = await testEnvelope();
    const first = await repository.submit({
      envelope: firstEnvelope,
      clientSignature: new Uint8Array([7, 8]),
    });
    const replay = await repository.submit({
      envelope: firstEnvelope,
      clientSignature: new Uint8Array([9]),
    });

    expect(first.replayed).toBe(false);
    expect(first.record.state).toBe('PENDING_CHAIN');
    expect(replay.replayed).toBe(true);

    const stored = await pool.query<{ ciphertext: Buffer; state: string }>(
      'SELECT "ciphertext", "state" FROM "OrderEnvelope" WHERE "clientRequestId" = $1',
      [firstEnvelope.clientRequestId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.state).toBe('PENDING_CHAIN');
    expect(stored.rows[0]?.ciphertext.toString('utf8')).not.toContain('quantityLots');

    const duplicate = await testEnvelope({ commitment: firstEnvelope.commitment });
    await expect(repository.submit({
      envelope: duplicate,
      clientSignature: new Uint8Array([10]),
    })).rejects.toMatchObject({
      name: OrderEnvelopeRepositoryError.name,
      code: 'DUPLICATE_COMMITMENT',
    });
  });

  it('persists a matching public reconciliation and atomically accepts its pending envelope', async () => {
    if (repository === undefined || reconciliationRepository === undefined || pool === undefined) {
      throw new Error('repositories not initialized');
    }
    const submittedEnvelope = await testEnvelope({ commitment: '33'.repeat(32) });
    const submitted = await repository.submit({
      envelope: submittedEnvelope,
      clientSignature: new Uint8Array([7]),
    });

    const result = await reconciliationRepository.apply(submitted.record.id, {
      action: 'ACCEPT',
      code: 'ADMISSION_CONFIRMED',
      sourceIds: ['node-a', 'indexer-b'],
      admission: {
        marketId: submittedEnvelope.marketId,
        epochId: submittedEnvelope.epochId,
        commitment: submittedEnvelope.commitment,
        txId: 'tx-admit-integration-7',
        leafIndex: '4',
      },
    });
    expect(result).toEqual({ state: 'ACCEPTED', replayed: false });

    const stored = await pool.query<{ state: string; chainAdmissionTxId: string; leafIndex: string }>(
      'SELECT "state", "chainAdmissionTxId", "leafIndex" FROM "OrderEnvelope" WHERE "id" = $1',
      [submitted.record.id],
    );
    expect(stored.rows).toEqual([{
      state: 'ACCEPTED', chainAdmissionTxId: 'tx-admit-integration-7', leafIndex: '4',
    }]);
  });

  it('rejects changed request reuse without modifying the stored encrypted transport', async () => {
    if (!repository || !pool) throw new Error('repository not initialized');
    const envelope = await testEnvelope({ commitment: '44'.repeat(32) });
    await repository.submit({ envelope, clientSignature: new Uint8Array([7]) });
    const changed = await testEnvelope({
      clientRequestId: envelope.clientRequestId, commitment: envelope.commitment,
    });
    await expect(repository.submit({ envelope: changed, clientSignature: new Uint8Array([7]) }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const replay = await repository.submit({ envelope, clientSignature: new Uint8Array([7]) });
    expect(replay.replayed).toBe(true);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*) FROM "OrderEnvelope" WHERE "clientRequestId" = $1', [envelope.clientRequestId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('rejects an internal ID collision without classifying it as a duplicate commitment', async () => {
    if (!repository || !pool) throw new Error('repository not initialized');
    const envelope = await testEnvelope({ commitment: '88'.repeat(32) });
    const { record } = await repository.submit({ envelope, clientSignature: new Uint8Array([7]) });
    const collidingRepository = new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(pool), {
      newId: () => record.id,
    });
    const other = await testEnvelope({ commitment: '99'.repeat(32) });
    await expect(collidingRepository.submit({ envelope: other, clientSignature: new Uint8Array([7]) }))
      .rejects.toMatchObject({ code: 'DATABASE_CONFLICT' });
    const stored = await pool.query('SELECT "commitment" FROM "OrderEnvelope" WHERE "id" = $1', [record.id]);
    expect(stored.rows).toEqual([{ commitment: envelope.commitment }]);
  });

  it('records disagreement once, then accepts matching evidence once despite retries', async () => {
    if (!repository || !reconciliationRepository || !pool) throw new Error('repositories not initialized');
    const envelope = await testEnvelope({ commitment: '55'.repeat(32) });
    const { record } = await repository.submit({ envelope, clientSignature: new Uint8Array([7]) });
    const pause = {
      action: 'PAUSE', code: 'INDEXER_DISAGREEMENT', sourceIds: ['node-a', 'indexer-b'],
    } as const;
    expect(await reconciliationRepository.apply(record.id, pause))
      .toEqual({ state: 'PENDING_CHAIN', replayed: false });
    expect(await reconciliationRepository.apply(record.id, { ...pause, sourceIds: [...pause.sourceIds].reverse() }))
      .toEqual({ state: 'PENDING_CHAIN', replayed: true });
    const pending = await pool.query(
      'SELECT "state", "chainAdmissionTxId", "acceptedAt" FROM "OrderEnvelope" WHERE "id" = $1', [record.id],
    );
    expect(pending.rows).toEqual([{ state: 'PENDING_CHAIN', chainAdmissionTxId: null, acceptedAt: null }]);

    const accept = {
      action: 'ACCEPT', code: 'ADMISSION_CONFIRMED', sourceIds: pause.sourceIds,
      admission: { marketId: envelope.marketId, epochId: envelope.epochId,
        commitment: envelope.commitment, txId: 'tx-reconciled', leafIndex: '5' },
    } as const;
    expect(await reconciliationRepository.apply(record.id, accept))
      .toEqual({ state: 'ACCEPTED', replayed: false });
    expect(await reconciliationRepository.apply(record.id, accept))
      .toEqual({ state: 'ACCEPTED', replayed: true });
    await expect(reconciliationRepository.apply(record.id, pause)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(reconciliationRepository.apply(record.id, {
      ...accept, admission: { ...accept.admission, txId: 'tx-conflicting' },
    })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const evidence = await pool.query(
      'SELECT "state" FROM "OrderAdmissionReconciliation" WHERE "orderId" = $1 ORDER BY "state"', [record.id],
    );
    expect(evidence.rows).toEqual([{ state: 'PAUSED' }, { state: 'CONFIRMED' }]);
  });

  it('rejects evidence for another epoch without inserting evidence or accepting the order', async () => {
    if (!repository || !reconciliationRepository || !pool) throw new Error('repositories not initialized');
    const envelope = await testEnvelope({ commitment: '66'.repeat(32) });
    const { record } = await repository.submit({ envelope, clientSignature: new Uint8Array([7]) });
    await expect(reconciliationRepository.apply(record.id, {
      action: 'ACCEPT', code: 'ADMISSION_CONFIRMED', sourceIds: ['node-a', 'indexer-b'],
      admission: { marketId: envelope.marketId, epochId: 'wrong-epoch',
        commitment: envelope.commitment, txId: 'tx-wrong-epoch', leafIndex: '6' },
    })).rejects.toMatchObject({ code: 'DECISION_CONFLICT' });
    const order = await pool.query('SELECT "state" FROM "OrderEnvelope" WHERE "id" = $1', [record.id]);
    expect(order.rows).toEqual([{ state: 'PENDING_CHAIN' }]);
    const evidence = await pool.query('SELECT "id" FROM "OrderAdmissionReconciliation" WHERE "orderId" = $1', [record.id]);
    expect(evidence.rows).toEqual([]);
  });

  it('rolls back inserted evidence when the acceptance update fails', async () => {
    if (!repository || !reconciliationRepository || !pool) throw new Error('repositories not initialized');
    const envelope = await testEnvelope({ commitment: '77'.repeat(32) });
    const { record } = await repository.submit({ envelope, clientSignature: new Uint8Array([7]) });
    // A real database constraint fails after the repository inserts evidence.
    await pool.query(`ALTER TABLE "OrderEnvelope" ADD CONSTRAINT "fixture_reject_accept"
      CHECK ("commitment" <> '${'77'.repeat(32)}' OR "state" <> 'ACCEPTED')`);
    try {
      await expect(reconciliationRepository.apply(record.id, {
        action: 'ACCEPT', code: 'ADMISSION_CONFIRMED', sourceIds: ['node-a', 'indexer-b'],
        admission: { marketId: envelope.marketId, epochId: envelope.epochId,
          commitment: envelope.commitment, txId: 'tx-rollback', leafIndex: '7' },
      })).rejects.toMatchObject({ code: 'DATABASE_FAILURE' });
      const order = await pool.query(
        'SELECT "state", "chainAdmissionTxId", "acceptedAt" FROM "OrderEnvelope" WHERE "id" = $1', [record.id],
      );
      expect(order.rows).toEqual([{ state: 'PENDING_CHAIN', chainAdmissionTxId: null, acceptedAt: null }]);
      const evidence = await pool.query('SELECT "id" FROM "OrderAdmissionReconciliation" WHERE "orderId" = $1', [record.id]);
      expect(evidence.rows).toEqual([]);
    } finally {
      await pool.query('ALTER TABLE "OrderEnvelope" DROP CONSTRAINT "fixture_reject_accept"');
    }
  });
});
