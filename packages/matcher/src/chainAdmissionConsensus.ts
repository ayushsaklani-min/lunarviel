import type { StoredOrderEnvelopeRecordV1 } from '@lunarveil/db';

export interface OnChainOrderAdmissionV1 {
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly txId: string;
  readonly leafIndex?: string;
}

export type ChainAdmissionObservationV1 =
  | { readonly sourceId: string; readonly outcome: 'INCLUDED'; readonly admission: OnChainOrderAdmissionV1 }
  | { readonly sourceId: string; readonly outcome: 'NOT_FOUND' | 'UNAVAILABLE' };

export interface ChainAdmissionConsensusInputV1 {
  readonly order: Pick<StoredOrderEnvelopeRecordV1, 'marketId' | 'epochId' | 'commitment' | 'state'>;
  /** Explicit, policy-controlled number of agreeing `INCLUDED` observations. */
  readonly requiredMatchingSources: number;
  readonly observations: readonly ChainAdmissionObservationV1[];
}

export type ChainAdmissionConsensusDecisionV1 =
  | {
    readonly action: 'ACCEPT';
    readonly code: 'ADMISSION_CONFIRMED';
    readonly sourceIds: readonly string[];
    readonly admission: OnChainOrderAdmissionV1;
  }
  | {
    readonly action: 'KEEP_PENDING';
    readonly code: 'AWAITING_CHAIN_CONFIRMATION' | 'INSUFFICIENT_CHAIN_QUORUM';
    readonly sourceIds: readonly string[];
  }
  | {
    readonly action: 'PAUSE';
    readonly code: 'INDEXER_DISAGREEMENT' | 'ONCHAIN_ADMISSION_MISMATCH';
    readonly sourceIds: readonly string[];
  };

export class ChainAdmissionConsensusError extends Error {
  constructor(readonly code: 'ORDER_NOT_PENDING' | 'INVALID_QUORUM' | 'DUPLICATE_SOURCE' | 'INVALID_OBSERVATION') {
    super(code);
    this.name = 'ChainAdmissionConsensusError';
  }
}

function assertSafeIdentifier(value: string): void {
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ChainAdmissionConsensusError('INVALID_OBSERVATION');
  }
}

function assertAdmission(admission: OnChainOrderAdmissionV1): void {
  assertSafeIdentifier(admission.marketId);
  assertSafeIdentifier(admission.epochId);
  assertSafeIdentifier(admission.commitment);
  assertSafeIdentifier(admission.txId);
  if (admission.leafIndex !== undefined && !/^(0|[1-9][0-9]*)$/u.test(admission.leafIndex)) {
    throw new ChainAdmissionConsensusError('INVALID_OBSERVATION');
  }
}

function sameAdmission(left: OnChainOrderAdmissionV1, right: OnChainOrderAdmissionV1): boolean {
  return left.marketId === right.marketId
    && left.epochId === right.epochId
    && left.commitment === right.commitment
    && left.txId === right.txId
    && left.leafIndex === right.leafIndex;
}

function matchesOrder(admission: OnChainOrderAdmissionV1, order: ChainAdmissionConsensusInputV1['order']): boolean {
  return admission.marketId === order.marketId
    && admission.epochId === order.epochId
    && admission.commitment === order.commitment;
}

/**
 * Deterministic reconciliation policy. Chain clients/indexers fetch and verify
 * evidence outside this function; this function never uses a clock, network,
 * database or private-order data. It returns PAUSE on any conflicting evidence.
 */
export function evaluateChainAdmissionConsensusV1(
  input: ChainAdmissionConsensusInputV1,
): ChainAdmissionConsensusDecisionV1 {
  if (input.order.state !== 'PENDING_CHAIN') throw new ChainAdmissionConsensusError('ORDER_NOT_PENDING');
  if (!Number.isSafeInteger(input.requiredMatchingSources) || input.requiredMatchingSources < 1) {
    throw new ChainAdmissionConsensusError('INVALID_QUORUM');
  }

  const observations = [...input.observations].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sourceIds: string[] = [];
  for (const observation of observations) {
    assertSafeIdentifier(observation.sourceId);
    if (sourceIds.at(-1) === observation.sourceId) throw new ChainAdmissionConsensusError('DUPLICATE_SOURCE');
    sourceIds.push(observation.sourceId);
    if (observation.outcome === 'INCLUDED') assertAdmission(observation.admission);
  }

  const included = observations.filter((observation): observation is Extract<ChainAdmissionObservationV1, { outcome: 'INCLUDED' }> => (
    observation.outcome === 'INCLUDED'
  ));
  if (included.length === 0) {
    return { action: 'KEEP_PENDING', code: 'AWAITING_CHAIN_CONFIRMATION', sourceIds };
  }

  const canonical = included[0]!.admission;
  if (!matchesOrder(canonical, input.order) || included.some(({ admission }) => !sameAdmission(admission, canonical))) {
    return { action: 'PAUSE', code: 'ONCHAIN_ADMISSION_MISMATCH', sourceIds };
  }
  if (observations.some((observation) => observation.outcome === 'NOT_FOUND')) {
    return { action: 'PAUSE', code: 'INDEXER_DISAGREEMENT', sourceIds };
  }
  if (included.length < input.requiredMatchingSources) {
    return { action: 'KEEP_PENDING', code: 'INSUFFICIENT_CHAIN_QUORUM', sourceIds };
  }
  return {
    action: 'ACCEPT',
    code: 'ADMISSION_CONFIRMED',
    sourceIds,
    admission: { ...canonical },
  };
}
