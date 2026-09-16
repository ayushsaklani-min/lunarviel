import { Pool } from 'pg';

/**
 * Idempotent Preview demo catalog: one NIGHT/USDCX market bound to the
 * deployed M3 N=4 Preview contract and its open on-chain epoch.
 *
 * Runs from the Render build (which already reaches the database for
 * migrations). Existing rows are never modified: a re-run inserts nothing.
 * Epoch sequence 7 and capacity 4 match the deployed contract's constructor
 * (spikes/midnight-smoke/src/m3-chain-checkpoint.ts). Public data only.
 */
const connectionString = process.env.LUNARVEIL_DATABASE_URL || process.env.DATABASE_URL;
if (typeof connectionString !== 'string' || connectionString === '') {
  process.stderr.write('seed-preview-demo: DATABASE_URL_REQUIRED\n');
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 1 });
try {
  const market = await pool.query(`
    INSERT INTO "Market" (
      "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress",
      "tickSizeAtomic", "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch",
      "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
    ) VALUES (
      'market-preview-n4', 'NIGHT-USDCX', 'night', 'usdcx',
      '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91',
      '1', '100', 3600, 4, 2, 'rules-v1', NOW()
    )
    ON CONFLICT DO NOTHING
  `);
  const epoch = await pool.query(`
    INSERT INTO "Epoch" (
      "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt",
      "onchainStartIndex", "configHash", "ruleVersion", "updatedAt"
    ) VALUES (
      'epoch-preview-n4', 'market-preview-n4', 7, 'OPEN', NOW(),
      NOW() + INTERVAL '30 days', '0', repeat('ab', 32), 'rules-v1', NOW()
    )
    ON CONFLICT DO NOTHING
  `);
  process.stdout.write(`${JSON.stringify({
    event: 'seed.preview_demo', marketsInserted: market.rowCount, epochsInserted: epoch.rowCount,
  })}\n`);
} catch {
  // Never print the driver error: it can carry the connection string.
  process.stderr.write('seed-preview-demo: SEED_FAILED\n');
  process.exitCode = 1;
} finally {
  await pool.end();
}
