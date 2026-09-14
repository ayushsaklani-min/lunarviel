import type { MatcherDecryptionKeyV1, OrderEnvelopeV1 } from '@lunarveil/crypto';
import type { OrderAdmissionSubmissionCandidateV1 } from '@lunarveil/db';

import { validateM3AdmissionEnvelopeV1 } from './closedEpochMatching.js';
import type { OrderAdmissionPreflightV1 } from './orderAdmissionSubmissionWorker.js';

/** Matcher-only ciphertext access. Public/API repositories must not implement this port. */
export interface PendingAdmissionEnvelopeLoaderV1 {
  loadPendingEnvelope(orderId: string): Promise<OrderEnvelopeV1>;
}

export interface AdmissionMatcherKeyResolverV1 {
  resolveExistingEnvelopeKey(keyId: string): Promise<MatcherDecryptionKeyV1>;
}

/**
 * Bridges the private ciphertext/key boundary to the public admission worker.
 * No decrypted order value is returned or logged.
 */
export class M3AdmissionPreflightV1 implements OrderAdmissionPreflightV1 {
  constructor(
    private readonly envelopes: PendingAdmissionEnvelopeLoaderV1,
    private readonly keys: AdmissionMatcherKeyResolverV1,
    private readonly nowMs: () => bigint = () => BigInt(Date.now()),
  ) {}

  async validate(candidate: OrderAdmissionSubmissionCandidateV1): Promise<void> {
    const envelope = await this.envelopes.loadPendingEnvelope(candidate.orderId);
    if (envelope.marketId !== candidate.marketId || envelope.epochId !== candidate.epochId
      || envelope.commitment !== candidate.commitment) {
      throw new Error('ADMISSION_ENVELOPE_METADATA_MISMATCH');
    }
    const key = await this.keys.resolveExistingEnvelopeKey(envelope.encryptionKeyId);
    await validateM3AdmissionEnvelopeV1({
      envelope, marketId: candidate.marketId, epochSequence: candidate.epochSequence,
      nowMs: this.nowMs(), key,
    });
  }
}
