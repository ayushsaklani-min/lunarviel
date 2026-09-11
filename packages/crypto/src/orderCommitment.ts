import {
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  persistentCommit,
  persistentHash,
  type Alignment,
  type CompactType,
  type Value,
} from "@midnight-ntwrk/compact-runtime";

import { assertBytes32, copyBytes } from "./bytes.js";
import {
  ORDER_COMMITMENT_DOMAIN_V1,
  ORDER_NULLIFIER_DOMAIN_V1,
  OWNER_AUTHORIZATION_DOMAIN_V1,
} from "./domains.js";

const UINT8_MAX = (1n << 8n) - 1n;
const UINT16_MAX = (1n << 16n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;

const bytes32Type = new CompactTypeBytes(32);
const uint8Type = new CompactTypeUnsignedInteger(UINT8_MAX, 1);
const uint16Type = new CompactTypeUnsignedInteger(UINT16_MAX, 2);
const uint64Type = new CompactTypeUnsignedInteger(UINT64_MAX, 8);
const uint128Type = new CompactTypeUnsignedInteger(UINT128_MAX, 16);

export type OrderSideV1 = "BUY" | "SELL";
export type OrderTypeV1 = "LIMIT";
export type TimeInForceV1 = "GFE" | "IOC" | "FOK";

export interface OrderIntentV1 {
  readonly version: 1;
  readonly marketId: Uint8Array;
  readonly epochSequence: bigint;
  readonly ownerPublicKey: Uint8Array;
  readonly side: OrderSideV1;
  readonly orderType: OrderTypeV1;
  readonly quantityLots: bigint;
  readonly limitPriceTicks: bigint;
  readonly minFillLots: bigint;
  readonly tif: TimeInForceV1;
  readonly allowPartial: boolean;
  readonly nonce: Uint8Array;
  readonly createdAtMs: bigint;
  readonly expiresAtMs: bigint;
}

interface CommitmentPreimageV1 {
  readonly domain: Uint8Array;
  readonly order: OrderIntentV1;
}

interface NullifierPreimageV1 {
  readonly domain: Uint8Array;
  readonly orderCommitment: Uint8Array;
}

interface OwnerAuthorizationPreimageV1 {
  readonly domain: Uint8Array;
  readonly ownerSecret: Uint8Array;
}

function concatAlignments(...alignments: Alignment[]): Alignment {
  return alignments.flat();
}

function concatValues(...values: Value[]): Value {
  return values.flat();
}

function sideToCompact(side: OrderSideV1): boolean {
  if (side === "BUY") return false;
  if (side === "SELL") return true;
  throw new TypeError("side must be BUY or SELL");
}

function sideFromCompact(side: boolean): OrderSideV1 {
  return side ? "SELL" : "BUY";
}

function orderTypeToCompact(orderType: OrderTypeV1): bigint {
  if (orderType !== "LIMIT") throw new TypeError("orderType must be LIMIT in V1");
  return 0n;
}

function tifToCompact(tif: TimeInForceV1): bigint {
  switch (tif) {
    case "GFE": return 0n;
    case "IOC": return 1n;
    case "FOK": return 2n;
    default: throw new TypeError("tif must be GFE, IOC, or FOK");
  }
}

function tifFromCompact(tif: bigint): TimeInForceV1 {
  if (tif === 0n) return "GFE";
  if (tif === 1n) return "IOC";
  if (tif === 2n) return "FOK";
  throw new TypeError("invalid V1 time-in-force code");
}

function assertUint(value: bigint, max: bigint, name: string): void {
  if (typeof value !== "bigint" || value < 0n || value > max) {
    throw new RangeError(`${name} must be an unsigned integer no greater than ${max}`);
  }
}

export function validateOrderIntentV1(order: OrderIntentV1): void {
  if (order.version !== 1) throw new TypeError("version must be 1");
  assertBytes32(order.marketId, "marketId");
  assertBytes32(order.ownerPublicKey, "ownerPublicKey");
  assertBytes32(order.nonce, "nonce");
  assertUint(order.epochSequence, UINT64_MAX, "epochSequence");
  assertUint(order.quantityLots, UINT128_MAX, "quantityLots");
  assertUint(order.limitPriceTicks, UINT128_MAX, "limitPriceTicks");
  assertUint(order.minFillLots, UINT128_MAX, "minFillLots");
  assertUint(order.createdAtMs, UINT64_MAX, "createdAtMs");
  assertUint(order.expiresAtMs, UINT64_MAX, "expiresAtMs");
  sideToCompact(order.side);
  orderTypeToCompact(order.orderType);
  tifToCompact(order.tif);

  if (order.quantityLots === 0n) throw new RangeError("quantityLots must be positive");
  if (order.limitPriceTicks === 0n) throw new RangeError("limitPriceTicks must be positive");
  if (order.minFillLots > order.quantityLots) {
    throw new RangeError("minFillLots cannot exceed quantityLots");
  }
  if (order.expiresAtMs <= order.createdAtMs) {
    throw new RangeError("expiresAtMs must be greater than createdAtMs");
  }
}

class OrderIntentV1CompactType implements CompactType<OrderIntentV1> {
  alignment(): Alignment {
    return concatAlignments(
      uint16Type.alignment(),
      bytes32Type.alignment(),
      uint64Type.alignment(),
      bytes32Type.alignment(),
      CompactTypeBoolean.alignment(),
      uint8Type.alignment(),
      uint128Type.alignment(),
      uint128Type.alignment(),
      uint128Type.alignment(),
      uint8Type.alignment(),
      CompactTypeBoolean.alignment(),
      bytes32Type.alignment(),
      uint64Type.alignment(),
      uint64Type.alignment(),
    );
  }

  toValue(order: OrderIntentV1): Value {
    validateOrderIntentV1(order);
    return concatValues(
      uint16Type.toValue(1n),
      bytes32Type.toValue(order.marketId),
      uint64Type.toValue(order.epochSequence),
      bytes32Type.toValue(order.ownerPublicKey),
      CompactTypeBoolean.toValue(sideToCompact(order.side)),
      uint8Type.toValue(orderTypeToCompact(order.orderType)),
      uint128Type.toValue(order.quantityLots),
      uint128Type.toValue(order.limitPriceTicks),
      uint128Type.toValue(order.minFillLots),
      uint8Type.toValue(tifToCompact(order.tif)),
      CompactTypeBoolean.toValue(order.allowPartial),
      bytes32Type.toValue(order.nonce),
      uint64Type.toValue(order.createdAtMs),
      uint64Type.toValue(order.expiresAtMs),
    );
  }

  fromValue(value: Value): OrderIntentV1 {
    const version = uint16Type.fromValue(value);
    if (version !== 1n) throw new TypeError("invalid OrderIntentV1 version");
    const marketId = bytes32Type.fromValue(value);
    const epochSequence = uint64Type.fromValue(value);
    const ownerPublicKey = bytes32Type.fromValue(value);
    const side = sideFromCompact(CompactTypeBoolean.fromValue(value));
    const orderType = uint8Type.fromValue(value);
    if (orderType !== 0n) throw new TypeError("invalid V1 order type code");
    const quantityLots = uint128Type.fromValue(value);
    const limitPriceTicks = uint128Type.fromValue(value);
    const minFillLots = uint128Type.fromValue(value);
    const tif = tifFromCompact(uint8Type.fromValue(value));
    const allowPartial = CompactTypeBoolean.fromValue(value);
    const nonce = bytes32Type.fromValue(value);
    const createdAtMs = uint64Type.fromValue(value);
    const expiresAtMs = uint64Type.fromValue(value);

    return {
      version: 1,
      marketId,
      epochSequence,
      ownerPublicKey,
      side,
      orderType: "LIMIT",
      quantityLots,
      limitPriceTicks,
      minFillLots,
      tif,
      allowPartial,
      nonce,
      createdAtMs,
      expiresAtMs,
    };
  }
}

const orderIntentV1Type = new OrderIntentV1CompactType();

const commitmentPreimageV1Type: CompactType<CommitmentPreimageV1> = {
  alignment: () => concatAlignments(bytes32Type.alignment(), orderIntentV1Type.alignment()),
  toValue: (value) => concatValues(
    bytes32Type.toValue(value.domain),
    orderIntentV1Type.toValue(value.order),
  ),
  fromValue: (value) => ({
    domain: bytes32Type.fromValue(value),
    order: orderIntentV1Type.fromValue(value),
  }),
};

const nullifierPreimageV1Type: CompactType<NullifierPreimageV1> = {
  alignment: () => concatAlignments(bytes32Type.alignment(), bytes32Type.alignment()),
  toValue: (value) => concatValues(
    bytes32Type.toValue(value.domain),
    bytes32Type.toValue(value.orderCommitment),
  ),
  fromValue: (value) => ({
    domain: bytes32Type.fromValue(value),
    orderCommitment: bytes32Type.fromValue(value),
  }),
};

const ownerAuthorizationPreimageV1Type: CompactType<OwnerAuthorizationPreimageV1> = {
  alignment: () => concatAlignments(bytes32Type.alignment(), bytes32Type.alignment()),
  toValue: (value) => concatValues(
    bytes32Type.toValue(value.domain),
    bytes32Type.toValue(value.ownerSecret),
  ),
  fromValue: (value) => ({
    domain: bytes32Type.fromValue(value),
    ownerSecret: bytes32Type.fromValue(value),
  }),
};

export function commitOrderIntentV1(order: OrderIntentV1, blinding: Uint8Array): Uint8Array {
  assertBytes32(blinding, "blinding");
  return persistentCommit(
    commitmentPreimageV1Type,
    { domain: ORDER_COMMITMENT_DOMAIN_V1, order },
    blinding,
  );
}

export function deriveOrderNullifierV1(
  orderCommitment: Uint8Array,
  nullifierSecret: Uint8Array,
): Uint8Array {
  assertBytes32(orderCommitment, "orderCommitment");
  assertBytes32(nullifierSecret, "nullifierSecret");
  return persistentCommit(
    nullifierPreimageV1Type,
    { domain: ORDER_NULLIFIER_DOMAIN_V1, orderCommitment },
    nullifierSecret,
  );
}

export function deriveOwnerAuthorizationV1(ownerSecret: Uint8Array): Uint8Array {
  assertBytes32(ownerSecret, "ownerSecret");
  return persistentHash(
    ownerAuthorizationPreimageV1Type,
    { domain: OWNER_AUTHORIZATION_DOMAIN_V1, ownerSecret },
  );
}

export function cloneOrderIntentV1(order: OrderIntentV1): OrderIntentV1 {
  return {
    ...order,
    marketId: copyBytes(order.marketId),
    ownerPublicKey: copyBytes(order.ownerPublicKey),
    nonce: copyBytes(order.nonce),
  };
}
