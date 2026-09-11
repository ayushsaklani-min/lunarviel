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
  type OrderIntentV1,
} from '../contracts/managed/order-commitment/contract/index.js';
import {
  admissionIsApplied,
  cancellationIsApplied,
  closeIsApplied,
} from '../src/m2-reconciliation';

const bytes = (value: number) => new Uint8Array(32).fill(value);
const contract = new Contract({});
const contractAddress = dummyContractAddress();
const contextFor = (state: Parameters<typeof createCircuitContext>[2]) => createCircuitContext(
  contractAddress,
  { bytes: bytes(0xa1) },
  state,
  {},
);
const ownerSecret = bytes(0xcc);
const blinding = bytes(0xaa);
const order: OrderIntentV1 = {
  version: 1n,
  marketId: bytes(0x11),
  epochSequence: 7n,
  ownerPublicKey: pureCircuits.deriveOwnerAuthorization(ownerSecret),
  side: false,
  orderType: 0n,
  quantityLots: 125n,
  limitPriceTicks: 42_000n,
  minFillLots: 25n,
  tif: 0n,
  allowPartial: true,
  nonce: bytes(0x31),
  createdAtMs: 1_800_000_000_000n,
  expiresAtMs: 1_800_000_060_000n,
};
const commitment = pureCircuits.deriveOrderCommitment(order, blinding);
const initial = contract.initialState(
  createConstructorContext({}, { bytes: bytes(0x90) }),
  7n,
);
const submitted = contract.circuits.submitOrderCommitment(
  contextFor(initial.currentContractState),
  7n,
  commitment,
  bytes(0x01),
);
const submittedLedger = ledger(submitted.context.currentQueryContext.state);

assert.equal(admissionIsApplied(submittedLedger, commitment), true);
assert.equal(admissionIsApplied(submittedLedger, bytes(0x44)), false);

const root = submittedLedger.orderCommitments.root();
const closeRequest = bytes(0x03);
const closed = contract.circuits.closeEpoch(
  contextFor(submitted.context.currentQueryContext.state),
  7n,
  root,
  closeRequest,
);
const closedLedger = ledger(closed.context.currentQueryContext.state);

assert.equal(closeIsApplied(closedLedger, root, closeRequest), true);
assert.equal(closeIsApplied(closedLedger, { field: root.field + 1n }, closeRequest), false);
assert.equal(closeIsApplied(closedLedger, root, bytes(0x04)), false);

const path = closedLedger.orderCommitments.pathForLeaf(0n, commitment);
const expectedNullifier = pureCircuits.deriveOrderNullifier(commitment, ownerSecret);
assert.equal(cancellationIsApplied(closedLedger, expectedNullifier), false);

const cancelled = contract.circuits.cancelOrder(
  contextFor(closed.context.currentQueryContext.state),
  order,
  blinding,
  path,
  0n,
  ownerSecret,
  bytes(0x05),
);
const cancelledLedger = ledger(cancelled.context.currentQueryContext.state);
assert.equal(cancellationIsApplied(cancelledLedger, expectedNullifier), true);
assert.equal(cancellationIsApplied(cancelledLedger, bytes(0x55)), false);

console.log('M2 admission, close, and cancellation reconciliation predicates: verified');
