export type CommitmentMembershipV1 =
  | { readonly member: true; readonly leafIndex: string }
  | { readonly member: false };

/**
 * Decodes a serialized public contract state and locates an order commitment
 * in it.
 *
 * This is a port rather than an implementation on purpose: decoding requires
 * the Compact-generated ledger for the deployed contract, and that generated
 * output is a build artifact (`**\/contracts/managed/` is git-ignored), so it
 * must never be vendored into a package. The deployment composition root
 * supplies the adapter; everything that decides admission stays testable
 * without a compiler.
 *
 * A state it cannot decode must throw, never report `member: false` — absence
 * is chain evidence, an undecodable state is not.
 */
export interface ContractStateCommitmentIndexV1 {
  locate(
    input: { readonly stateHex: string; readonly commitment: string },
  ): Promise<CommitmentMembershipV1>;
}
