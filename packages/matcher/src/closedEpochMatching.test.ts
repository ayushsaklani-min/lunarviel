import { createHash } from 'node:crypto';

import {
  commitOrderIntentV1,
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
  type MatcherDecryptionKeyV1,
  type OrderIntentV1,
} from '@lunarveil/crypto';
import { describe, expect, it } from 'vitest';

import {
  ClosedEpochMatchingError,
  prepareClosedEpochBatchV1,
  type ClosedEpochMatchingContextV1,
  type FrozenEncryptedOrderV1,
} from './closedEpochMatching.js';
import { BatchPreparationServiceV1 } from './batchPreparationService.js';

const NOW = 1_800_000_000_000n;
const MARKET = 'NIGHT-USDCX';
const EPOCH = 'epoch-7';
const OWNER = '42'.repeat(32);

function context(overrides: Partial<ClosedEpochMatchingContextV1> = {}): ClosedEpochMatchingContextV1 {
  return {
    marketId: MARKET,
    epochId: EPOCH,
    epochSequence: 7n,
    ruleVersion: 'm3a-v1',
    configHash: 'ab'.repeat(32),
    inputRoot: 'closed-root-7',
    closedAtMs: NOW,
    orderCount: 2,
    maxOrders: 4,
    ...overrides,
  };
}

function marketId(): Uint8Array {
  return new Uint8Array(createHash('sha256').update(MARKET, 'utf8').digest());
}

async function makeOrder(input: {
  readonly key: MatcherDecryptionKeyV1;
  readonly index: bigint;
  readonly side: 'BUY' | 'SELL';
  readonly quantityLots: bigint;
  readonly price: bigint;
  readonly trader: string;
  readonly commitmentOverride?: string;
  readonly expiresAtMs?: bigint;
}): Promise<FrozenEncryptedOrderV1> {
  const nonce = new Uint8Array(32).fill(Number(input.index) + 1);
  const blinding = new Uint8Array(32).fill(Number(input.index) + 9);
  const order: OrderIntentV1 = {
    version: 1,
    marketId: marketId(),
    epochSequence: 7n,
    ownerPublicKey: Uint8Array.from(Buffer.from(OWNER, 'hex')),
    side: input.side,
    orderType: 'LIMIT',
    quantityLots: input.quantityLots,
    limitPriceTicks: input.price,
    minFillLots: 0n,
    tif: 'GFE',
    allowPartial: true,
    nonce,
    createdAtMs: NOW - 1_000n,
    expiresAtMs: input.expiresAtMs ?? NOW + 1_000n,
  };
  const commitment = Buffer.from(commitOrderIntentV1(order, blinding)).toString('hex');
  const plaintext = new TextEncoder().encode(JSON.stringify({
    version: 1,
    ownerPublicKey: OWNER,
    side: order.side,
    orderType: order.orderType,
    quantityLots: order.quantityLots.toString(),
    limitPriceTicks: order.limitPriceTicks.toString(),
    minFillLots: order.minFillLots.toString(),
    tif: order.tif,
    allowPartial: order.allowPartial,
    blinding: Array.from(blinding),
    nonce: Array.from(nonce),
    createdAtMs: order.createdAtMs.toString(),
    expiresAtMs: order.expiresAtMs.toString(),
  }));
  try {
    const envelope = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: input.index === 0n ? '4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c' : '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
        marketId: MARKET,
        epochId: EPOCH,
        commitment: input.commitmentOverride ?? commitment,
        traderTagHash: input.trader,
      },
      matcherKey: matcherPublicKeyV1(input.key),
      plaintext,
      nowMs: NOW - 2n,
    });
    return { orderId: `order-${input.index}`, leafIndex: input.index, envelope };
  } finally {
    nonce.fill(0);
    blinding.fill(0);
    plaintext.fill(0);
    order.marketId.fill(0);
    order.ownerPublicKey.fill(0);
    order.nonce.fill(0);
  }
}

describe('prepareClosedEpochBatchV1', () => {
  it('opens a complete frozen set, verifies each commitment, and clears deterministically', async () => {
    const key = await generateMatcherDecryptionKeyV1({ keyId: 'matcher-1', activeFromMs: NOW - 10n, expiresAtMs: NOW + 10n });
    const orders = await Promise.all([
      makeOrder({ key, index: 0n, side: 'BUY', quantityLots: 7n, price: 101n, trader: 'a1'.repeat(32) }),
      makeOrder({ key, index: 1n, side: 'SELL', quantityLots: 7n, price: 100n, trader: 'b2'.repeat(32) }),
    ]);
    const result = await prepareClosedEpochBatchV1(context(), orders, {
      resolveExistingEnvelopeKey: async keyId => {
        if (keyId !== key.keyId) throw new Error('unexpected key');
        return key;
      },
    });
    expect(result.solution.totalVolumeLots).toBe(7n);
    expect(result.solution.clearingPriceTicks).toBe(100n);
    expect(result.openings.map(opening => opening.leafIndex)).toEqual([0n, 1n]);
    expect(result.openings.map(opening => opening.order.side)).toEqual(['BUY', 'SELL']);
  });

  it('fails closed when a decrypted opening does not reproduce its public commitment', async () => {
    const key = await generateMatcherDecryptionKeyV1({ keyId: 'matcher-1', activeFromMs: NOW - 10n, expiresAtMs: NOW + 10n });
    const orders = await Promise.all([
      makeOrder({ key, index: 0n, side: 'BUY', quantityLots: 7n, price: 101n, trader: 'a1'.repeat(32), commitmentOverride: 'ff'.repeat(32) }),
      makeOrder({ key, index: 1n, side: 'SELL', quantityLots: 7n, price: 100n, trader: 'b2'.repeat(32) }),
    ]);
    await expect(prepareClosedEpochBatchV1(context(), orders, { resolveExistingEnvelopeKey: async () => key }))
      .rejects.toThrow(new ClosedEpochMatchingError('COMMITMENT_MISMATCH'));
  });

  it('rejects incomplete roots and expiry at the close boundary', async () => {
    const key = await generateMatcherDecryptionKeyV1({ keyId: 'matcher-1', activeFromMs: NOW - 10n, expiresAtMs: NOW + 10n });
    const onlyOrder = await makeOrder({ key, index: 0n, side: 'BUY', quantityLots: 7n, price: 101n, trader: 'a1'.repeat(32) });
    await expect(prepareClosedEpochBatchV1(context(), [onlyOrder], { resolveExistingEnvelopeKey: async () => key }))
      .rejects.toThrow(new ClosedEpochMatchingError('ORDER_SET_MISMATCH'));

    const orders = await Promise.all([
      makeOrder({ key, index: 0n, side: 'BUY', quantityLots: 7n, price: 101n, trader: 'a1'.repeat(32), expiresAtMs: NOW }),
      makeOrder({ key, index: 1n, side: 'SELL', quantityLots: 7n, price: 100n, trader: 'b2'.repeat(32) }),
    ]);
    await expect(prepareClosedEpochBatchV1(context(), orders, { resolveExistingEnvelopeKey: async () => key }))
      .rejects.toThrow(new ClosedEpochMatchingError('ORDER_EXPIRED_AT_CLOSE'));
  });

  it('starts proving only after a complete, commitment-checked preparation and scrubs openings', async () => {
    const key = await generateMatcherDecryptionKeyV1({ keyId: 'matcher-1', activeFromMs: NOW - 10n, expiresAtMs: NOW + 10n });
    const orders = await Promise.all([
      makeOrder({ key, index: 0n, side: 'BUY', quantityLots: 7n, price: 101n, trader: 'a1'.repeat(32) }),
      makeOrder({ key, index: 1n, side: 'SELL', quantityLots: 7n, price: 100n, trader: 'b2'.repeat(32) }),
    ]);
    const candidate = context();
    let persistedHash: string | undefined;
    const service = new BatchPreparationServiceV1({
      listReady: async () => [candidate],
      loadFrozenOrders: async () => orders,
      beginProving: async ({ solution }) => {
        persistedHash = solution.canonicalSolutionHash;
        return { outcome: 'STARTED', batchId: 'batch-1' };
      },
    }, { resolveExistingEnvelopeKey: async () => key });

    await expect(service.runOnce()).resolves.toEqual({ scanned: 1, started: 1, replayed: 0, rejected: 0, failed: 0 });
    expect(persistedHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
