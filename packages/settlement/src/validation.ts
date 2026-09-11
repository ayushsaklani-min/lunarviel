import type { DesiredInput, DesiredOutput } from '@midnight-ntwrk/dapp-connector-api';

import { SettlementError } from './errors.js';
import type { PrivatePairwiseAllocationV1 } from './types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RAW_TOKEN_TYPE = /^[0-9a-f]{64}$/;
const MAX_AMOUNT = (1n << 128n) - 1n;

function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) throw new SettlementError('INVALID_ALLOCATION');
}

function assertAmount(value: bigint): void {
  if (value <= 0n || value > MAX_AMOUNT) throw new SettlementError('INVALID_ALLOCATION');
}

function assertTokenType(value: string): void {
  if (!RAW_TOKEN_TYPE.test(value)) throw new SettlementError('INVALID_ALLOCATION');
}

function assertInput(input: DesiredInput): void {
  if (input.kind !== 'shielded' && input.kind !== 'unshielded') {
    throw new SettlementError('INVALID_ALLOCATION');
  }
  assertTokenType(input.type);
  assertAmount(input.value);
}

function assertOutput(output: DesiredOutput): void {
  if (output.kind !== 'shielded' && output.kind !== 'unshielded') {
    throw new SettlementError('INVALID_ALLOCATION');
  }
  assertTokenType(output.type);
  assertAmount(output.value);
  if (output.recipient.length < 16 || output.recipient.length > 256 || /\s/.test(output.recipient)) {
    throw new SettlementError('INVALID_ALLOCATION');
  }
}

export function assertPairwiseAllocation(allocation: PrivatePairwiseAllocationV1): void {
  if (allocation.version !== 1) throw new SettlementError('INVALID_ALLOCATION');
  assertIdentifier(allocation.sessionId);
  assertIdentifier(allocation.networkId);
  assertInput(allocation.initiatorInput);
  assertOutput(allocation.initiatorOutput);
  if (allocation.initiatorInput.type === allocation.initiatorOutput.type) {
    throw new SettlementError('INVALID_ALLOCATION');
  }
}

export function assertRequestId(value: string): void {
  if (!IDENTIFIER.test(value)) throw new SettlementError('IDEMPOTENCY_CONFLICT');
}
