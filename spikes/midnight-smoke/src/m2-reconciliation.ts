export interface CommitmentLookup {
  findPathForLeaf(commitment: Uint8Array): unknown | undefined;
}

export interface NullifierLookup {
  member(nullifier: Uint8Array): boolean;
}

export interface ReconciliationLedger {
  orderCommitments: CommitmentLookup;
  epochClosed: boolean;
  closedRoot: { field: bigint };
  closedByRequestKey: Uint8Array;
  consumedOrderNullifiers: NullifierLookup;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function admissionIsApplied(
  current: Pick<ReconciliationLedger, 'orderCommitments'>,
  commitment: Uint8Array,
): boolean {
  return current.orderCommitments.findPathForLeaf(commitment) !== undefined;
}

export function closeIsApplied(
  current: Pick<ReconciliationLedger, 'epochClosed' | 'closedRoot' | 'closedByRequestKey'>,
  expectedRoot: { field: bigint },
  requestKey: Uint8Array,
): boolean {
  return current.epochClosed
    && current.closedRoot.field === expectedRoot.field
    && bytesEqual(current.closedByRequestKey, requestKey);
}

export function cancellationIsApplied(
  current: Pick<ReconciliationLedger, 'consumedOrderNullifiers'>,
  nullifier: Uint8Array,
): boolean {
  return current.consumedOrderNullifiers.member(nullifier);
}
