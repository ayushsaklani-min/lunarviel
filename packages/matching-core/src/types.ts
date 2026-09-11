export type Side = 'BUY' | 'SELL';
export type TimeInForce = 'GFE' | 'IOC' | 'FOK';

/** Private-order fields required by matching. Keys, nonce, and blinding stay outside this API. */
export interface MatchingOrderV1 {
  version: 1;
  commitment: string;
  marketId: string;
  epochId: string;
  traderTag: string;
  side: Side;
  orderType: 'LIMIT';
  quantityLots: bigint;
  limitPriceTicks: bigint;
  minFillLots: bigint;
  tif: TimeInForce;
  allowPartial: boolean;
  active: boolean;
}

export interface BatchInputV1 {
  version: 1;
  marketId: string;
  epochId: string;
  ruleVersion: string;
  inputRoot: string;
  configHash: string;
  orders: readonly MatchingOrderV1[];
  referencePriceTicks?: bigint;
  referencePriceHash?: string;
  maxPriceCollarBps?: bigint;
}

export interface Fill {
  orderCommitment: string;
  filledLots: bigint;
}

export interface BatchSolutionPayloadV1 {
  version: 1;
  marketId: string;
  epochId: string;
  ruleVersion: string;
  clearingPriceTicks: bigint;
  totalVolumeLots: bigint;
  fills: Fill[];
  activeOrderCommitments: string[];
  removedConstraintViolations: string[];
  inputRoot: string;
  configHash: string;
  referencePriceHash?: string;
}

export interface BatchSolutionV1 extends BatchSolutionPayloadV1 {
  canonicalSolutionHash: string;
}

export interface FillWireV1 {
  orderCommitment: string;
  filledLots: string;
}

export interface BatchSolutionWireV1 {
  version: 1;
  marketId: string;
  epochId: string;
  ruleVersion: string;
  clearingPriceTicks: string;
  totalVolumeLots: string;
  fills: FillWireV1[];
  activeOrderCommitments: string[];
  removedConstraintViolations: string[];
  inputRoot: string;
  configHash: string;
  referencePriceHash?: string;
  canonicalSolutionHash: string;
}

export type Order = MatchingOrderV1;
export type ClearResult = BatchSolutionV1;
