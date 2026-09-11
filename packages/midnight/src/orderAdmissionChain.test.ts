import { describe, expect, it, vi } from 'vitest';

import { MidnightOrderAdmissionChainV1 } from './orderAdmissionChain.js';

const base = {
  orderId: 'order-1', clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
  marketId: 'market-1', epochId: 'epoch-1', epochSequence: 7n,
  contractAddress: 'a'.repeat(64), commitment: 'b'.repeat(64),
};

describe('MidnightOrderAdmissionChainV1', () => {
  it('uses the generated circuit argument order and accepts only full success', async () => {
    let observedCommitment: Uint8Array | undefined;
    let observedRequestKey: Uint8Array | undefined;
    const submitOrderCommitment = vi.fn(async (
      _epochSequence: bigint, commitment: Uint8Array, requestKey: Uint8Array,
    ) => {
      observedCommitment = commitment.slice();
      observedRequestKey = requestKey.slice();
      return { public: { txId: 'c'.repeat(64), status: 'SucceedEntirely' } };
    });
    const adapter = new MidnightOrderAdmissionChainV1({
      succeedEntirelyStatus: 'SucceedEntirely',
      contractAt: vi.fn(async () => ({ callTx: { submitOrderCommitment } })),
      isCommitmentAdmitted: vi.fn(async () => false),
    });
    const requestKey = new Uint8Array(32).fill(7);
    await expect(adapter.submit({ ...base, requestKey })).resolves.toEqual({ publicTxId: 'c'.repeat(64) });
    expect(submitOrderCommitment).toHaveBeenCalledOnce();
    expect(submitOrderCommitment.mock.calls[0]?.[0]).toBe(7n);
    expect(observedCommitment).toEqual(new Uint8Array(Buffer.from('b'.repeat(64), 'hex')));
    expect(observedRequestKey).toEqual(requestKey);
  });

  it('fails closed for a partial/fallible-phase result', async () => {
    const adapter = new MidnightOrderAdmissionChainV1({
      succeedEntirelyStatus: 'SucceedEntirely',
      contractAt: async () => ({ callTx: { submitOrderCommitment: async () => ({
        public: { txId: 'c'.repeat(64), status: 'FailFalliblePhase' },
      }) } }),
      isCommitmentAdmitted: async () => false,
    });
    await expect(adapter.submit({ ...base, requestKey: new Uint8Array(32) }))
      .rejects.toThrow('ADMISSION_NOT_SUCCESSFUL');
  });

  it('delegates the pre-mutation indexed-state check', async () => {
    const isCommitmentAdmitted = vi.fn(async () => true);
    const adapter = new MidnightOrderAdmissionChainV1({
      succeedEntirelyStatus: 'SucceedEntirely',
      contractAt: async () => { throw new Error('unused'); },
      isCommitmentAdmitted,
    });
    await expect(adapter.isAdmitted(base)).resolves.toBe(true);
    expect(isCommitmentAdmitted).toHaveBeenCalledWith(base.contractAddress, 7n, base.commitment);
  });
});
