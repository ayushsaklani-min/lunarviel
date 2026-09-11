import { createHash } from 'node:crypto';

import {
  canonicalOrderEnvelopeTransportV1,
  type OrderEnvelopeV1,
  validateOrderEnvelopeV1,
} from '@lunarveil/crypto';

export type EnvelopeWorkflowState = 'PENDING_CHAIN' | 'ACCEPTED' | 'REJECTED';

export interface StoredOrderEnvelopeV1 {
  readonly id: string;
  readonly requestFingerprint: string;
  readonly state: EnvelopeWorkflowState;
  readonly createdAtMs: bigint;
  readonly envelope: OrderEnvelopeV1;
}

export interface OrderEnvelopeIntakeResult {
  readonly record: StoredOrderEnvelopeV1;
  readonly replayed: boolean;
}

export class OrderEnvelopeIntakeError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'DUPLICATE_COMMITMENT') {
    super(code);
    this.name = 'OrderEnvelopeIntakeError';
  }
}

export interface OrderEnvelopeIntakeOptions {
  readonly nowMs: () => bigint;
  readonly nextId: () => string;
}

export function orderEnvelopeRequestFingerprintV1(envelope: OrderEnvelopeV1): string {
  return createHash('sha256').update(canonicalOrderEnvelopeTransportV1(envelope), 'utf8').digest('hex');
}

/**
 * Reference intake store for the service layer. It intentionally has no method
 * accepting a raw order. Production storage must implement the same semantics
 * using a ciphertext-only PostgreSQL transaction.
 */
export class InMemoryOrderEnvelopeIntake {
  private readonly byClientRequestId = new Map<string, StoredOrderEnvelopeV1>();
  private readonly byCommitment = new Map<string, StoredOrderEnvelopeV1>();

  constructor(private readonly options: OrderEnvelopeIntakeOptions) {}

  submit(envelope: OrderEnvelopeV1): OrderEnvelopeIntakeResult {
    const requestFingerprint = orderEnvelopeRequestFingerprintV1(envelope);
    const existingRequest = this.byClientRequestId.get(envelope.clientRequestId);
    if (existingRequest) {
      if (existingRequest.requestFingerprint !== requestFingerprint) {
        throw new OrderEnvelopeIntakeError('IDEMPOTENCY_CONFLICT');
      }
      return { record: existingRequest, replayed: true };
    }

    const existingCommitment = this.byCommitment.get(envelope.commitment);
    if (existingCommitment) throw new OrderEnvelopeIntakeError('DUPLICATE_COMMITMENT');

    const record: StoredOrderEnvelopeV1 = {
      id: this.options.nextId(),
      requestFingerprint,
      state: 'PENDING_CHAIN',
      createdAtMs: this.options.nowMs(),
      envelope: Object.freeze({ ...envelope }),
    };
    this.byClientRequestId.set(envelope.clientRequestId, record);
    this.byCommitment.set(envelope.commitment, record);
    return { record, replayed: false };
  }

  findByClientRequestId(clientRequestId: string): StoredOrderEnvelopeV1 | undefined {
    return this.byClientRequestId.get(clientRequestId);
  }

  size(): number {
    return this.byClientRequestId.size;
  }
}
