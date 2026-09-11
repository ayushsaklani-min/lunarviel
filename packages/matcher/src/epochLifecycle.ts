export type EpochLifecycleStateV1 = 'OPEN' | 'CLOSED' | 'PROVING' | 'PENDING_FIRMUP' | 'SETTLING' | 'FINALIZED' | 'RECOMPUTE' | 'INVALIDATED';

export interface FrozenEpochParametersV1 {
  readonly marketId: string;
  readonly epochId: string;
  readonly sequence: bigint;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly tickSizeAtomic: bigint;
  readonly lotSizeAtomic: bigint;
  readonly feeBps: bigint;
  readonly maxPriceCollarBps?: bigint;
}

export interface EpochLifecycleSnapshotV1 {
  readonly state: EpochLifecycleStateV1;
  readonly parameters: FrozenEpochParametersV1;
  readonly orderCount: number;
  readonly maxOrders: number;
}

export type EpochLifecycleEventV1 =
  | { readonly type: 'CLOSE'; readonly configHash: string }
  | { readonly type: 'START_PROVING'; readonly configHash: string }
  | { readonly type: 'PROOF_VERIFIED'; readonly configHash: string }
  | { readonly type: 'RECOMPUTE'; readonly configHash: string }
  | { readonly type: 'START_SETTLEMENT'; readonly configHash: string }
  | { readonly type: 'FINALIZE'; readonly configHash: string }
  | { readonly type: 'INVALIDATE'; readonly configHash: string };

export class EpochLifecycleError extends Error {
  constructor(readonly code: 'INVALID_PARAMETERS' | 'INVALID_ORDER_COUNT' | 'CONFIG_HASH_MISMATCH' | 'INVALID_TRANSITION' | 'TERMINAL_EPOCH') {
    super(code);
    this.name = 'EpochLifecycleError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[0-9a-f]{64}$/u;

function assertParameters(parameters: FrozenEpochParametersV1): void {
  if (!IDENTIFIER.test(parameters.marketId) || !IDENTIFIER.test(parameters.epochId)
    || !IDENTIFIER.test(parameters.ruleVersion) || !HASH.test(parameters.configHash)
    || parameters.sequence < 0n || parameters.tickSizeAtomic <= 0n || parameters.lotSizeAtomic <= 0n
    || parameters.feeBps < 0n || parameters.feeBps > 10_000n
    || (parameters.maxPriceCollarBps !== undefined && (parameters.maxPriceCollarBps < 0n || parameters.maxPriceCollarBps > 10_000n))) {
    throw new EpochLifecycleError('INVALID_PARAMETERS');
  }
}

function assertSnapshot(snapshot: EpochLifecycleSnapshotV1): void {
  assertParameters(snapshot.parameters);
  if (!Number.isSafeInteger(snapshot.orderCount) || snapshot.orderCount < 0
    || !Number.isSafeInteger(snapshot.maxOrders) || snapshot.maxOrders < 1
    || snapshot.orderCount > snapshot.maxOrders) {
    throw new EpochLifecycleError('INVALID_ORDER_COUNT');
  }
}

/** Pure, deterministic lifecycle transition with frozen matching parameters. */
export function transitionEpochLifecycleV1(
  snapshot: EpochLifecycleSnapshotV1,
  event: EpochLifecycleEventV1,
): EpochLifecycleSnapshotV1 {
  assertSnapshot(snapshot);
  if (event.configHash !== snapshot.parameters.configHash) throw new EpochLifecycleError('CONFIG_HASH_MISMATCH');
  if (snapshot.state === 'FINALIZED' || snapshot.state === 'INVALIDATED') throw new EpochLifecycleError('TERMINAL_EPOCH');

  const next = ({
    OPEN: event.type === 'CLOSE' ? 'CLOSED' : event.type === 'INVALIDATE' ? 'INVALIDATED' : undefined,
    CLOSED: event.type === 'START_PROVING' ? 'PROVING' : event.type === 'RECOMPUTE' ? 'RECOMPUTE' : event.type === 'INVALIDATE' ? 'INVALIDATED' : undefined,
    PROVING: event.type === 'PROOF_VERIFIED' ? 'PENDING_FIRMUP' : event.type === 'RECOMPUTE' ? 'RECOMPUTE' : event.type === 'INVALIDATE' ? 'INVALIDATED' : undefined,
    PENDING_FIRMUP: event.type === 'START_SETTLEMENT' ? 'SETTLING' : event.type === 'RECOMPUTE' ? 'RECOMPUTE' : event.type === 'INVALIDATE' ? 'INVALIDATED' : undefined,
    SETTLING: event.type === 'FINALIZE' ? 'FINALIZED' : event.type === 'RECOMPUTE' ? 'RECOMPUTE' : event.type === 'INVALIDATE' ? 'INVALIDATED' : undefined,
    RECOMPUTE: event.type === 'START_PROVING' ? 'PROVING' : event.type === 'INVALIDATE' ? 'INVALIDATED' : undefined,
    FINALIZED: undefined,
    INVALIDATED: undefined,
  } as Record<EpochLifecycleStateV1, EpochLifecycleStateV1 | undefined>)[snapshot.state];
  if (next === undefined) throw new EpochLifecycleError('INVALID_TRANSITION');
  return { ...snapshot, state: next };
}
