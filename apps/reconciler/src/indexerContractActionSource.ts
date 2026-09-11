import type { ContractActionSourceV1, ContractActionV1 } from '@lunarveil/chain';

import type { ReconcilerConfigV1 } from './config.js';
import { IndexerGraphqlError, postIndexerQueryV1 } from './indexerGraphql.js';

const CONTRACT_ACTION_TIMEOUT_MS = 15_000;
const HEX_PATTERN = /^(?:[0-9a-fA-F]{2})+$/u;

/**
 * Verified against the installed indexer client's own generated schema types
 * (`@midnight-ntwrk/midnight-js-indexer-public-data-provider@4.1.1`,
 * `dist/gen/graphql.d.ts`), not invented:
 *
 * - `Query.contractAction(address: HexEncoded!, offset: ContractActionOffset)`
 *   — "Find a contract action for the given address and optional offset."
 * - `ContractAction { address, state, transaction, zswapState, ... }`, where
 *   `state` is the hex-encoded serialized public contract state.
 * - `Transaction { hash, block, ... }` and `Block { height, ... }`, so a
 *   contract *call* — which is what an order admission is — carries its own
 *   transaction hash and block height directly. This is the correlation the
 *   `PublicDataProvider` wrapper does not expose (it correlates a tx id for
 *   contract deployments only), which is why this reads the documented
 *   GraphQL endpoint rather than routing through that wrapper.
 * - `ContractActionOffset` is `{ blockOffset }` or `{ transactionOffset }`,
 *   and `BlockOffset` is `{ hash }` or `{ height }`.
 */
const CONTRACT_ACTION_FIELDS = `
  address
  state
  transaction { hash block { height } }
`;

const LATEST_ACTION_QUERY = `
  query LunarveilLatestContractAction($address: HexEncoded!) {
    contractAction(address: $address) { ${CONTRACT_ACTION_FIELDS} }
  }
`;

const ACTION_AT_HEIGHT_QUERY = `
  query LunarveilContractActionAtHeight($address: HexEncoded!, $height: Int!) {
    contractAction(address: $address, offset: { blockOffset: { height: $height } }) { ${CONTRACT_ACTION_FIELDS} }
  }
`;

interface ContractActionResponseV1 {
  readonly contractAction?: {
    readonly address?: unknown;
    readonly state?: unknown;
    readonly transaction?: { readonly hash?: unknown; readonly block?: { readonly height?: unknown } | null } | null;
  } | null;
}

function parseAction(payload: ContractActionResponseV1): ContractActionV1 | undefined {
  const action = payload.contractAction;
  if (action === undefined || action === null) return undefined;

  const address = action.address;
  const state = action.state;
  const hash = action.transaction?.hash;
  const height = action.transaction?.block?.height;
  if (
    typeof address !== 'string' || !HEX_PATTERN.test(address)
    || typeof state !== 'string' || !HEX_PATTERN.test(state)
    || typeof hash !== 'string' || !HEX_PATTERN.test(hash)
    || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0
  ) {
    // A response we cannot parse is not evidence that nothing is there.
    throw new IndexerGraphqlError('INDEXER_CONTRACT_ACTION_MALFORMED');
  }

  return {
    address: address.toLowerCase(),
    stateHex: state.toLowerCase(),
    // The transaction hash, not the SDK's longer transaction identifier: the
    // hash is what this public schema exposes on a contract action, and it is
    // the value stored as the order's chain admission tx id.
    txId: hash.toLowerCase(),
    blockHeight: BigInt(height),
  };
}

/** `Block.height` is a GraphQL `Int`, so a height beyond 2^31-1 is unrepresentable. */
const MAX_GRAPHQL_INT = 2_147_483_647n;

/**
 * Reads a contract's public action history from the official indexer GraphQL
 * endpoint. It is read-only, sends no order data, and returns `undefined` only
 * when the indexer positively reports no action for that address and offset.
 */
export function createIndexerContractActionSourceV1(config: ReconcilerConfigV1): ContractActionSourceV1 {
  return {
    async readLatestAction(input): Promise<ContractActionV1 | undefined> {
      return parseAction(await postIndexerQueryV1<ContractActionResponseV1>({
        url: config.indexerUrl,
        query: LATEST_ACTION_QUERY,
        variables: { address: input.address },
        codePrefix: 'INDEXER_CONTRACT_ACTION',
        timeoutMs: CONTRACT_ACTION_TIMEOUT_MS,
      }));
    },

    async readActionAtHeight(input): Promise<ContractActionV1 | undefined> {
      if (input.blockHeight < 0n || input.blockHeight > MAX_GRAPHQL_INT) {
        throw new IndexerGraphqlError('INDEXER_CONTRACT_ACTION_HEIGHT_OUT_OF_RANGE');
      }
      return parseAction(await postIndexerQueryV1<ContractActionResponseV1>({
        url: config.indexerUrl,
        query: ACTION_AT_HEIGHT_QUERY,
        variables: { address: input.address, height: Number(input.blockHeight) },
        codePrefix: 'INDEXER_CONTRACT_ACTION',
        timeoutMs: CONTRACT_ACTION_TIMEOUT_MS,
      }));
    },
  };
}
