import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  proofDataIntoSerializedPreimage,
} from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  Contract,
  ledger,
  pureCircuits,
} from '../contracts/managed/fair-clearing-n4/contract/index.js';

const PROOF_SERVER_URL = process.env.LUNARVEIL_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';
const requestedRuns = Number.parseInt(process.env.LUNARVEIL_M3_PROOF_RUNS ?? '5', 10);
if (!Number.isSafeInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 20) {
  throw new Error('LUNARVEIL_M3_PROOF_RUNS must be an integer from 1 through 20');
}

const zkConfigDirectory = fileURLToPath(new URL('../contracts/managed/fair-clearing-n4', import.meta.url));
const bytes = value => new Uint8Array(32).fill(value);
const marketId = bytes(0x11);
const ruleVersionHash = bytes(0x22);
const configHash = bytes(0x33);
const contractAddress = dummyContractAddress();
const contract = new Contract({});

function contextFor(state, coinKeyByte = 0xa1) {
  return createCircuitContext(contractAddress, { bytes: bytes(coinKeyByte) }, state, {});
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

function fairnessCircuitResult() {
  const orders = [
    order(1, false, 3n, 100n),
    order(2, false, 3n, 100n),
    order(3, true, 2n, 90n),
    order(4, true, 3n, 90n),
  ];
  const blindings = [bytes(0x40), bytes(0x41), bytes(0x42), bytes(0x43)];
  const commitments = orders.map((value, index) =>
    pureCircuits.deriveOrderCommitment(value, blindings[index]));
  let state = contract.initialState(
    createConstructorContext({}, { bytes: bytes(0x90) }),
    7n,
    marketId,
    ruleVersionHash,
    configHash,
  ).currentContractState;

  for (let index = 0; index < commitments.length; index++) {
    state = contract.circuits.submitOrderCommitment(
      contextFor(state, 0xa0 + index),
      7n,
      commitments[index],
      bytes(index + 1),
    ).context.currentQueryContext.state;
  }
  const root = ledger(state).orderCommitments.root();
  state = contract.circuits.closeEpoch(
    contextFor(state),
    7n,
    root,
    bytes(0x20),
  ).context.currentQueryContext.state;
  const closedLedger = ledger(state);
  const slots = orders.map((value, index) => ({
    isDummy: false,
    order: value,
    blinding: blindings[index],
    path: closedLedger.orderCommitments.pathForLeaf(BigInt(index), commitments[index]),
  }));
  const firstBuyWins = Buffer.compare(commitments[0], commitments[1]) < 0;
  const solution = {
    version: 1n,
    marketId,
    epochSequence: 7n,
    ruleVersionHash,
    configHash,
    inputRoot: closedLedger.closedRoot.field,
    clearingPriceTicks: 90n,
    totalVolumeLots: 5n,
    fills: firstBuyWins ? [3n, 2n, 2n, 3n] : [2n, 3n, 2n, 3n],
  };
  return contract.circuits.proveFairSolution(
    contextFor(state),
    slots,
    solution,
    { bases: [2n, 2n, 0n, 0n], remainders: [3n, 3n, 0n, 0n] },
    bytes(0x55),
    bytes(0x30),
  );
}

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

const circuitId = 'proveFairSolution';
const circuitResult = fairnessCircuitResult();
const preimage = proofDataIntoSerializedPreimage(
  circuitResult.proofData.input,
  circuitResult.proofData.output,
  circuitResult.proofData.publicTranscript,
  circuitResult.proofData.privateTranscriptOutputs,
  circuitId,
);
const provider = httpClientProvingProvider(
  PROOF_SERVER_URL,
  new NodeZkConfigProvider(zkConfigDirectory),
  { timeout: 20 * 60 * 1_000 },
);

const checkStartedAt = performance.now();
const checkResult = await provider.check(preimage, circuitId);
const checkMs = performance.now() - checkStartedAt;
assert.ok(Array.isArray(checkResult), 'fairness check response was not an array');

const proveMs = [];
let proofBytes = 0;
for (let run = 0; run < requestedRuns; run++) {
  const startedAt = performance.now();
  const proof = await provider.prove(preimage, circuitId);
  proveMs.push(performance.now() - startedAt);
  assert.ok(proof.byteLength > 0, `fairness proof ${run + 1} was empty`);
  proofBytes = proof.byteLength;
  proof.fill(0);
}

console.log(JSON.stringify({
  proofServer: PROOF_SERVER_URL,
  proofServerVersion: '8.1.0',
  circuitId,
  runs: requestedRuns,
  checkMs: Math.round(checkMs),
  proveMs: proveMs.map(value => Math.round(value)),
  p50Ms: Math.round(nearestRank(proveMs, 0.50)),
  p95Ms: Math.round(nearestRank(proveMs, 0.95)),
  proofBytes,
  serializedPreimageBytes: preimage.byteLength,
}, null, 2));
preimage.fill(0);
