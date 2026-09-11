import assert from 'node:assert/strict';

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  pureCircuits,
} from '../contracts/managed/order-commitment/contract/index.js';

const bytes = (value) => new Uint8Array(32).fill(value);
const contractAddress = dummyContractAddress();
const contract = new Contract({});

function order(ownerSecret, nonceByte, side) {
  return {
    version: 1n,
    marketId: bytes(0x11),
    epochSequence: 7n,
    ownerPublicKey: pureCircuits.deriveOwnerAuthorization(ownerSecret),
    side,
    orderType: 0n,
    quantityLots: 125n,
    limitPriceTicks: 42_000n,
    minFillLots: 25n,
    tif: 0n,
    allowPartial: true,
    nonce: bytes(nonceByte),
    createdAtMs: 1_800_000_000_000n,
    expiresAtMs: 1_800_000_060_000n,
  };
}

function contextFor(state, coinKeyByte) {
  return createCircuitContext(
    contractAddress,
    { bytes: bytes(coinKeyByte) },
    state,
    {},
  );
}

const initial = contract.initialState(
  createConstructorContext({}, { bytes: bytes(0x90) }),
  7n,
);

const ownerSecretA = bytes(0xcc);
const ownerSecretB = bytes(0xdd);
const blindingA = bytes(0xaa);
const blindingB = bytes(0xbb);
const orderA = order(ownerSecretA, 0x31, false);
const orderB = order(ownerSecretB, 0x32, true);
const commitmentA = pureCircuits.deriveOrderCommitment(orderA, blindingA);
const commitmentB = pureCircuits.deriveOrderCommitment(orderB, blindingB);

const admissionA = contract.circuits.submitOrderCommitment(
  contextFor(initial.currentContractState, 0xa1),
  7n,
  commitmentA,
  bytes(0x01),
);
assert.equal(admissionA.result, 0n);

const admissionB = contract.circuits.submitOrderCommitment(
  contextFor(admissionA.context.currentQueryContext.state, 0xb1),
  7n,
  commitmentB,
  bytes(0x02),
);
assert.equal(admissionB.result, 1n);

const openLedger = ledger(admissionB.context.currentQueryContext.state);
assert.equal(openLedger.nextOrderIndex, 2n);
const currentRoot = openLedger.orderCommitments.root();

assert.throws(
  () => contract.circuits.submitOrderCommitment(
    contextFor(admissionB.context.currentQueryContext.state, 0xa1),
    7n,
    bytes(0x44),
    bytes(0x01),
  ),
  /admission request already used/,
);

const closed = contract.circuits.closeEpoch(
  contextFor(admissionB.context.currentQueryContext.state, 0xa1),
  7n,
  currentRoot,
  bytes(0x03),
);
const closedLedger = ledger(closed.context.currentQueryContext.state);
assert.equal(closedLedger.epochClosed, true);
assert.equal(closedLedger.closedStartIndex, 0n);
assert.equal(closedLedger.closedEndIndexExclusive, 2n);
assert.equal(closedLedger.closedOrderCount, 2n);
assert.deepEqual(closedLedger.closedRoot, currentRoot);

assert.throws(
  () => contract.circuits.submitOrderCommitment(
    contextFor(closed.context.currentQueryContext.state, 0xb1),
    7n,
    bytes(0x44),
    bytes(0x04),
  ),
  /epoch is closed/,
);

const pathA = closedLedger.orderCommitments.pathForLeaf(0n, commitmentA);
const wrongPath = {
  leaf: pathA.leaf,
  path: pathA.path.map((entry, index) => index === 0
    ? { ...entry, sibling: { field: entry.sibling.field + 1n } }
    : entry),
};

const cancellationContext = () => contextFor(closed.context.currentQueryContext.state, 0xa1);
assert.throws(
  () => contract.circuits.cancelOrder(
    cancellationContext(), orderA, bytes(0xab), pathA, 0n, ownerSecretA, bytes(0x05),
  ),
  /opening does not match path leaf/,
);
assert.throws(
  () => contract.circuits.cancelOrder(
    cancellationContext(), orderA, blindingA, wrongPath, 0n, ownerSecretA, bytes(0x06),
  ),
  /path does not match frozen root/,
);
assert.throws(
  () => contract.circuits.cancelOrder(
    cancellationContext(), orderA, blindingA, pathA, 1n, ownerSecretA, bytes(0x07),
  ),
  /Merkle path directions do not match leaf index/,
);
assert.throws(
  () => contract.circuits.cancelOrder(
    cancellationContext(), orderA, blindingA, pathA, 0n, ownerSecretB, bytes(0x08),
  ),
  /owner authorization failed/,
);

const cancelled = contract.circuits.cancelOrder(
  cancellationContext(), orderA, blindingA, pathA, 0n, ownerSecretA, bytes(0x09),
);
const expectedNullifier = pureCircuits.deriveOrderNullifier(commitmentA, ownerSecretA);
assert.deepEqual(cancelled.result, expectedNullifier);
assert.equal(
  ledger(cancelled.context.currentQueryContext.state).consumedOrderNullifiers.member(expectedNullifier),
  true,
);
assert.throws(
  () => contract.circuits.cancelOrder(
    contextFor(cancelled.context.currentQueryContext.state, 0xa1),
    orderA,
    blindingA,
    pathA,
    0n,
    ownerSecretA,
    bytes(0x0a),
  ),
  /order nullifier is already consumed/,
);

console.log('M2 two-caller admission, freeze, opening, cancellation, and failure paths: verified');
