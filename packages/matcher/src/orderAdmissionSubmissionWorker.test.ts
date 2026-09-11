import { describe, expect, it, vi } from 'vitest';

import type { OrderAdmissionSubmissionCandidateV1 } from '@lunarveil/db';

import {
  deriveAdmissionRequestKeyV1,
  OrderAdmissionSubmissionWorkerV1,
  type OrderAdmissionChainV1,
  type OrderAdmissionSubmissionRepositoryV1,
} from './orderAdmissionSubmissionWorker.js';

const candidate: OrderAdmissionSubmissionCandidateV1 = {
  orderId: 'order-1',
  clientRequestId: '123e4567-e89b-42d3-a456-426614174000',
  marketId: 'market-1',
  epochId: 'epoch-1',
  epochSequence: 7n,
  contractAddress: 'a'.repeat(64),
  commitment: 'b'.repeat(64),
};

function fixture(options: { admitted?: boolean; submitError?: boolean; claimed?: boolean } = {}) {
  const repository: OrderAdmissionSubmissionRepositoryV1 = {
    listCandidates: vi.fn(async () => [candidate]),
    claim: vi.fn(async () => options.claimed === false
      ? { claimed: false as const, state: 'ATTEMPTING' as const }
      : { claimed: true as const }),
    markSubmitted: vi.fn(async () => undefined),
    markUncertain: vi.fn(async () => undefined),
  };
  const chain: OrderAdmissionChainV1 = {
    isAdmitted: vi.fn(async () => options.admitted ?? false),
    submit: vi.fn(async input => {
      if (options.submitError) throw new Error('sensitive SDK detail');
      expect(input.requestKey).toHaveLength(32);
      return { publicTxId: 'c'.repeat(64) };
    }),
  };
  return { repository, chain, worker: new OrderAdmissionSubmissionWorkerV1(repository, chain) };
}

describe('OrderAdmissionSubmissionWorkerV1', () => {
  it('claims before submitting and records only the finalized public transaction ID', async () => {
    const { repository, chain, worker } = fixture();
    await expect(worker.runOnce()).resolves.toEqual({
      scanned: 1, submitted: 1, alreadyAdmitted: 0, skipped: 0, uncertain: 0, failed: 0,
    });
    expect(repository.claim).toHaveBeenCalledWith(candidate.orderId);
    expect(chain.submit).toHaveBeenCalledOnce();
    expect(repository.markSubmitted).toHaveBeenCalledWith(candidate.orderId, 'c'.repeat(64));
  });

  it('does not mutate when the commitment is already indexed', async () => {
    const { repository, chain, worker } = fixture({ admitted: true });
    await expect(worker.runOnce()).resolves.toEqual({
      scanned: 1, submitted: 0, alreadyAdmitted: 1, skipped: 0, uncertain: 0, failed: 0,
    });
    expect(repository.claim).not.toHaveBeenCalled();
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('marks an opaque uncertain outcome and never retries inside the pass', async () => {
    const { repository, worker } = fixture({ submitError: true });
    await expect(worker.runOnce()).resolves.toEqual({
      scanned: 1, submitted: 0, alreadyAdmitted: 0, skipped: 0, uncertain: 1, failed: 0,
    });
    expect(repository.markUncertain).toHaveBeenCalledWith(candidate.orderId);
  });

  it('skips a candidate already claimed by another worker', async () => {
    const { chain, worker } = fixture({ claimed: false });
    await expect(worker.runOnce()).resolves.toEqual({
      scanned: 1, submitted: 0, alreadyAdmitted: 0, skipped: 1, uncertain: 0, failed: 0,
    });
    expect(chain.submit).not.toHaveBeenCalled();
  });

  it('isolates a pre-mutation chain-read failure without creating a claim', async () => {
    const { repository, chain, worker } = fixture();
    vi.mocked(chain.isAdmitted).mockRejectedValueOnce(new Error('private transport detail'));
    await expect(worker.runOnce()).resolves.toEqual({
      scanned: 1, submitted: 0, alreadyAdmitted: 0, skipped: 0, uncertain: 0, failed: 1,
    });
    expect(repository.claim).not.toHaveBeenCalled();
    expect(chain.submit).not.toHaveBeenCalled();
  });
});

describe('deriveAdmissionRequestKeyV1', () => {
  it('is deterministic, domain separated and rejects malformed IDs', () => {
    const first = deriveAdmissionRequestKeyV1(candidate.clientRequestId);
    const second = deriveAdmissionRequestKeyV1(candidate.clientRequestId.toUpperCase());
    expect(Buffer.from(first).toString('hex')).toBe(Buffer.from(second).toString('hex'));
    expect(first).toHaveLength(32);
    expect(() => deriveAdmissionRequestKeyV1('not-a-uuid')).toThrow('INVALID_CLIENT_REQUEST_ID');
  });
});
