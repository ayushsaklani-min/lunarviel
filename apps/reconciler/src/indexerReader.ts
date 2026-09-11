import {
  ContractActionAdmissionReaderV1,
  type ChainAdmissionQueryV1,
  type ChainAdmissionReadV1,
  type ChainLedgerReaderV1,
  type ContractStateCommitmentIndexV1,
  type MarketContractRegistryV1,
} from '@lunarveil/chain';

import type { ReconcilerConfigV1 } from './config.js';
import { createIndexerContractActionSourceV1 } from './indexerContractActionSource.js';
import { postIndexerQueryV1 } from './indexerGraphql.js';

const TIP_HEIGHT_QUERY = '{ block { height } }';
const TIP_HEIGHT_TIMEOUT_MS = 10_000;

interface IndexerBlockHeightDataV1 {
  readonly block?: { readonly height?: unknown } | null;
}

/**
 * Reads the chain tip from the indexer's documented top-level `block` query:
 * "Find a block for the given optional offset; if not present, the latest
 * block is returned." The `PublicDataProvider` wrapper returned by
 * `indexerPublicDataProvider(...)` exposes no tip-height method at all, so
 * this queries the same official endpoint directly.
 */
export async function readIndexerTipHeightV1(config: ReconcilerConfigV1): Promise<bigint> {
  const data = await postIndexerQueryV1<IndexerBlockHeightDataV1>({
    url: config.indexerUrl,
    query: TIP_HEIGHT_QUERY,
    codePrefix: 'INDEXER_TIP_HEIGHT',
    timeoutMs: TIP_HEIGHT_TIMEOUT_MS,
  });
  const height = data.block?.height;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
    throw new Error('INDEXER_TIP_HEIGHT_MALFORMED');
  }
  return BigInt(height);
}

/**
 * The fallback reader: a real tip height, and an admission read that always
 * fails closed.
 *
 * This is what the reconciler runs when no ledger-state decoder is configured.
 * Decoding a serialized contract state requires the Compact-generated ledger
 * for the deployed contract, and that output is a build artifact this
 * repository deliberately does not vendor, so it cannot be a default.
 *
 * `readAdmission` **throws** `INDEXER_ADMISSION_UNRESOLVED` rather than
 * returning `{ present: false }`. That is not a style choice:
 * `{ present: false }` means "definitively absent from the chain" to both
 * consumers, and this reader does not know that. `MidnightIndexerAdmissionSourceV1`
 * turns the throw into `UNAVAILABLE` (order stays pending) and
 * `ReorgRecheckServiceV1` into `UNVERIFIABLE` (no alert), whereas
 * `{ present: false }` would have raised a false `ADMISSION_REVOKED` alert for
 * every accepted order in the re-check window. See ADR-0035.
 *
 * To resolve admission for real, configure a decoder and use
 * `createContractActionChainLedgerReaderV1` (ADR-0036).
 */
export function createIndexerChainLedgerReaderV1(config: ReconcilerConfigV1): ChainLedgerReaderV1 {
  return {
    async readAdmission(_input: ChainAdmissionQueryV1): Promise<ChainAdmissionReadV1> {
      throw new Error('INDEXER_ADMISSION_UNRESOLVED');
    },

    async readTipHeight(): Promise<bigint> {
      return readIndexerTipHeightV1(config);
    },
  };
}

/**
 * The resolving reader: contract-action history from the official indexer,
 * a market-to-contract registry, and an injected ledger-state decoder.
 *
 * Every dependency it does not own is injected, so the decision logic stays in
 * `@lunarveil/chain` and remains testable without a network or a compiler.
 */
export function createContractActionChainLedgerReaderV1(input: {
  readonly config: ReconcilerConfigV1;
  readonly registry: MarketContractRegistryV1;
  readonly membership: ContractStateCommitmentIndexV1;
  readonly maxSearchQueries?: number;
}): ChainLedgerReaderV1 {
  const { config } = input;
  return new ContractActionAdmissionReaderV1(
    {
      registry: input.registry,
      actions: createIndexerContractActionSourceV1(config),
      membership: input.membership,
      readTipHeight: () => readIndexerTipHeightV1(config),
    },
    input.maxSearchQueries === undefined ? {} : { maxSearchQueries: input.maxSearchQueries },
  );
}
