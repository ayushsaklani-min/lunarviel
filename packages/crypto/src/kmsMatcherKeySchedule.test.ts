import { describe, expect, it } from 'vitest';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
} from './orderEnvelope.js';
import {
  KmsMatcherKeyScheduleError,
  KmsMatcherKeyScheduleV1,
  type MatcherPrivateKeyResolverV1,
} from './kmsMatcherKeySchedule.js';

const start = 1_800_000_000_000n;

function expectScheduleError(action: () => unknown, code: KmsMatcherKeyScheduleError['code']): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(KmsMatcherKeyScheduleError);
    if (!(error instanceof KmsMatcherKeyScheduleError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('KmsMatcherKeyScheduleV1', () => {
  it('selects public metadata without resolving private key material', async () => {
    const key = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-a', activeFromMs: start, expiresAtMs: start + 10n,
    });
    let resolveCalls = 0;
    const resolver: MatcherPrivateKeyResolverV1 = {
      async resolvePrivateKey() {
        resolveCalls++;
        return key.privateKey;
      },
    };
    const schedule = new KmsMatcherKeyScheduleV1(resolver);
    schedule.register({ ...matcherPublicKeyV1(key), privateKeyRef: 'kms://lunarveil/matcher-a' });

    expect(schedule.activePublicKey(start).keyId).toBe('matcher-a');
    expect(resolveCalls).toBe(0);
    expect((await schedule.decryptionKeyForExistingEnvelope('matcher-a')).privateKey).toBe(key.privateKey);
    expect(resolveCalls).toBe(1);
  });

  it('fails closed for invalid references and resolver failures', async () => {
    const key = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-a', activeFromMs: start, expiresAtMs: start + 10n,
    });
    const schedule = new KmsMatcherKeyScheduleV1({
      async resolvePrivateKey() { throw new Error('provider detail must not escape'); },
    });
    expectScheduleError(
      () => schedule.register({ ...matcherPublicKeyV1(key), privateKeyRef: 'not allowed' }),
      'INVALID_PRIVATE_KEY_REF',
    );
    schedule.register({ ...matcherPublicKeyV1(key), privateKeyRef: 'kms://lunarveil/matcher-a' });
    await expect(schedule.decryptionKeyForExistingEnvelope('matcher-a')).rejects.toMatchObject({
      name: KmsMatcherKeyScheduleError.name,
      code: 'KEY_RESOLUTION_FAILED',
    });
  });

  it('does not retire a referenced key until outstanding envelopes clear', async () => {
    const key = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-a', activeFromMs: start, expiresAtMs: start + 10n,
    });
    const schedule = new KmsMatcherKeyScheduleV1({ async resolvePrivateKey() { return key.privateKey; } });
    schedule.register({ ...matcherPublicKeyV1(key), privateKeyRef: 'hsm://slot-1/matcher-a' });

    expectScheduleError(
      () => schedule.retireExpired('matcher-a', start + 10n, () => true),
      'OUTSTANDING_ENVELOPES',
    );
    schedule.retireExpired('matcher-a', start + 10n, () => false);
    expect(schedule.size()).toBe(0);
  });
});
