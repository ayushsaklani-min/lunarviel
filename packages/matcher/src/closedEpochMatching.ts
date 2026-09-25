import { createHash } from 'node:crypto';

import {
  bytes32FromHex,
  bytesToHex,
  commitOrderIntentV1,
  withOpenedOrderEnvelopeV1,
  type MatcherDecryptionKeyV1,
  type OrderEnvelopeV1,
  type OrderIntentV1,
} from '@lunarveil/crypto';
import { clearBatch, type BatchInputV1, type BatchSolutionV1, type MatchingOrderV1 } from '@lunarveil/matching-core';

const HEX_32 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UINT64_MAX = (1n << 64n) - 1n;

/**
 * The public, frozen data required before a matcher may decrypt an order.
 * `inputRoot` must come from a finalized contract read; it is deliberately
 * not reconstructed from database rows.
 */
export interface ClosedEpochMatchingContextV1 {
  readonly marketId: string;
  readonly epochId: string;
  readonly epochSequence: bigint;
  readonly ruleVersion: string;
  readonly configHash: string;
  readonly inputRoot: string;
  readonly closedAtMs: bigint;
  readonly orderCount: number;
  readonly maxOrders: number;
  readonly referencePriceTicks?: bigint;
  readonly referencePriceHash?: string;
  readonly maxPriceCollarBps?: bigint;
}

/** A ciphertext-only row plus its public, chain-derived leaf index. */
export interface FrozenEncryptedOrderV1 {
  readonly orderId: string;
  readonly leafIndex: bigint;
  readonly envelope: OrderEnvelopeV1;
}

export interface MatcherKeyResolverV1 {
  /** Resolves a non-extractable private key only for an already stored key id. */
  resolveExistingEnvelopeKey(keyId: string): Promise<MatcherDecryptionKeyV1>;
}

/** Private pre-admission input. Its decrypted opening never leaves this module. */
export interface M3AdmissionEnvelopeValidationV1 {
  readonly envelope: OrderEnvelopeV1;
  readonly marketId: string;
  readonly epochSequence: bigint;
  readonly nowMs: bigint;
  readonly key: MatcherDecryptionKeyV1;
}

/**
 * This object is intentionally private-process-only. Its `solution` and
 * `openings` contain sensitive order information and must be handed directly
 * to the proof coordinator; neither is safe to log, serialize, or return
 * from an API route.
 */
export interface PreparedClosedEpochBatchV1 {
  readonly solution: BatchSolutionV1;
  readonly openings: readonly PreparedOrderOpeningV1[];
  /** The exact deterministic matching input, for independent re-verification. Same sensitivity as `openings`. */
  readonly input: BatchInputV1;
}

export interface PreparedOrderOpeningV1 {
  readonly orderId: string;
  readonly leafIndex: bigint;
  readonly order: OrderIntentV1;
  readonly blinding: Uint8Array;
  readonly traderTagHash: string;
}

export class ClosedEpochMatchingError extends Error {
  constructor(readonly code:
    | 'INVALID_CONTEXT'
    | 'ORDER_SET_MISMATCH'
    | 'ORDER_ENVELOPE_INVALID'
    | 'ORDER_OPENING_INVALID'
    | 'M3_UNSUPPORTED_ORDER'
    | 'COMMITMENT_MISMATCH'
    | 'ORDER_EXPIRED_AT_CLOSE'
    | 'MATCHING_REJECTED') {
    super(code);
    this.name = 'ClosedEpochMatchingError';
  }
}

interface OpenedOrderPayloadV1 {
  readonly version: 1;
  readonly ownerPublicKey: string;
  readonly side: 'BUY' | 'SELL';
  readonly orderType: 'LIMIT';
  readonly quantityLots: string;
  readonly limitPriceTicks: string;
  readonly minFillLots: string;
  readonly tif: 'GFE' | 'IOC' | 'FOK';
  readonly allowPartial: boolean;
  readonly blinding: readonly number[];
  readonly nonce: readonly number[];
  readonly createdAtMs: string;
  readonly expiresAtMs: string;
}

function publicMarketId(marketId: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(marketId, 'utf8').digest());
}

function assertContext(input: ClosedEpochMatchingContextV1): void {
  if (!IDENTIFIER.test(input.marketId) || !IDENTIFIER.test(input.epochId)
    || !IDENTIFIER.test(input.ruleVersion) || !HEX_32.test(input.configHash)
    || !IDENTIFIER.test(input.inputRoot) || typeof input.epochSequence !== 'bigint' || input.epochSequence < 0n
    || typeof input.closedAtMs !== 'bigint' || input.closedAtMs < 0n
    || !Number.isSafeInteger(input.orderCount) || input.orderCount < 0
    || !Number.isSafeInteger(input.maxOrders) || input.maxOrders < 1 || input.orderCount > input.maxOrders
    || (input.referencePriceTicks !== undefined && input.referencePriceTicks <= 0n)
    || (input.referencePriceHash !== undefined && !HEX_32.test(input.referencePriceHash))
    || (input.referencePriceTicks === undefined) !== (input.referencePriceHash === undefined)
    || (input.maxPriceCollarBps !== undefined && (input.maxPriceCollarBps < 0n || input.referencePriceTicks === undefined))) {
    throw new ClosedEpochMatchingError('INVALID_CONTEXT');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  return value;
}

function exactBytes(record: Record<string, unknown>, key: string): Uint8Array {
  const value = record[key];
  if (!Array.isArray(value) || value.length !== 32 || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  }
  return Uint8Array.from(value);
}

function parsePayload(plaintext: Uint8Array, context: ClosedEpochMatchingContextV1): {
  readonly order: OrderIntentV1;
  readonly blinding: Uint8Array;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  }
  if (!isRecord(decoded) || decoded.version !== 1 || decoded.orderType !== 'LIMIT'
    || (decoded.side !== 'BUY' && decoded.side !== 'SELL')
    || (decoded.tif !== 'GFE' && decoded.tif !== 'IOC' && decoded.tif !== 'FOK')
    || typeof decoded.allowPartial !== 'boolean') {
    throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  }
  const payload = decoded as unknown as OpenedOrderPayloadV1;
  const ownerPublicKeyHex = text(decoded, 'ownerPublicKey');
  const quantityLots = text(decoded, 'quantityLots');
  const limitPriceTicks = text(decoded, 'limitPriceTicks');
  const minFillLots = text(decoded, 'minFillLots');
  const createdAtMs = text(decoded, 'createdAtMs');
  const expiresAtMs = text(decoded, 'expiresAtMs');
  if (!HEX_32.test(ownerPublicKeyHex) || !DECIMAL.test(quantityLots) || !DECIMAL.test(limitPriceTicks)
    || !DECIMAL.test(minFillLots) || !DECIMAL.test(createdAtMs) || !DECIMAL.test(expiresAtMs)) {
    throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  }

  const blinding = exactBytes(decoded, 'blinding');
  let nonce: Uint8Array | undefined;
  let ownerPublicKey: Uint8Array | undefined;
  try {
    nonce = exactBytes(decoded, 'nonce');
    ownerPublicKey = bytes32FromHex(ownerPublicKeyHex, 'ownerPublicKey');
    const order: OrderIntentV1 = {
      version: 1,
      marketId: publicMarketId(context.marketId),
      epochSequence: context.epochSequence,
      ownerPublicKey,
      side: payload.side,
      orderType: 'LIMIT',
      quantityLots: BigInt(quantityLots),
      limitPriceTicks: BigInt(limitPriceTicks),
      minFillLots: BigInt(minFillLots),
      tif: payload.tif,
      allowPartial: payload.allowPartial,
      nonce,
      createdAtMs: BigInt(createdAtMs),
      expiresAtMs: BigInt(expiresAtMs),
    };
    // Keep this exactly aligned with the M3b Compact `validateSlot` domain.
    // This happens only in matcher memory; raw order fields never leave it.
    if (order.quantityLots > UINT64_MAX || order.limitPriceTicks > UINT64_MAX
      || order.minFillLots !== 0n || order.tif !== 'GFE' || !order.allowPartial) {
      throw new ClosedEpochMatchingError('M3_UNSUPPORTED_ORDER');
    }
    if (order.expiresAtMs <= context.closedAtMs) throw new ClosedEpochMatchingError('ORDER_EXPIRED_AT_CLOSE');
    return { order, blinding };
  } catch (error) {
    blinding.fill(0);
    nonce?.fill(0);
    ownerPublicKey?.fill(0);
    if (error instanceof ClosedEpochMatchingError) throw error;
    throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  }
}

function asMatchingOrder(opening: PreparedOrderOpeningV1, context: ClosedEpochMatchingContextV1): MatchingOrderV1 {
  const order = opening.order;
  const commitmentBytes = commitOrderIntentV1(order, opening.blinding);
  let commitment: string;
  try {
    commitment = bytesToHex(commitmentBytes);
  } finally {
    commitmentBytes.fill(0);
  }
  return {
    version: 1,
    commitment,
    marketId: context.marketId,
    epochId: context.epochId,
    traderTag: opening.traderTagHash,
    side: order.side,
    orderType: order.orderType,
    quantityLots: order.quantityLots,
    limitPriceTicks: order.limitPriceTicks,
    minFillLots: order.minFillLots,
    tif: order.tif,
    allowPartial: order.allowPartial,
    active: true,
  };
}

function assertFrozenSet(context: ClosedEpochMatchingContextV1, rows: readonly FrozenEncryptedOrderV1[]): void {
  if (rows.length !== context.orderCount) throw new ClosedEpochMatchingError('ORDER_SET_MISMATCH');
  const indexes = new Set<bigint>();
  const commitments = new Set<string>();
  for (const row of rows) {
    if (!IDENTIFIER.test(row.orderId) || typeof row.leafIndex !== 'bigint' || row.leafIndex < 0n
      || row.leafIndex >= BigInt(context.orderCount) || !UUID.test(row.envelope.clientRequestId)
      || row.envelope.marketId !== context.marketId || row.envelope.epochId !== context.epochId
      || !HEX_32.test(row.envelope.commitment) || !HEX_32.test(row.envelope.traderTagHash)) {
      throw new ClosedEpochMatchingError('ORDER_ENVELOPE_INVALID');
    }
    if (indexes.has(row.leafIndex) || commitments.has(row.envelope.commitment)) {
      throw new ClosedEpochMatchingError('ORDER_SET_MISMATCH');
    }
    indexes.add(row.leafIndex);
    commitments.add(row.envelope.commitment);
  }
  for (let index = 0n; index < BigInt(context.orderCount); index += 1n) {
    if (!indexes.has(index)) throw new ClosedEpochMatchingError('ORDER_SET_MISMATCH');
  }
}

/**
 * Validates one still-private order before it is eligible for a public chain
 * admission. Only a success/failure result escapes; the opening is scrubbed.
 */
export async function validateM3AdmissionEnvelopeV1(input: M3AdmissionEnvelopeValidationV1): Promise<void> {
  const context: ClosedEpochMatchingContextV1 = {
    marketId: input.marketId,
    epochId: 'admission-validation',
    epochSequence: input.epochSequence,
    ruleVersion: 'm3b-validation',
    configHash: '00'.repeat(32),
    inputRoot: 'admission-root',
    closedAtMs: input.nowMs,
    orderCount: 1,
    maxOrders: 4,
  };
  assertContext(context);
  let opening: { order: OrderIntentV1; blinding: Uint8Array } | undefined;
  try {
    opening = await withOpenedOrderEnvelopeV1(input.envelope, input.key, plaintext => parsePayload(plaintext, context));
    const commitment = commitOrderIntentV1(opening.order, opening.blinding);
    try {
      if (bytesToHex(commitment) !== input.envelope.commitment) {
        throw new ClosedEpochMatchingError('COMMITMENT_MISMATCH');
      }
    } finally {
      commitment.fill(0);
    }
  } finally {
    opening?.blinding.fill(0);
    opening?.order.marketId.fill(0);
    opening?.order.ownerPublicKey.fill(0);
    opening?.order.nonce.fill(0);
  }
}

/**
 * Decrypts a frozen epoch only in matcher memory and produces the exact
 * deterministic solution that a proof coordinator must prove. Any malformed
 * ciphertext, opening, key, commitment, expiry, or frozen-set discrepancy is
 * rejected before `clearBatch` runs.
 */
export async function prepareClosedEpochBatchV1(
  context: ClosedEpochMatchingContextV1,
  encryptedOrders: readonly FrozenEncryptedOrderV1[],
  keys: MatcherKeyResolverV1,
): Promise<PreparedClosedEpochBatchV1> {
  assertContext(context);
  assertFrozenSet(context, encryptedOrders);
  const openings: PreparedOrderOpeningV1[] = [];
  try {
    for (const row of [...encryptedOrders].sort((left, right) => left.leafIndex < right.leafIndex ? -1 : 1)) {
      const key = await keys.resolveExistingEnvelopeKey(row.envelope.encryptionKeyId);
      const opening = await withOpenedOrderEnvelopeV1(row.envelope, key, plaintext => parsePayload(plaintext, context));
      const commitmentBytes = commitOrderIntentV1(opening.order, opening.blinding);
      let committed: string;
      try {
        committed = bytesToHex(commitmentBytes);
      } finally {
        commitmentBytes.fill(0);
      }
      if (committed !== row.envelope.commitment) {
        opening.blinding.fill(0);
        throw new ClosedEpochMatchingError('COMMITMENT_MISMATCH');
      }
      openings.push({ orderId: row.orderId, leafIndex: row.leafIndex, order: opening.order, blinding: opening.blinding, traderTagHash: row.envelope.traderTagHash });
    }
    try {
      const input: BatchInputV1 = {
        version: 1,
        marketId: context.marketId,
        epochId: context.epochId,
        ruleVersion: context.ruleVersion,
        inputRoot: context.inputRoot,
        configHash: context.configHash,
        orders: openings.map(opening => asMatchingOrder(opening, context)),
        ...(context.referencePriceTicks === undefined ? {} : {
          referencePriceTicks: context.referencePriceTicks,
          referencePriceHash: context.referencePriceHash!,
        }),
        ...(context.maxPriceCollarBps === undefined ? {} : { maxPriceCollarBps: context.maxPriceCollarBps }),
      };
      const solution = clearBatch(input);
      return { solution, openings, input };
    } catch {
      throw new ClosedEpochMatchingError('MATCHING_REJECTED');
    }
  } catch (error) {
    for (const opening of openings) {
      opening.blinding.fill(0);
      opening.order.marketId.fill(0);
      opening.order.ownerPublicKey.fill(0);
      opening.order.nonce.fill(0);
    }
    if (error instanceof ClosedEpochMatchingError) throw error;
    throw new ClosedEpochMatchingError('ORDER_OPENING_INVALID');
  }
}
