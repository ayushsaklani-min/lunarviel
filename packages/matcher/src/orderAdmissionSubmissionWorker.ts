import { createHash } from 'node:crypto';

import type {
  OrderAdmissionSubmissionCandidateV1,
  OrderAdmissionSubmissionClaimV1,
} from '@lunarveil/db';

export interface OrderAdmissionSubmissionRepositoryV1 {
  listCandidates(limit: number): Promise<readonly OrderAdmissionSubmissionCandidateV1[]>;
  claim(orderId: string): Promise<OrderAdmissionSubmissionClaimV1>;
  markSubmitted(orderId: string, publicTxId: string): Promise<void>;
  markUncertain(orderId: string, errorCode?: string): Promise<void>;
}

export interface OrderAdmissionChainV1 {
  /** Public indexed-state check performed before any mutation. */
  isAdmitted(candidate: OrderAdmissionSubmissionCandidateV1): Promise<boolean>;
  /** Resolves only after a SucceedEntirely finalization. */
  submit(input: OrderAdmissionSubmissionCandidateV1 & { readonly requestKey: Uint8Array }): Promise<{
    readonly publicTxId: string;
  }>;
  /** Releases wallet/provider resources owned by the deployment adapter. */
  close?(): Promise<void>;
}

export interface OrderAdmissionSubmissionRunV1 {
  readonly scanned: number;
  readonly submitted: number;
  readonly alreadyAdmitted: number;
  readonly skipped: number;
  readonly uncertain: number;
  readonly failed: number;
}

/** Stable public idempotency key; it contains no order plaintext or wallet material. */
export function deriveAdmissionRequestKeyV1(clientRequestId: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(clientRequestId)) {
    throw new Error('INVALID_CLIENT_REQUEST_ID');
  }
  return createHash('sha256')
    .update('LUNARVEIL_ADMISSION_REQUEST_V1\0', 'utf8')
    .update(clientRequestId.toLowerCase(), 'utf8')
    .digest();
}

/**
 * Runs one bounded admission pass. The durable claim is made before the
 * external mutation. Any error after that point becomes UNCERTAIN and is not
 * retried automatically; the reconciler must establish the public outcome.
 */
export class OrderAdmissionSubmissionWorkerV1 {
  constructor(
    private readonly repository: OrderAdmissionSubmissionRepositoryV1,
    private readonly chain: OrderAdmissionChainV1,
    private readonly batchSize = 10,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error('INVALID_BATCH_SIZE');
    }
  }

  async runOnce(): Promise<OrderAdmissionSubmissionRunV1> {
    const candidates = await this.repository.listCandidates(this.batchSize);
    let submitted = 0;
    let alreadyAdmitted = 0;
    let skipped = 0;
    let uncertain = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        // A prior manual or crashed submission may be indexed even if no local
        // attempt row exists. Leave acceptance to the independent reconciler.
        if (await this.chain.isAdmitted(candidate)) {
          alreadyAdmitted += 1;
          continue;
        }

        const claim = await this.repository.claim(candidate.orderId);
        if (!claim.claimed) {
          skipped += 1;
          continue;
        }

        const requestKey = deriveAdmissionRequestKeyV1(candidate.clientRequestId);
        try {
          const finalized = await this.chain.submit({ ...candidate, requestKey });
          await this.repository.markSubmitted(candidate.orderId, finalized.publicTxId);
          submitted += 1;
        } catch {
          // The failure may occur after broadcast or finalization. Preserve no
          // underlying message and forbid automatic replay.
          try { await this.repository.markUncertain(candidate.orderId); } catch { /* ATTEMPTING is also fail-closed */ }
          uncertain += 1;
        } finally {
          requestKey.fill(0);
        }
      } catch {
        // A read/claim failure happened before the mutation boundary. Keep the
        // pass bounded and let a later pass retry this still-unclaimed order.
        failed += 1;
      }
    }

    return { scanned: candidates.length, submitted, alreadyAdmitted, skipped, uncertain, failed };
  }
}
