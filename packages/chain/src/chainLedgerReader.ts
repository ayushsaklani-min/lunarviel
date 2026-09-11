/**
 * Identifies one order's admission question. `marketId` is required because a
 * commitment is only meaningful against that market's deployed contract, and
 * no implementation may guess which contract a commitment belongs to.
 */
export interface ChainAdmissionQueryV1 {
  readonly marketId: string;
  readonly commitment: string;
}

/** Present-but-unconfirmed is still `present`; depth is applied by the source. */
export type ChainAdmissionReadV1 =
  | {
    readonly present: true;
    readonly txId: string;
    readonly leafIndex: string;
    readonly inclusionHeight: bigint;
  }
  | { readonly present: false };

/**
 * Narrow read-only chain view. Kept as a port so every admission decision is
 * unit-testable without a network, and so a second implementation can be added
 * without touching decision logic.
 *
 * `readAdmission` carries a hard contract that both consumers depend on:
 * `{ present: false }` means "definitively absent from the chain view", which
 * `ReorgRecheckServiceV1` reads as a reorg. An implementation that merely
 * cannot answer must throw instead, so the failure degrades to
 * `UNAVAILABLE`/`UNVERIFIABLE` rather than a false revocation alert.
 */
export interface ChainLedgerReaderV1 {
  readAdmission(input: ChainAdmissionQueryV1): Promise<ChainAdmissionReadV1>;
  readTipHeight(): Promise<bigint>;
}
