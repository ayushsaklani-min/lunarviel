import { describe, expect, it } from 'vitest';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
} from '@lunarveil/crypto';

import {
  InMemoryOrderEnvelopeIntake,
  OrderEnvelopeIntakeError,
} from './orderEnvelopeIntake.js';

const encoder = new TextEncoder();
const nowMs = 1_800_000_000_000n;

function expectIntakeError(action: () => unknown, code: OrderEnvelopeIntakeError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OrderEnvelopeIntakeError);
    if (!(error instanceof OrderEnvelopeIntakeError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

function intake() {
  let next = 0;
  return new InMemoryOrderEnvelopeIntake({
    nowMs: () => nowMs,
    nextId: () => `order-${++next}`,
  });
}

async function envelope(overrides: Partial<{ clientRequestId: string; commitment: string }> = {}) {
  const key = await generateMatcherDecryptionKeyV1({
    keyId: 'matcher-2026-09-a',
    activeFromMs: nowMs - 1n,
    expiresAtMs: nowMs + 60_000n,
  });
  return sealOrderEnvelopeV1({
    header: {
      clientRequestId: overrides.clientRequestId ?? '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
      marketId: 'NIGHT-USDCX',
      epochId: 'epoch-7',
      commitment: overrides.commitment ?? '11'.repeat(32),
      traderTagHash: '22'.repeat(32),
    },
    matcherKey: matcherPublicKeyV1(key),
    plaintext: encoder.encode('{"side":"BUY","quantityLots":"7"}'),
    nowMs,
  });
}

describe('InMemoryOrderEnvelopeIntake', () => {
  it('accepts ciphertext only and replays the exact client request without duplication', async () => {
    const store = intake();
    const submitted = await envelope();
    const first = store.submit(submitted);
    const replay = store.submit(submitted);

    expect(first.replayed).toBe(false);
    expect(first.record.state).toBe('PENDING_CHAIN');
    expect(replay.replayed).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(store.size()).toBe(1);
    expect(JSON.stringify(first.record, (_name, value: unknown) => (
      typeof value === 'bigint' ? value.toString() : value
    ))).not.toContain('quantityLots');
  });

  it('fails closed when a request ID is reused with another encrypted payload', async () => {
    const store = intake();
    store.submit(await envelope());
    const conflicting = await envelope();

    expectIntakeError(() => store.submit(conflicting), 'IDEMPOTENCY_CONFLICT');
  });

  it('rejects a commitment submitted under a second request ID', async () => {
    const store = intake();
    store.submit(await envelope());
    const duplicate = await envelope({
      clientRequestId: 'b5595ce1-38d3-44aa-88b1-40d60fd0e0c7',
    });

    expectIntakeError(() => store.submit(duplicate), 'DUPLICATE_COMMITMENT');
  });
});
