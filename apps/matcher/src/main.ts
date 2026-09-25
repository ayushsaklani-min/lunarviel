import { SHARED_DEVELOPMENT_MATCHER_KEY_ID, SharedDevelopmentMatcherKeyStoreV1, type MatcherKeyResolverV1 } from '@lunarveil/matcher';

import { parseMatcherWorkerConfigV1 } from './config.js';
import { composeMatcherWorkerV1 } from './composition.js';

async function main(): Promise<void> {
  const config = parseMatcherWorkerConfigV1(process.env);
  const databaseUrl = process.env.LUNARVEIL_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('LUNARVEIL_DATABASE_URL is required');
  }

  let simulatedChainKeys: MatcherKeyResolverV1 | undefined;
  if (config.simulatedChain !== undefined) {
    // Same seed and key id as the API server, so envelopes it sealed decrypt here.
    const nowMs = BigInt(Date.now());
    const store = await SharedDevelopmentMatcherKeyStoreV1.create({
      environment: process.env.LUNARVEIL_ENV ?? '',
      seedHex: config.simulatedChain.matcherKeySeedHex,
      keyId: SHARED_DEVELOPMENT_MATCHER_KEY_ID,
      activeFromMs: 0n,
      expiresAtMs: nowMs + 365n * 86_400_000n,
    });
    simulatedChainKeys = {
      resolveExistingEnvelopeKey: async keyId => ({
        ...store.activePublicKey(BigInt(Date.now())),
        privateKey: await store.resolvePrivateKey({ keyId, privateKeyRef: store.privateKeyRef }),
      }),
    };
    process.stdout.write(`${JSON.stringify({ event: 'matcher.simulated_chain_enabled', maliciousMatcher: config.simulatedChain.maliciousMatcher })}\n`);
  }

  const worker = composeMatcherWorkerV1({ config, databaseUrl, ...(simulatedChainKeys === undefined ? {} : { simulatedChainKeys }) });

  let stopping = false;
  const stop = async (): Promise<void> => { stopping = true; await worker.close(); };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });

  while (!stopping) {
    // runPass catches and logs every failure itself; this catch is only a
    // backstop against a future defect that bypasses that handling.
    try { await worker.runPass(); } catch { /* runPass logs before ever rejecting */ }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, config.intervalMs));
  }
}

main().catch(() => {
  // A pool-construction failure can carry credentials in its message, so only
  // a fixed sanitized code reaches stderr.
  process.stderr.write(`${JSON.stringify({ event: 'matcher.startup_failed', code: 'STARTUP_FAILED' })}\n`);
  process.exit(1);
});
