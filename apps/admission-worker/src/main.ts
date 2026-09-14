import { loadOrderAdmissionChainV1 } from './chainModuleLoader.js';
import { composeAdmissionWorkerV1 } from './composition.js';
import { parseAdmissionWorkerConfigV1 } from './config.js';
import { loadOrderAdmissionPreflightV1 } from './preflightModuleLoader.js';
import { PostgresOrderEnvelopeRepository, nodePostgresSerializablePool } from '@lunarveil/db';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const config = parseAdmissionWorkerConfigV1(process.env);
  const databaseUrl = process.env.LUNARVEIL_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') throw new Error('DATABASE_URL_REQUIRED');
  const chain = await loadOrderAdmissionChainV1(config.chainModule);
  const preflightPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const preflight = await loadOrderAdmissionPreflightV1(config.preflightModule, {
    repository: new PostgresOrderEnvelopeRepository(nodePostgresSerializablePool(preflightPool)),
    nowMs: () => BigInt(Date.now()),
  });
  const worker = composeAdmissionWorkerV1({ config, databaseUrl, chain, preflight });

  let stopping = false;
  const stop = async () => { stopping = true; try { await worker.close(); } finally { await preflightPool.end(); } };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  while (!stopping) {
    await worker.runPass();
    if (!stopping) await new Promise(resolve => setTimeout(resolve, config.intervalMs));
  }
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: 'admission.startup_failed', code: 'STARTUP_FAILED' })}\n`);
  process.exit(1);
});
