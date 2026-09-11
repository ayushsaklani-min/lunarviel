import { createHash } from 'node:crypto';

import type {
  BatchSolutionPayloadV1,
  BatchSolutionV1,
  BatchSolutionWireV1,
  Fill,
  FillWireV1,
} from './types.js';

export const SOLUTION_HASH_DOMAIN = 'LUNARVEIL_BATCH_SOLUTION_V1\0';

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const textEncoder = new TextEncoder();

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function assertCanonicalIdentifier(value: string, error = 'INVALID_IDENTIFIER'): void {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value) || hasUnpairedSurrogate(value)) {
    throw new Error(error);
  }
}

/** Bytewise comparison of canonical UTF-8 identifier encodings. */
export function compareCanonicalBytes(a: string, b: string): number {
  assertCanonicalIdentifier(a);
  assertCanonicalIdentifier(b);
  const left = textEncoder.encode(a);
  const right = textEncoder.encode(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftByte = left[index]!;
    const rightByte = right[index]!;
    if (leftByte !== rightByte) return leftByte < rightByte ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

function canonicalFills(fills: readonly Fill[]): Fill[] {
  return fills
    .map(fill => ({ ...fill }))
    .sort((a, b) => compareCanonicalBytes(a.orderCommitment, b.orderCommitment));
}

function canonicalIdentifiers(values: readonly string[]): string[] {
  return [...values].sort(compareCanonicalBytes);
}

export function canonicalizeSolutionPayload(payload: BatchSolutionPayloadV1): BatchSolutionPayloadV1 {
  const canonical: BatchSolutionPayloadV1 = {
    version: 1,
    marketId: payload.marketId,
    epochId: payload.epochId,
    ruleVersion: payload.ruleVersion,
    clearingPriceTicks: payload.clearingPriceTicks,
    totalVolumeLots: payload.totalVolumeLots,
    fills: canonicalFills(payload.fills),
    activeOrderCommitments: canonicalIdentifiers(payload.activeOrderCommitments),
    removedConstraintViolations: canonicalIdentifiers(payload.removedConstraintViolations),
    inputRoot: payload.inputRoot,
    configHash: payload.configHash,
  };
  if (payload.referencePriceHash !== undefined) canonical.referencePriceHash = payload.referencePriceHash;
  return canonical;
}

function payloadToWire(payload: BatchSolutionPayloadV1): Omit<BatchSolutionWireV1, 'canonicalSolutionHash'> {
  const canonical = canonicalizeSolutionPayload(payload);
  const wire: Omit<BatchSolutionWireV1, 'canonicalSolutionHash'> = {
    version: 1,
    marketId: canonical.marketId,
    epochId: canonical.epochId,
    ruleVersion: canonical.ruleVersion,
    clearingPriceTicks: canonical.clearingPriceTicks.toString(10),
    totalVolumeLots: canonical.totalVolumeLots.toString(10),
    fills: canonical.fills.map(fill => ({
      orderCommitment: fill.orderCommitment,
      filledLots: fill.filledLots.toString(10),
    })),
    activeOrderCommitments: canonical.activeOrderCommitments,
    removedConstraintViolations: canonical.removedConstraintViolations,
    inputRoot: canonical.inputRoot,
    configHash: canonical.configHash,
  };
  if (canonical.referencePriceHash !== undefined) wire.referencePriceHash = canonical.referencePriceHash;
  return wire;
}

export function serializeCanonicalSolutionPayload(payload: BatchSolutionPayloadV1): string {
  return JSON.stringify(payloadToWire(payload));
}

export function computeCanonicalSolutionHash(payload: BatchSolutionPayloadV1): string {
  return createHash('sha256')
    .update(SOLUTION_HASH_DOMAIN, 'utf8')
    .update(serializeCanonicalSolutionPayload(payload), 'utf8')
    .digest('hex');
}

export function finalizeSolution(payload: BatchSolutionPayloadV1): BatchSolutionV1 {
  const canonical = canonicalizeSolutionPayload(payload);
  return { ...canonical, canonicalSolutionHash: computeCanonicalSolutionHash(canonical) };
}

export function toWireSolution(solution: BatchSolutionV1): BatchSolutionWireV1 {
  return { ...payloadToWire(solution), canonicalSolutionHash: solution.canonicalSolutionHash };
}

export function serializeBatchSolution(solution: BatchSolutionV1): string {
  return JSON.stringify(toWireSolution(solution));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`INVALID_${key.toUpperCase()}`);
  assertCanonicalIdentifier(value, `INVALID_${key.toUpperCase()}`);
  return value;
}

function parseDecimal(value: unknown, key: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) throw new Error(`INVALID_${key.toUpperCase()}`);
  return BigInt(value);
}

function parseStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  const parsed = [...value] as string[];
  if (new Set(parsed).size !== parsed.length) throw new Error(`DUPLICATE_${key.toUpperCase()}`);
  return parsed;
}

function parseFills(value: unknown): Fill[] {
  if (!Array.isArray(value)) throw new Error('INVALID_FILLS');
  const fills = value.map((item): Fill => {
    if (!isRecord(item)) throw new Error('INVALID_FILL');
    const allowed = new Set(['orderCommitment', 'filledLots']);
    if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('INVALID_FILL_FIELD');
    const fill = {
      orderCommitment: expectString(item, 'orderCommitment'),
      filledLots: parseDecimal(item.filledLots, 'filledLots'),
    };
    if (fill.filledLots === 0n) throw new Error('INVALID_FILLEDLOTS');
    return fill;
  });
  if (new Set(fills.map(fill => fill.orderCommitment)).size !== fills.length) {
    throw new Error('DUPLICATE_FILL_COMMITMENT');
  }
  return fills;
}

export function parseBatchSolution(serialized: string): BatchSolutionV1 {
  const value: unknown = JSON.parse(serialized);
  if (!isRecord(value)) throw new Error('INVALID_BATCH_SOLUTION');
  const allowed = new Set([
    'version', 'marketId', 'epochId', 'ruleVersion', 'clearingPriceTicks',
    'totalVolumeLots', 'fills', 'activeOrderCommitments',
    'removedConstraintViolations', 'inputRoot', 'configHash',
    'referencePriceHash', 'canonicalSolutionHash',
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('INVALID_SOLUTION_FIELD');
  if (value.version !== 1) throw new Error('INVALID_SOLUTION_VERSION');

  const payload: BatchSolutionPayloadV1 = {
    version: 1,
    marketId: expectString(value, 'marketId'),
    epochId: expectString(value, 'epochId'),
    ruleVersion: expectString(value, 'ruleVersion'),
    clearingPriceTicks: parseDecimal(value.clearingPriceTicks, 'clearingPriceTicks'),
    totalVolumeLots: parseDecimal(value.totalVolumeLots, 'totalVolumeLots'),
    fills: parseFills(value.fills),
    activeOrderCommitments: parseStringArray(value.activeOrderCommitments, 'activeOrderCommitments'),
    removedConstraintViolations: parseStringArray(value.removedConstraintViolations, 'removedConstraintViolations'),
    inputRoot: expectString(value, 'inputRoot'),
    configHash: expectString(value, 'configHash'),
  };
  if (value.referencePriceHash !== undefined) {
    if (typeof value.referencePriceHash !== 'string' || value.referencePriceHash.length === 0) {
      throw new Error('INVALID_REFERENCE_PRICE_HASH');
    }
    payload.referencePriceHash = value.referencePriceHash;
  }
  const active = new Set(payload.activeOrderCommitments);
  if (payload.removedConstraintViolations.some(commitment => active.has(commitment))) {
    throw new Error('ACTIVE_REMOVED_OVERLAP');
  }

  const canonicalSolutionHash = expectString(value, 'canonicalSolutionHash');
  if (!HASH_PATTERN.test(canonicalSolutionHash)) throw new Error('INVALID_SOLUTION_HASH');
  const solution = finalizeSolution(payload);
  if (solution.canonicalSolutionHash !== canonicalSolutionHash) throw new Error('SOLUTION_HASH_MISMATCH');
  return solution;
}

export function isValidBatchSolution(expected: BatchSolutionV1, candidate: BatchSolutionV1): boolean {
  if (!HASH_PATTERN.test(candidate.canonicalSolutionHash)) return false;
  if (computeCanonicalSolutionHash(candidate) !== candidate.canonicalSolutionHash) return false;
  return serializeBatchSolution(expected) === serializeBatchSolution(candidate);
}

export type { BatchSolutionWireV1, FillWireV1 };
