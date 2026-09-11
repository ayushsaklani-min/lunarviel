import assert from 'node:assert/strict';

import { pureCircuits } from '../contracts/managed/order-commitment/contract/index.js';

const repeatedByte = (value) => new Uint8Array(32).fill(value);

const commitment = pureCircuits.deriveOrderCommitment(
  {
    version: 1n,
    marketId: repeatedByte(0x11),
    epochSequence: 7n,
    ownerPublicKey: repeatedByte(0x22),
    side: false,
    orderType: 0n,
    quantityLots: 125n,
    limitPriceTicks: 42_000n,
    minFillLots: 25n,
    tif: 0n,
    allowPartial: true,
    nonce: repeatedByte(0x33),
    createdAtMs: 1_800_000_000_000n,
    expiresAtMs: 1_800_000_060_000n,
  },
  repeatedByte(0xaa),
);

assert.equal(
  Buffer.from(commitment).toString('hex'),
  '5c9aa616a5b2c4d15076d8af9b3351184ddeb850486abaafccbdd14ddf420fa8',
  'generated Compact commitment must match the @lunarveil/crypto vector',
);

const ownerSecret = repeatedByte(0xcc);
assert.equal(
  Buffer.from(pureCircuits.deriveOwnerAuthorization(ownerSecret)).toString('hex'),
  'b77b6fcd85ac9a8dfc1da5390e0422519c1019332d3f0a76c69c500fc1680368',
  'generated Compact owner authorization must match the @lunarveil/crypto vector',
);
assert.equal(
  Buffer.from(pureCircuits.deriveOrderNullifier(commitment, ownerSecret)).toString('hex'),
  '9d76225398cfaad401b39a1e5da36b5a8bd026c2dfc9be6dd3060bb6c732b2c7',
  'generated Compact nullifier must match the @lunarveil/crypto vector',
);

console.log('M2 Compact/TypeScript commitment, owner, and nullifier vectors: verified');
