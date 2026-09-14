import assert from 'node:assert/strict';

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
} from '../contracts/managed/fair-clearing-n4-m3b/contract/index.js';

const bytes = value => new Uint8Array(32).fill(value);
const marketId = bytes(0x11);
const ruleVersionHash = bytes(0x22);
const configHash = bytes(0x33);
const epochCloseAt = 1_800_000_000;
const contractAddress = dummyContractAddress();
const contract = new Contract({});

function contextFor(state, time, coinKeyByte = 0xa1) {
  return createCircuitContext(
    contractAddress,
    { bytes: bytes(coinKeyByte) },
    state,
    {},
    undefined,
    undefined,
    time,
  );
}

const initial = contract.initialState(
  createConstructorContext({}, { bytes: bytes(0x90) }),
  7n,
  marketId,
  ruleVersionHash,
  configHash,
  BigInt(epochCloseAt),
).currentContractState;

const commitment = bytes(0x44);
const admitted = contract.circuits.submitOrderCommitment(
  contextFor(initial, epochCloseAt - 1),
  7n,
  commitment,
  bytes(0x01),
);
const admittedState = admitted.context.currentQueryContext.state;
const currentRoot = ledger(admittedState).orderCommitments.root();

assert.throws(
  () => contract.circuits.closeEpoch(
    contextFor(admittedState, epochCloseAt - 1),
    7n,
    currentRoot,
    bytes(0x02),
  ),
  /epoch close time has not been reached/,
);

assert.throws(
  () => contract.circuits.submitOrderCommitment(
    contextFor(admittedState, epochCloseAt),
    7n,
    bytes(0x45),
    bytes(0x03),
  ),
  /epoch admission time has ended/,
);

const closed = contract.circuits.closeEpoch(
  contextFor(admittedState, epochCloseAt),
  7n,
  currentRoot,
  bytes(0x04),
);
const closedLedger = ledger(closed.context.currentQueryContext.state);
assert.equal(closedLedger.epochClosed, true);
assert.equal(closedLedger.closedOrderCount, 1n);
assert.equal(closedLedger.epochCloseAt, BigInt(epochCloseAt));

const closedAfterDeadline = contract.circuits.closeEpoch(
  contextFor(admittedState, epochCloseAt + 1),
  7n,
  currentRoot,
  bytes(0x05),
);
assert.equal(ledger(closedAfterDeadline.context.currentQueryContext.state).epochClosed, true);

console.log('M3b deterministic epoch boundary: premature close and post-deadline admission rejected');
