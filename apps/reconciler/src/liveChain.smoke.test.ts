import { describe, expect, it } from 'vitest';

import { parseReconcilerConfigV1 } from './config.js';
import { createIndexerContractActionSourceV1 } from './indexerContractActionSource.js';
import { createIndexerChainLedgerReaderV1 } from './indexerReader.js';

// The verified M3 Preview deployment (block 730027), recorded in project memory.
const M3_CONTRACT_ADDRESS = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';

// Opt-in and read-only. It needs no wallet credential, no prover and writes nothing.
const enabled = process.env.LUNARVEIL_LIVE_CHAIN_SMOKE === 'true';

(enabled ? describe : describe.skip)('live Preview chain read', () => {
  it('reads a plausible tip height from the official indexer', async () => {
    const reader = createIndexerChainLedgerReaderV1(parseReconcilerConfigV1(process.env));
    const tip = await reader.readTipHeight();
    expect(typeof tip).toBe('bigint');
    // The verified M3 deployment sits at block 730027, so the tip cannot precede it.
    expect(tip).toBeGreaterThan(730_027n);
  }, 60_000);

  it('fails closed on admission rather than claiming a commitment is absent', async () => {
    // readAdmission cannot honestly confirm absence either (no market-to-
    // contract-address mapping, and the installed indexer client does not
    // correlate ordinary contract calls with a transaction id). It throws a
    // sanitized error rather than returning `{ present: false }`, which
    // would be misread downstream as a confirmed reorg. See ADR-0035.
    const reader = createIndexerChainLedgerReaderV1(parseReconcilerConfigV1(process.env));
    await expect(reader.readAdmission({ marketId: 'market-1', commitment: 'ee'.repeat(32) })).rejects.toThrow('INDEXER_ADMISSION_UNRESOLVED');
  }, 60_000);
  it('reads the deployed M3 contract action with its correlated transaction', async () => {
    // This is the correlation the indexer JS client does not expose for
    // ordinary contract calls; the documented GraphQL schema does.
    const source = createIndexerContractActionSourceV1(parseReconcilerConfigV1(process.env));
    const action = await source.readLatestAction({ address: M3_CONTRACT_ADDRESS });

    expect(action).toBeDefined();
    expect(action?.address).toBe(M3_CONTRACT_ADDRESS);
    expect(action?.stateHex).toMatch(/^(?:[0-9a-f]{2})+$/u);
    expect(action?.txId).toMatch(/^(?:[0-9a-f]{2})+$/u);
    expect(action?.blockHeight).toBeGreaterThanOrEqual(730_027n);
  }, 60_000);

  it('reads the same contract at a historical block offset', async () => {
    const source = createIndexerContractActionSourceV1(parseReconcilerConfigV1(process.env));
    const action = await source.readActionAtHeight({
      address: M3_CONTRACT_ADDRESS, blockHeight: 730_027n,
    });

    expect(action?.blockHeight).toBeLessThanOrEqual(730_027n);
    // Nothing exists for this contract before it was deployed.
    expect(await source.readActionAtHeight({ address: M3_CONTRACT_ADDRESS, blockHeight: 700_000n }))
      .toBeUndefined();
  }, 60_000);
});
