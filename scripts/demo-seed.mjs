// Seeds the prototype demo market. Idempotent: re-running keeps existing data
// and only opens an epoch when the market has none open.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (typeof connectionString !== 'string' || connectionString === '') throw new Error('DATABASE_URL is required');
const epochSeconds = Number(process.env.DEMO_EPOCH_SECONDS ?? '60');
if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 15 || epochSeconds > 86_400) {
  throw new Error('DEMO_EPOCH_SECONDS must be an integer between 15 and 86400');
}

const MARKET_ID = 'demo-night-usdcx';
// Any whole-byte hex passes the registry; this is not a deployed contract.
const CONTRACT = '00'.repeat(31) + 'de';
// Frozen demo configuration. Tick = lot = 1 so typed units equal ticks/lots.
const CONFIG_HASH = 'd3'.repeat(32);

const pool = new Pool({ connectionString });
try {
  await pool.query(`
    INSERT INTO "Market" (
      "id", "marketKey", "baseAssetId", "quoteAssetId", "marketContractAddress",
      "tickSizeAtomic", "lotSizeAtomic", "epochDurationSeconds", "maxOrdersPerEpoch",
      "minBatchPrivacy", "matchingRuleVersion", "updatedAt"
    ) VALUES ($1, 'NIGHT-USDCX', 'night', 'usdcx', $2, '1', '1', $3, 8, 2, 'rules-v1', NOW())
    ON CONFLICT ("id") DO NOTHING
  `, [MARKET_ID, CONTRACT, epochSeconds]);

  const open = await pool.query(`SELECT 1 FROM "Epoch" WHERE "marketId" = $1 AND "state" = 'OPEN'`, [MARKET_ID]);
  if (open.rowCount === 0) {
    const last = await pool.query(`SELECT COALESCE(MAX("sequence"), 0)::text AS seq FROM "Epoch" WHERE "marketId" = $1`, [MARKET_ID]);
    await pool.query(`
      INSERT INTO "Epoch" (
        "id", "marketId", "sequence", "state", "startedAt", "scheduledCloseAt",
        "onchainStartIndex", "configHash", "ruleVersion", "updatedAt"
      ) VALUES (gen_random_uuid(), $1, $2::bigint + 1, 'OPEN', NOW(), NOW() + make_interval(secs => $3),
        '0', $4, 'rules-v1', NOW())
    `, [MARKET_ID, last.rows[0].seq, epochSeconds, CONFIG_HASH]);
  }
  process.stdout.write(`Demo market ${MARKET_ID} ready (${epochSeconds}s epochs).\n`);
} finally {
  await pool.end();
}
