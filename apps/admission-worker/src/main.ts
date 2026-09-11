import { loadOrderAdmissionChainV1 } from './chainModuleLoader.js';
import { composeAdmissionWorkerV1 } from './composition.js';
import { parseAdmissionWorkerConfigV1 } from './config.js';

async function main(): Promise<void> {
  const config = parseAdmissionWorkerConfigV1(process.env);
  const databaseUrl = process.env.LUNARVEIL_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') throw new Error('DATABASE_URL_REQUIRED');
  const chain = await loadOrderAdmissionChainV1(config.chainModule);
  const worker = composeAdmissionWorkerV1({ config, databaseUrl, chain });

  let stopping = false;
  const stop = async () => { stopping = true; await worker.close(); };
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
