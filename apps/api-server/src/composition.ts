import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';

import {
  type LunarveilApiDependencies,
  type LunarveilRuntimeConfigV1,
  type SanitizedDependencyState,
  type SanitizedSystemStatusV1,
  createRedactedLoggerV1,
  jsonLineSinkV1,
} from '@lunarveil/api';
import {
  AuthenticatedOrderSubmissionServiceV1,
  SharedDevelopmentMatcherKeyStoreV1,
  TraderOrderHistoryServiceV1,
  InMemorySessionChallengeService,
} from '@lunarveil/matcher';
import {
  PostgresOrderEnvelopeRepository,
  PostgresTraderOrderHistoryRepositoryV1,
  PostgresPublicMarketCatalogRepository,
  PostgresRateLimitWindowRepository,
  nodePostgresSerializablePool,
} from '@lunarveil/db';

import {
  HmacTraderSessionBindingVerifierV1,
  LedgerOrderEnvelopeSignatureVerifierV1,
  LedgerWalletSignatureVerifierV1,
  loadLedgerSignatureApiV1,
} from '@lunarveil/wallet-auth';

import {
  DevelopmentEnvelopeSignatureVerifierV1,
  DevelopmentMatcherKeyStoreV1,
  DevelopmentTraderBindingVerifierV1,
  DevelopmentWalletSignatureVerifierV1,
} from './developmentAdapters.js';

/**
 * Either development key store. Both publish public metadata and resolve a
 * private key for an existing envelope; only their key *derivation* differs,
 * and neither is a production key-management path.
 */
export type ComposedMatcherKeyStoreV1 = DevelopmentMatcherKeyStoreV1 | SharedDevelopmentMatcherKeyStoreV1;

const MATCHER_KEY_ID = 'matcher-shared-dev';
const MATCHER_KEY_LIFETIME_MS = 86_400_000n;

export interface ComposedLunarveilApiV1 {
  readonly dependencies: LunarveilApiDependencies;
  readonly pool: Pool;
  readonly matcherKeys: ComposedMatcherKeyStoreV1;
  /** Development session secret; a real Connector signature replaces this. */
  readonly developmentSecret: Uint8Array;
  close(): Promise<void>;
}

const CHALLENGE_LIFETIME_MS = 120_000n;
const SESSION_LIFETIME_MS = 900_000n;
const RATE_LIMIT_PER_MINUTE = 120;

/**
 * Probes each dependency for real rather than asserting health.
 *
 * CHAIN_SOURCE, PROVER and KMS have no adapter yet, so they are reported
 * UNAVAILABLE. Readiness therefore stays false, which is correct: the service
 * can accept and store an encrypted order, but it cannot yet reconcile chain
 * admission, prove, or hold keys safely. Do not report these READY to make a
 * probe pass.
 */
async function probeStatus(pool: Pool, matcherReady: () => boolean): Promise<SanitizedSystemStatusV1> {
  let database: SanitizedDependencyState = 'UNAVAILABLE';
  try {
    await pool.query('SELECT 1');
    database = 'READY';
  } catch {
    database = 'UNAVAILABLE';
  }
  const components = [
    { name: 'DATABASE' as const, state: database },
    { name: 'MATCHER' as const, state: matcherReady() ? ('READY' as const) : ('UNAVAILABLE' as const) },
    { name: 'CHAIN_SOURCE' as const, state: 'UNAVAILABLE' as const },
    { name: 'PROVER' as const, state: 'UNAVAILABLE' as const },
    { name: 'KMS' as const, state: 'UNAVAILABLE' as const },
  ];
  const state: SanitizedDependencyState = components.every(component => component.state === 'READY')
    ? 'READY'
    : 'DEGRADED';
  return { state, components };
}

/**
 * Wires the real database and development-grade key/signature adapters into the
 * injected API boundary. This is the first composition root: before it, every
 * port had test doubles only.
 */
export async function composeLunarveilApiV1(input: {
  readonly config: LunarveilRuntimeConfigV1;
  readonly databaseUrl: string;
  readonly nowMs?: () => bigint;
  readonly logLine?: (line: string) => void;
  readonly poolMax?: number;
  /**
   * Opt in to the development signature verifier instead of the real ledger
   * one. It exists for local work without a Midnight wallet installed; the
   * verifier itself still refuses to run outside a development environment.
   */
  readonly developmentWalletSignatures?: boolean;
  /**
   * HMAC key for trader tags, at least 32 bytes. Required unless
   * `developmentWalletSignatures` is set: without it no trader tag can be
   * issued and no order can be bound to a session.
   */
  readonly traderTagKey?: Uint8Array;
  /**
   * 32 bytes of hex shared with the matcher worker, so both processes derive
   * the same matcher encryption key. Development only; production resolves a
   * `privateKeyRef` through a KMS instead.
   */
  readonly matcherKeySeedHex?: string;
}): Promise<ComposedLunarveilApiV1> {
  const nowMs = input.nowMs ?? (() => BigInt(Date.now()));
  const pool = new Pool({ connectionString: input.databaseUrl, max: input.poolMax ?? 8 });
  try {
    const serializable = nodePostgresSerializablePool(pool);
    const developmentSecret = new Uint8Array(randomBytes(32));
    // A per-process key cannot be matched against: the matcher runs in its own
    // process and would generate a different one, so no order sealed here
    // could ever be decrypted there. A seed shared by both processes is the
    // minimum that makes the pipeline runnable at all, and it is refused
    // outside development. See ADR-0043.
    const matcherKeys = input.matcherKeySeedHex === undefined
      ? await DevelopmentMatcherKeyStoreV1.create({
        environment: input.config.environment,
        nowMs: nowMs(),
      })
      : await SharedDevelopmentMatcherKeyStoreV1.create({
        environment: input.config.environment,
        seedHex: input.matcherKeySeedHex,
        keyId: MATCHER_KEY_ID,
        activeFromMs: nowMs(),
        expiresAtMs: nowMs() + MATCHER_KEY_LIFETIME_MS,
      });

    // The real Connector path: a wallet signature verified against the ledger,
    // with the identity bound to the verifying key (ADR-0038). The
    // development verifier remains only as an explicit opt-in for local work
    // without a wallet, and is refused outside a development environment by
    // its own constructor.
    const developmentAuth = input.developmentWalletSignatures === true;
    const ledger = developmentAuth ? undefined : await loadLedgerSignatureApiV1();

    const walletVerifier = ledger === undefined
      ? new DevelopmentWalletSignatureVerifierV1(developmentSecret, input.config.environment)
      : new LedgerWalletSignatureVerifierV1(ledger);

    // The trader tag is an HMAC the service alone can compute, so an outside
    // observer who knows a wallet address still cannot link its orders. The
    // key must outlive the process: a restart under a different key orphans
    // every tag already written. See ADR-0039.
    const traderTags = input.traderTagKey === undefined
      ? undefined
      : new HmacTraderSessionBindingVerifierV1(input.traderTagKey);
    if (!developmentAuth && traderTags === undefined) throw new Error('TRADER_TAG_KEY_REQUIRED');

    const sessions = new InMemorySessionChallengeService({
      nowMs,
      challengeLifetimeMs: CHALLENGE_LIFETIME_MS,
      sessionLifetimeMs: SESSION_LIFETIME_MS,
      verifier: walletVerifier,
    });

    const orders = new AuthenticatedOrderSubmissionServiceV1(
      sessions,
      traderTags ?? new DevelopmentTraderBindingVerifierV1(developmentSecret, input.config.environment),
      ledger === undefined
        ? new DevelopmentEnvelopeSignatureVerifierV1(developmentSecret, input.config.environment)
        : new LedgerOrderEnvelopeSignatureVerifierV1(ledger),
      new PostgresOrderEnvelopeRepository(serializable),
    );

    const logger = createRedactedLoggerV1({
      sink: jsonLineSinkV1(input.logLine ?? (line => process.stdout.write(`${line}\n`))),
      nowMs,
    });

    const dependencies: LunarveilApiDependencies = {
      nowMs,
      sessions,
      orders,
      matcherKeys,
      ...(traderTags === undefined ? {} : {
        traderTags,
        // Only offered when a tag issuer exists: without one there is no way
        // to scope a history query to the caller.
        orderHistory: new TraderOrderHistoryServiceV1(
          sessions,
          traderTags,
          new PostgresTraderOrderHistoryRepositoryV1(serializable),
        ),
      }),
      markets: new PostgresPublicMarketCatalogRepository(serializable),
      systemStatus: { read: () => probeStatus(pool, () => matcherKeyUsable(matcherKeys, nowMs())) },
      rateLimiter: new PostgresRateLimitWindowRepository(serializable, RATE_LIMIT_PER_MINUTE),
      logger,
      ...(input.config.allowedOrigins.length > 0 ? { allowedOrigins: input.config.allowedOrigins } : {}),
    };

    return {
      dependencies,
      pool,
      matcherKeys,
      developmentSecret,
      async close() {
        developmentSecret.fill(0);
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function matcherKeyUsable(store: ComposedMatcherKeyStoreV1, nowMs: bigint): boolean {
  try {
    store.activePublicKey(nowMs);
    return true;
  } catch {
    return false;
  }
}
