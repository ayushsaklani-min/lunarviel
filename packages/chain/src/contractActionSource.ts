/**
 * One public contract action as the indexer reports it.
 *
 * `stateHex` is the hex-encoded serialized public contract state *after* the
 * action. Nothing here is private: state, transaction hash and block height
 * are all publicly indexed values.
 */
export interface ContractActionV1 {
  readonly address: string;
  readonly stateHex: string;
  readonly txId: string;
  readonly blockHeight: bigint;
}

/**
 * Read-only view over a contract's action history.
 *
 * Both methods resolve to `undefined` when the chain view genuinely has no
 * action for the address at that point (for a height below the deployment,
 * say). Any transport, protocol or validation failure must throw instead, so
 * "cannot read" is never confused with "nothing there".
 */
export interface ContractActionSourceV1 {
  /** The most recent action for this contract. */
  readLatestAction(input: { readonly address: string }): Promise<ContractActionV1 | undefined>;
  /** The most recent action at or before `blockHeight`. */
  readActionAtHeight(
    input: { readonly address: string; readonly blockHeight: bigint },
  ): Promise<ContractActionV1 | undefined>;
}
