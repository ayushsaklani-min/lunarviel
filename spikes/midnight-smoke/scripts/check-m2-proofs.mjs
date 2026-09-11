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
} from '../contracts/managed/order-commitment/contract/index.js';

const PROOF_SERVER_URL = process.env.LUNARVEIL_PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';
const zkConfigDirectory = fileURLToPath(new URL('../contracts/managed/order-commitment', import.meta.url));
const bytes = (value) => new Uint8Array(32).fill(value);
const contractAddress = dummyContractAddress();
const contract = new Contract({});

// These fixed values are synthetic test fixtures, never user order material.
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

function proofFixtureResults() {
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

  const submitted = contract.circuits.submitOrderCommitment(
    contextFor(initial.currentContractState, 0xa1),
    7n,
    commitmentA,
    bytes(0x01),
  );
  const secondSubmission = contract.circuits.submitOrderCommitment(
    contextFor(submitted.context.currentQueryContext.state, 0xb1),
    7n,
    commitmentB,
    bytes(0x02),
  );
  const currentRoot = ledger(secondSubmission.context.currentQueryContext.state).orderCommitments.root();
  const closed = contract.circuits.closeEpoch(
    contextFor(secondSubmission.context.currentQueryContext.state, 0xa1),
    7n,
    currentRoot,
    bytes(0x03),
  );
  const pathA = ledger(closed.context.currentQueryContext.state).orderCommitments.pathForLeaf(0n, commitmentA);
  const cancelled = contract.circuits.cancelOrder(
    contextFor(closed.context.currentQueryContext.state, 0xa1),
    orderA,
    blindingA,
    pathA,
    0n,
    ownerSecretA,
    bytes(0x09),
  );

  return new Map([
    ['submitOrderCommitment', submitted],
    ['closeEpoch', closed],
    ['cancelOrder', cancelled],
  ]);
}

function serializedPreimage(circuitId, proofData) {
  return proofDataIntoSerializedPreimage(
    proofData.input,
    proofData.output,
    proofData.publicTranscript,
    proofData.privateTranscriptOutputs,
    circuitId,
  );
}

const provider = httpClientProvingProvider(
  PROOF_SERVER_URL,
  new NodeZkConfigProvider(zkConfigDirectory),
  { timeout: 10 * 60 * 1_000 },
);
const results = [];

for (const [circuitId, circuitResult] of proofFixtureResults()) {
  const preimage = serializedPreimage(circuitId, circuitResult.proofData);
  const checkStartedAt = performance.now();
  const checkResult = await provider.check(preimage, circuitId);
  const checkMs = performance.now() - checkStartedAt;
  assert.ok(Array.isArray(checkResult), `${circuitId} check response was not an array`);

  const proveStartedAt = performance.now();
  const proof = await provider.prove(preimage, circuitId);
  const proveMs = performance.now() - proveStartedAt;
  assert.ok(proof.byteLength > 0, `${circuitId} returned an empty proof`);

  results.push({
    circuitId,
    checkMs: Math.round(checkMs),
    proveMs: Math.round(proveMs),
    proofBytes: proof.byteLength,
    serializedPreimageBytes: preimage.byteLength,
  });
  preimage.fill(0);
}

console.log(JSON.stringify({
  proofServer: PROOF_SERVER_URL,
  proofServerVersion: '8.1.0',
  measurements: results,
}, null, 2));
