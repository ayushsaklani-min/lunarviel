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
} from '../contracts/managed/fair-clearing-n4/contract/index.js';

const bytes = value => new Uint8Array(32).fill(value);
const marketId = bytes(0x11);
const ruleVersionHash = bytes(0x22);
const configHash = bytes(0x33);
const contractAddress = dummyContractAddress();
const contract = new Contract({});

function contextFor(state, coinKeyByte = 0xa1) {
  return createCircuitContext(
    contractAddress,
    { bytes: bytes(coinKeyByte) },
    state,
    {},
  );
}

function order(nonceByte, side, quantityLots, limitPriceTicks) {
  return {
    version: 1n,
    marketId,
    epochSequence: 7n,
    ownerPublicKey: bytes(0x80 + nonceByte),
    side,
    orderType: 0n,
    quantityLots,
    limitPriceTicks,
    minFillLots: 0n,
    tif: 0n,
    allowPartial: true,
    nonce: bytes(nonceByte),
    createdAtMs: 1_800_000_000_000n,
    expiresAtMs: 1_800_000_060_000n,
  };
}

function dummySlot() {
  return {
    isDummy: true,
    order: {
      version: 0n,
      marketId: bytes(0),
      epochSequence: 0n,
      ownerPublicKey: bytes(0),
      side: false,
      orderType: 0n,
      quantityLots: 0n,
      limitPriceTicks: 0n,
      minFillLots: 0n,
      tif: 0n,
      allowPartial: false,
      nonce: bytes(0),
      createdAtMs: 0n,
      expiresAtMs: 0n,
    },
    blinding: bytes(0),
    path: {
      leaf: bytes(0),
      path: [
        { sibling: { field: 0n }, goes_left: false },
        { sibling: { field: 0n }, goes_left: false },
      ],
    },
  };
}

function closedFixture(orders) {
  let state = contract.initialState(
    createConstructorContext({}, { bytes: bytes(0x90) }),
    7n,
    marketId,
    ruleVersionHash,
    configHash,
  ).currentContractState;
  const openings = orders.map((value, index) => ({
    order: value,
    blinding: bytes(0x40 + index),
  }));
  const commitments = openings.map(({ order: value, blinding }) =>
    pureCircuits.deriveOrderCommitment(value, blinding));

  for (let index = 0; index < commitments.length; index++) {
    state = contract.circuits.submitOrderCommitment(
      contextFor(state, 0xa0 + index),
      7n,
      commitments[index],
      bytes(index + 1),
    ).context.currentQueryContext.state;
  }
  const currentRoot = ledger(state).orderCommitments.root();
  state = contract.circuits.closeEpoch(
    contextFor(state),
    7n,
    currentRoot,
    bytes(0x20),
  ).context.currentQueryContext.state;
  const closedLedger = ledger(state);
  const slots = openings.map(({ order: value, blinding }, index) => ({
    isDummy: false,
    order: value,
    blinding,
    path: closedLedger.orderCommitments.pathForLeaf(BigInt(index), commitments[index]),
  }));
  while (slots.length < 4) slots.push(dummySlot());
  return { state, slots, commitments, root: closedLedger.closedRoot };
}

function solution(root, clearingPriceTicks, totalVolumeLots, fills) {
  return {
    version: 1n,
    marketId,
    epochSequence: 7n,
    ruleVersionHash,
    configHash,
    inputRoot: root.field,
    clearingPriceTicks,
    totalVolumeLots,
    fills,
  };
}

function prove(fixture, fairSolution, proRata, requestByte = 0x30) {
  return contract.circuits.proveFairSolution(
    contextFor(fixture.state),
    fixture.slots,
    fairSolution,
    proRata,
    bytes(0x55),
    bytes(requestByte),
  );
}

// Four real leaves. At the optimal lower candidate price, the two equal-price buys
// split five lots pro-rata (3/2); equal remainders use commitment byte order.
const proRataFixture = closedFixture([
  order(1, false, 3n, 100n),
  order(2, false, 3n, 100n),
  order(3, true, 2n, 90n),
  order(4, true, 3n, 90n),
]);
const firstBuyWins = Buffer.compare(
  proRataFixture.commitments[0],
  proRataFixture.commitments[1],
) < 0;
const correctFills = firstBuyWins ? [3n, 2n, 2n, 3n] : [2n, 3n, 2n, 3n];
const fair = solution(proRataFixture.root, 90n, 5n, correctFills);
const division = {
  bases: [2n, 2n, 0n, 0n],
  remainders: [3n, 3n, 0n, 0n],
};

assert.throws(
  () => prove(proRataFixture, { ...fair, clearingPriceTicks: 100n }, division, 0x31),
  /clearing price is not optimal/,
);
assert.throws(
  () => prove(proRataFixture, { ...fair, fills: [3n, 3n, 2n, 3n] }, division, 0x32),
  /incorrect marginal pro-rata fill|conserve volume/,
);
assert.throws(
  () => prove(proRataFixture, {
    ...fair,
    fills: firstBuyWins ? [2n, 3n, 2n, 3n] : [3n, 2n, 2n, 3n],
  }, division, 0x33),
  /incorrect marginal pro-rata fill/,
);
assert.throws(
  () => prove(proRataFixture, { ...fair, inputRoot: fair.inputRoot + 1n }, division, 0x34),
  /solution root mismatch/,
);
const omittedSlots = [...proRataFixture.slots];
omittedSlots[1] = dummySlot();
assert.throws(
  () => prove({ ...proRataFixture, slots: omittedSlots }, fair, division, 0x35),
  /slot padding does not match frozen count/,
);
assert.throws(
  () => prove(proRataFixture, fair, {
    bases: [2n, 1n, 0n, 0n],
    remainders: [3n, 3n, 0n, 0n],
  }, 0x36),
  /invalid pro-rata quotient or remainder/,
);

const accepted = prove(proRataFixture, fair, division, 0x37);
const acceptedLedger = ledger(accepted.context.currentQueryContext.state);
assert.equal(acceptedLedger.fairSolutionSubmitted, true);
assert.deepEqual(acceptedLedger.fairSolutionCommitment, accepted.result);
assert.deepEqual(
  accepted.result,
  pureCircuits.deriveFairSolutionCommitment(fair, bytes(0x55)),
);
assert.throws(
  () => contract.circuits.proveFairSolution(
    contextFor(accepted.context.currentQueryContext.state),
    proRataFixture.slots,
    fair,
    division,
    bytes(0x55),
    bytes(0x37),
  ),
  /fair solution is already submitted/,
);

// A partial tree proves canonical dummy padding and zero-trade handling.
const paddedFixture = closedFixture([
  order(5, false, 4n, 100n),
  order(6, false, 2n, 90n),
]);
const noTrade = solution(paddedFixture.root, 0n, 0n, [0n, 0n, 0n, 0n]);
const noDivision = { bases: [0n, 0n, 0n, 0n], remainders: [0n, 0n, 0n, 0n] };
const paddedAccepted = prove(paddedFixture, noTrade, noDivision, 0x38);
assert.equal(ledger(paddedAccepted.context.currentQueryContext.state).fairSolutionSubmitted, true);

// Better-priced liquidity must be exhausted before a marginal worse-price order.
const priorityFixture = closedFixture([
  order(7, false, 4n, 110n),
  order(8, false, 4n, 100n),
  order(9, true, 5n, 90n),
  order(10, true, 2n, 100n),
]);
const prioritySolution = solution(priorityFixture.root, 100n, 7n, [4n, 3n, 5n, 2n]);
const priorityDivision = {
  bases: [0n, 3n, 0n, 0n],
  remainders: [0n, 0n, 0n, 0n],
};
assert.throws(
  () => prove(
    priorityFixture,
    { ...prioritySolution, fills: [3n, 4n, 5n, 2n] },
    priorityDivision,
    0x39,
  ),
  /fill violates price priority or eligibility|incorrect marginal pro-rata fill/,
);
prove(priorityFixture, prioritySolution, priorityDivision, 0x3a);

// Cancellation state cannot be linked from an order opening without the owner secret,
// so this M3a circuit deliberately rejects every snapshot containing a cancellation.
const ownerSecret = bytes(0x77);
const cancellableOrder = {
  ...order(11, false, 4n, 100n),
  ownerPublicKey: pureCircuits.deriveOwnerAuthorization(ownerSecret),
};
const cancelledFixture = closedFixture([cancellableOrder]);
const cancelled = contract.circuits.cancelOrder(
  contextFor(cancelledFixture.state),
  cancellableOrder,
  cancelledFixture.slots[0].blinding,
  cancelledFixture.slots[0].path,
  0n,
  ownerSecret,
  bytes(0x70),
);
const cancelledState = cancelled.context.currentQueryContext.state;
assert.throws(
  () => prove(
    { ...cancelledFixture, state: cancelledState },
    solution(cancelledFixture.root, 0n, 0n, [0n, 0n, 0n, 0n]),
    noDivision,
    0x3b,
  ),
  /M3a fails closed when cancellations exist/,
);

console.log('M3a N=4 completeness, optimal price, exact pro-rata, padding, and malicious-solution rejection: verified');
