import { describe, expect, it } from 'vitest';

import { generateMatcherDecryptionKeyV1 } from './orderEnvelope.js';
import { MatcherKeyRingError, MatcherKeyRingV1 } from './matcherKeyRing.js';

const start = 1_800_000_000_000n;

async function key(keyId: string, activeFromMs: bigint, expiresAtMs: bigint) {
  return generateMatcherDecryptionKeyV1({ keyId, activeFromMs, expiresAtMs });
}

function expectKeyRingError(action: () => unknown, code: MatcherKeyRingError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(MatcherKeyRingError);
    if (!(error instanceof MatcherKeyRingError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('MatcherKeyRingV1', () => {
  it('selects exactly one scheduled public encryption key', async () => {
    const ring = new MatcherKeyRingV1();
    ring.register(await key('matcher-a', start, start + 10n));
    ring.register(await key('matcher-b', start + 10n, start + 20n));

    expect(ring.activePublicKey(start + 9n).keyId).toBe('matcher-a');
    expect(ring.activePublicKey(start + 10n).keyId).toBe('matcher-b');
    expectKeyRingError(() => ring.activePublicKey(start + 20n), 'NO_ACTIVE_MATCHER_KEY');
  });

  it('rejects overlapping schedules and duplicate key identifiers', async () => {
    const ring = new MatcherKeyRingV1();
    ring.register(await key('matcher-a', start, start + 10n));
    const duplicateId = await key('matcher-a', start + 10n, start + 20n);
    const overlapping = await key('matcher-b', start + 9n, start + 20n);

    expectKeyRingError(() => ring.register(duplicateId), 'DUPLICATE_KEY_ID');
    expectKeyRingError(() => ring.register(overlapping), 'KEY_SCHEDULE_OVERLAP');
  });

  it('retains expired decryption capability only until outstanding envelopes are cleared', async () => {
    const ring = new MatcherKeyRingV1();
    const old = await key('matcher-a', start, start + 10n);
    ring.register(old);

    expect(ring.decryptionKeyForExistingEnvelope('matcher-a').privateKey).toBe(old.privateKey);
    expectKeyRingError(
      () => ring.retireExpired('matcher-a', start + 10n, () => true),
      'OUTSTANDING_ENVELOPES',
    );
    ring.retireExpired('matcher-a', start + 10n, () => false);
    expect(ring.size()).toBe(0);
  });
});
