/**
 * The public read surface of the Lunarveil API, mirroring
 * `openapi/lunarveil.openapi.yaml`.
 *
 * Integer market values stay `string` on purpose. They are atomic integer
 * quantities transported as canonical decimal strings; parsing them to
 * `number` in a browser would reintroduce exactly the floating-point error the
 * protocol rules forbid. Convert with `BigInt` at the point of use, never
 * with `Number`.
 *
 * Nothing here is private data: markets, epochs and dependency states are all
 * public catalog information.
 */

export type MarketStatusV1 = 'ACTIVE' | 'ADMISSION_PAUSED' | 'SETTLEMENT_ONLY' | 'DISABLED';

export const MARKET_STATUSES_V1: readonly MarketStatusV1[] = [
  'ACTIVE', 'ADMISSION_PAUSED', 'SETTLEMENT_ONLY', 'DISABLED',
];

export interface MarketV1 {
  readonly id: string;
  readonly marketKey: string;
  readonly baseAssetId: string;
  readonly quoteAssetId: string;
  /** Canonical decimal string. */
  readonly tickSizeAtomic: string;
  /** Canonical decimal string. */
  readonly lotSizeAtomic: string;
  readonly epochDurationSeconds: number;
  readonly maxOrdersPerEpoch: number;
  readonly minBatchPrivacy: number;
  readonly matchingRuleVersion: string;
  readonly status: MarketStatusV1;
}

export type EpochStateV1 =
  | 'OPEN' | 'CLOSED' | 'PROVING' | 'PENDING_FIRMUP'
  | 'SETTLING' | 'FINALIZED' | 'RECOMPUTE' | 'INVALIDATED';

export const EPOCH_STATES_V1: readonly EpochStateV1[] = [
  'OPEN', 'CLOSED', 'PROVING', 'PENDING_FIRMUP', 'SETTLING', 'FINALIZED', 'RECOMPUTE', 'INVALIDATED',
];

export interface EpochV1 {
  readonly id: string;
  readonly marketId: string;
  /** Canonical decimal string. */
  readonly sequence: string;
  readonly state: EpochStateV1;
  readonly orderCount: number;
  readonly maxOrders: number;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly scheduledCloseAtMs: string;
  readonly ruleVersion: string;
  readonly configHash: string;
}

export type DependencyStateV1 = 'READY' | 'DEGRADED' | 'UNAVAILABLE' | 'PAUSED';

export const DEPENDENCY_STATES_V1: readonly DependencyStateV1[] = [
  'READY', 'DEGRADED', 'UNAVAILABLE', 'PAUSED',
];

export type DependencyComponentNameV1 = 'DATABASE' | 'MATCHER' | 'CHAIN_SOURCE' | 'PROVER' | 'KMS';

export const DEPENDENCY_COMPONENT_NAMES_V1: readonly DependencyComponentNameV1[] = [
  'DATABASE', 'MATCHER', 'CHAIN_SOURCE', 'PROVER', 'KMS',
];

export interface DependencyComponentV1 {
  readonly name: DependencyComponentNameV1;
  readonly state: DependencyStateV1;
}

export interface SystemStatusV1 {
  readonly state: DependencyStateV1;
  readonly components: readonly DependencyComponentV1[];
}

/** A challenge the wallet must sign. Public: it carries no secret. */
export interface SessionChallengeV1 {
  readonly id: string;
  readonly domain: string;
  readonly walletIdentity: string;
  readonly nonce: string;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly issuedAtMs: string;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly expiresAtMs: string;
}

/**
 * A bearer session. The token authenticates later requests, so it is a
 * credential: hold it in memory, never in `localStorage`, and never log it.
 */
export interface SessionV1 {
  readonly token: string;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly expiresAtMs: string;
  /**
   * The trader's pseudonym for this session, issued by the server because only
   * it can derive one. Absent when the deployment issues no tag.
   */
  readonly traderTagHash?: string;
}

/** Public metadata for the matcher's active envelope-encryption key. */
export interface MatcherKeyV1 {
  readonly version: 1;
  readonly keyId: string;
  readonly algorithm: string;
  readonly publicKey: string;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly activeFromMs: string;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly expiresAtMs: string;
}

export type OrderSubmissionStateV1 = 'PENDING_CHAIN' | 'ACCEPTED' | 'REJECTED';

export const ORDER_SUBMISSION_STATES_V1: readonly OrderSubmissionStateV1[] = [
  'PENDING_CHAIN', 'ACCEPTED', 'REJECTED',
];

export interface OrderSubmissionV1 {
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly state: OrderSubmissionStateV1;
  /** True when this exact request had already been accepted before. */
  readonly replayed: boolean;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly createdAtMs: string;
}

/** The public, already-encrypted envelope. It carries no order contents. */
export interface OrderEnvelopeWireV1 {
  readonly version: 1;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly traderTagHash: string;
  readonly encryptionKeyId: string;
  readonly algorithm: string;
  readonly ephemeralPublicKey: string;
  readonly salt: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export type TraderOrderStateV1 =
  | 'PENDING_CHAIN' | 'ACCEPTED' | 'RESERVED' | 'PARTIALLY_FILLED' | 'FILLED'
  | 'CANCEL_PENDING' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';

export const TRADER_ORDER_STATES_V1: readonly TraderOrderStateV1[] = [
  'PENDING_CHAIN', 'ACCEPTED', 'RESERVED', 'PARTIALLY_FILLED', 'FILLED',
  'CANCEL_PENDING', 'CANCELLED', 'EXPIRED', 'REJECTED',
];

/**
 * One of the trader's own orders, as workflow metadata.
 *
 * There is no side, price or quantity here and there never will be: those
 * live only inside the ciphertext the matcher decrypts.
 */
export interface TraderOrderV1 {
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  /** Public: this is the value that goes on chain. */
  readonly commitment: string;
  readonly state: TraderOrderStateV1;
  /** Canonical decimal string of milliseconds since the Unix epoch. */
  readonly createdAtMs: string;
  readonly acceptedAtMs?: string;
  readonly chainAdmissionTxId?: string;
  readonly leafIndex?: string;
}
