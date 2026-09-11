import { PostgresMarketContractRegistryV1 } from '@lunarveil/db';

import { parseReconcilerConfigV1 } from './config.js';
import { composeReconcilerV1 } from './composition.js';
import {
  createContractActionChainLedgerReaderV1,
  createIndexerChainLedgerReaderV1,
} from './indexerReader.js';
import { loadLedgerDecoderV1 } from './ledgerDecoderLoader.js';

async function main(): Promise<void> {
  const config = parseReconcilerConfigV1(process.env);
  const databaseUrl = process.env.LUNARVEIL_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('LUNARVEIL_DATABASE_URL is required');
  }

  // No decoder configured keeps the fail-closed reader: the reconciler still
  // runs, still re-checks, and simply never confirms an admission. A
  // configured decoder that fails to load stops startup instead.
  const membership = await loadLedgerDecoderV1(process.env.LUNARVEIL_LEDGER_DECODER_MODULE);

  const reconciler = composeReconcilerV1({
    config,
    databaseUrl,
    reader: membership === undefined
      ? createIndexerChainLedgerReaderV1(config)
      : ({ pool }) => createContractActionChainLedgerReaderV1({
        config,
        registry: new PostgresMarketContractRegistryV1(pool),
        membership,
      }),
  });

  let stopping = false;
  const stop = async (): Promise<void> => { stopping = true; await reconciler.close(); };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });

  while (!stopping) {
    // A failed pass must not kill the loop; the next pass retries.
    // runPass() catches and logs every failure itself and resolves rather
    // than rejecting, so this catch is only a defensive backstop against a
    // future defect that bypasses that handling.
    try { await reconciler.runPass(); } catch { /* runPass logs before ever rejecting */ }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, config.intervalMs));
  }
}

main().catch(() => {
  // Never echo the raw error (e.g. a pool-construction failure can carry a
  // connection string or credentials in its message). A fixed, sanitized
  // code is all that reaches stderr.
  process.stderr.write(`${JSON.stringify({ event: 'reconciler.startup_failed', code: 'STARTUP_FAILED' })}\n`);
  process.exit(1);
});
