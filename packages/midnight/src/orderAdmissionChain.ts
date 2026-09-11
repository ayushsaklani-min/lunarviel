import type { OrderAdmissionSubmissionCandidateV1 } from '@lunarveil/db';

export interface MidnightAdmissionContractV1 {
  readonly callTx: {
    submitOrderCommitment(
      epochSequence: bigint,
      commitment: Uint8Array,
      requestKey: Uint8Array,
    ): Promise<{ readonly public: { readonly txId: string; readonly status: string } }>;
  };
}

export interface MidnightOrderAdmissionDependenciesV1 {
  readonly succeedEntirelyStatus: string;
  readonly contractAt: (contractAddress: string) => Promise<MidnightAdmissionContractV1>;
  readonly isCommitmentAdmitted: (
    contractAddress: string,
    epochSequence: bigint,
    commitment: string,
  ) => Promise<boolean>;
}

function bytes32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(hex)) throw new Error('INVALID_BYTES32');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Thin adapter over the installed Midnight.js 4.1.1 `findDeployedContract`
 * result. The composition root supplies contract discovery and indexed-state
 * reading, while this boundary fixes the generated M3 circuit arguments and
 * requires a SucceedEntirely finalization before reporting success.
 */
export class MidnightOrderAdmissionChainV1 {
  constructor(private readonly dependencies: MidnightOrderAdmissionDependenciesV1) {
    if (!dependencies.succeedEntirelyStatus) throw new Error('INVALID_SUCCESS_STATUS');
  }

  isAdmitted(candidate: OrderAdmissionSubmissionCandidateV1): Promise<boolean> {
    return this.dependencies.isCommitmentAdmitted(
      candidate.contractAddress,
      candidate.epochSequence,
      candidate.commitment,
    );
  }

  async submit(input: OrderAdmissionSubmissionCandidateV1 & { readonly requestKey: Uint8Array }): Promise<{
    readonly publicTxId: string;
  }> {
    if (!(input.requestKey instanceof Uint8Array) || input.requestKey.length !== 32) {
      throw new Error('INVALID_REQUEST_KEY');
    }
    const commitment = bytes32(input.commitment);
    try {
      const contract = await this.dependencies.contractAt(input.contractAddress);
      const finalized = await contract.callTx.submitOrderCommitment(
        input.epochSequence,
        commitment,
        input.requestKey,
      );
      if (finalized.public.status !== this.dependencies.succeedEntirelyStatus) {
        throw new Error('ADMISSION_NOT_SUCCESSFUL');
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(finalized.public.txId)) {
        throw new Error('INVALID_PUBLIC_TX_ID');
      }
      return { publicTxId: finalized.public.txId };
    } finally {
      commitment.fill(0);
    }
  }
}
