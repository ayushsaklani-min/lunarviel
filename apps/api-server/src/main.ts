import { composeLunarveilApiV1 } from './composition.js';
import { parseLunarveilRuntimeConfigV1, startLunarveilApiV1 } from '@lunarveil/api';

/**
 * Process entry point. It reads already-validated runtime configuration, opens
 * the real database pool, and starts the listener. It prints no secret and no
 * connection string; failures surface as a code.
 */
async function main(): Promise<void> {
  const config = parseLunarveilRuntimeConfigV1(process.env);
  const databaseUrl = process.env.LUNARVEIL_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('LUNARVEIL_DATABASE_URL is required');
  }

  // At least 32 bytes of hex. It must be the same key across restarts and
  // replicas: a different key orphans every trader tag already written.
  const traderTagKeyHex = process.env.LUNARVEIL_TRADER_TAG_KEY;
  if (typeof traderTagKeyHex !== 'string' || !/^(?:[0-9a-fA-F]{2}){32,}$/u.test(traderTagKeyHex)) {
    throw new Error('LUNARVEIL_TRADER_TAG_KEY must be at least 32 bytes of hex');
  }
  const traderTagKey = new Uint8Array(Buffer.from(traderTagKeyHex, 'hex'));

  // Optional, development only: a seed shared with the matcher worker so both
  // processes derive the same matcher encryption key. Without it each process
  // generates its own and nothing sealed here can ever be matched.
  const matcherKeySeedHex = process.env.LUNARVEIL_DEV_MATCHER_KEY_SEED;
  if (matcherKeySeedHex !== undefined && !/^(?:[0-9a-fA-F]{2}){32}$/u.test(matcherKeySeedHex)) {
    throw new Error('LUNARVEIL_DEV_MATCHER_KEY_SEED must be exactly 32 bytes of hex');
  }

  const composed = await composeLunarveilApiV1({
    config,
    databaseUrl,
    traderTagKey,
    ...(matcherKeySeedHex === undefined ? {} : { matcherKeySeedHex }),
  });
  let started: Awaited<ReturnType<typeof startLunarveilApiV1>> | undefined;
  try {
    started = await startLunarveilApiV1(composed.dependencies, config);
  } catch (error) {
    await composed.close();
    throw error;
  }

  const shutdown = async (): Promise<void> => {
    try {
      await started?.app.close();
    } finally {
      await composed.close();
    }
  };
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });

  // The address is public deployment metadata, never a credential.
  process.stdout.write(`${JSON.stringify({ event: 'server.started', address: started.address })}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'STARTUP_FAILED';
  process.stderr.write(`${JSON.stringify({ event: 'server.startup_failed', code })}\n`);
  process.exit(1);
});
