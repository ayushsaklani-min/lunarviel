import { describe, expect, it, vi } from 'vitest';

const queries: string[] = [];
let pendingScanCalls = 0;
let acceptedScanCalls = 0;
let failAcceptedScanOnCall = 0;

// A stub 'pg' module: the pending-order scan throws on its first call (as the
// real PostgresPendingChainOrderSourceV1 does on DATABASE_FAILURE / INVALID_ROW,
// per chainAdmissionReconciliationWorker.ts calling listPending() outside its
// per-order try/catch) and succeeds on every call after that. The accepted
// (reorg re-check) scan can independently be made to throw on a chosen call
// via `failAcceptedScanOnCall`, to prove a failure there is isolated from the
// genuine counts `worker.runOnce()` already committed.
vi.mock('pg', () => {
  class FakeClient {
    async query(text: string, _values?: readonly unknown[]) {
      queries.push(text);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (text.includes('pg_advisory_unlock')) return { rows: [] };
      if (text.includes('PENDING_CHAIN')) {
        pendingScanCalls += 1;
        if (pendingScanCalls === 1) {
          // Real driver errors can carry a connection string; the raw message
          // must never reach the log, so this is deliberately sensitive-looking.
          throw new Error('connection to server at "db.internal:5432" failed: password authentication failed');
        }
        return { rows: [] };
      }
      if (text.includes("'ACCEPTED'") && text.includes('chainAdmissionTxId')) {
        acceptedScanCalls += 1;
        if (acceptedScanCalls === failAcceptedScanOnCall) {
          throw new Error('connection to server at "db.internal:5432" failed: password authentication failed');
        }
        return { rows: [] };
      }
      return { rows: [] };
    }
    release(): void { /* no-op */ }
  }
  class FakePool {
    async connect() { return new FakeClient(); }
    async end() { /* no-op */ }
  }
  return { Pool: FakePool };
});

const { composeReconcilerV1 } = await import('./composition.js');

import type { ChainLedgerReaderV1 } from '@lunarveil/chain';
import type { ReconcilerConfigV1 } from './config.js';

function config(): ReconcilerConfigV1 {
  return {
    network: 'preview',
    indexerUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    confirmationDepth: 12,
    requiredMatchingSources: 1,
    intervalMs: 30_000,
    batchSize: 100,
    reorgLookbackMs: 3_600_000,
  };
}

const reader: ChainLedgerReaderV1 = {
  async readAdmission() { return { present: false }; },
  async readTipHeight() { return 0n; },
};

describe('composeReconcilerV1 pool sizing invariant', () => {
  it('throws rather than deadlocking every pass when poolMax is too small to hold the advisory lock and do the work', () => {
    for (const poolMax of [0, 1, -1, 1.5, Number.NaN]) {
      expect(() => composeReconcilerV1({
        config: config(), databaseUrl: 'postgres://fake-host/fake-db', reader, poolMax,
      })).toThrow('INVALID_POOL_MAX');
    }
  });

  it('accepts a poolMax of 2 or more', () => {
    const reconciler = composeReconcilerV1({
      config: config(), databaseUrl: 'postgres://fake-host/fake-db', reader, poolMax: 2,
    });
    expect(reconciler).toBeDefined();
  });
});

describe('composeReconcilerV1 runPass catastrophic failure handling', () => {
  it('logs one sanitized failure line, mutates no order, and lets the next pass run', async () => {
    const lines: string[] = [];
    const reconciler = composeReconcilerV1({
      config: config(), databaseUrl: 'postgres://fake-host/fake-db', reader, logLine: line => lines.push(line),
    });

    try {
      const first = await reconciler.runPass();
      // The pass resolves rather than rejecting: the loop in main.ts survives.
      expect(first).toEqual({ ran: false, scanned: 0, accepted: 0, paused: 0, pending: 0, failed: 0, revoked: 0 });

      const failureLines = lines.filter(line => line.includes('chain.pass_failed'));
      expect(failureLines).toHaveLength(1);
      const parsed = JSON.parse(failureLines[0]!) as Record<string, unknown>;
      expect(parsed).toMatchObject({ level: 'error', event: 'chain.pass_failed', code: 'PASS_FAILED' });
      // Only the allowlisted fields are present; nothing else leaked through.
      expect(Object.keys(parsed).sort()).toEqual(['code', 'event', 'level', 'service', 'timestampMs']);
      // Never the raw driver error, which can carry a connection string or credentials.
      expect(failureLines[0]).not.toContain('password');
      expect(failureLines[0]).not.toContain('db.internal');
      expect(failureLines[0]).not.toContain('connection to server');

      // No mutation was attempted while the scan itself was throwing.
      expect(queries.some(sql => sql.includes('UPDATE "OrderEnvelope"'))).toBe(false);

      // The next scheduled pass is not blocked by the earlier failure.
      const second = await reconciler.runPass();
      expect(second.ran).toBe(true);
      expect(second.scanned).toBe(0);
      expect(lines.filter(line => line.includes('chain.pass_failed'))).toHaveLength(1);
    } finally {
      await reconciler.close();
    }
  });
});

describe('composeReconcilerV1 runPass reorg re-check failure isolation', () => {
  it('reports the true accepted count and its own sanitized log line when only the reorg re-check throws', async () => {
    // Keep the pending-order scan's own one-shot failure trigger (call === 1)
    // out of range so only the accepted (reorg re-check) scan fails here.
    pendingScanCalls = 100;
    acceptedScanCalls = 0;
    failAcceptedScanOnCall = 1;

    const lines: string[] = [];
    const reconciler = composeReconcilerV1({
      config: config(), databaseUrl: 'postgres://fake-host/fake-db', reader, logLine: line => lines.push(line),
    });

    try {
      const result = await reconciler.runPass();
      // worker.runOnce() ran and committed successfully (nothing pending in
      // this fake pool); only the independent reorg re-check scan threw.
      expect(result).toEqual({ ran: true, scanned: 0, accepted: 0, paused: 0, pending: 0, failed: 0, revoked: 0 });

      const recheckFailureLines = lines.filter(line => line.includes('chain.recheck_failed'));
      expect(recheckFailureLines).toHaveLength(1);
      const parsed = JSON.parse(recheckFailureLines[0]!) as Record<string, unknown>;
      expect(parsed).toMatchObject({ level: 'error', event: 'chain.recheck_failed', code: 'RECHECK_FAILED' });
      expect(Object.keys(parsed).sort()).toEqual(['code', 'event', 'level', 'service', 'timestampMs']);
      expect(recheckFailureLines[0]).not.toContain('password');
      expect(recheckFailureLines[0]).not.toContain('db.internal');
      expect(recheckFailureLines[0]).not.toContain('connection to server');

      // The pass is still reported complete, not failed, and the outer
      // catastrophic-failure log line must not have fired.
      expect(lines.filter(line => line.includes('chain.pass_failed'))).toHaveLength(0);
      expect(lines.filter(line => line.includes('chain.pass_complete'))).toHaveLength(1);
    } finally {
      await reconciler.close();
    }
  });
});
