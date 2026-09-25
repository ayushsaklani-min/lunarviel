import { describe, expect, it } from 'vitest';

import { parseMatcherWorkerConfigV1 } from './config.js';

const SEED = '5a'.repeat(32);

describe('parseMatcherWorkerConfigV1 simulated chain gate', () => {
  it('leaves the simulated chain off by default', () => {
    expect(parseMatcherWorkerConfigV1({}).simulatedChain).toBeUndefined();
  });

  it('enables it only in development with the shared matcher key seed', () => {
    expect(parseMatcherWorkerConfigV1({
      LUNARVEIL_ENV: 'development', LUNARVEIL_SIMULATED_CHAIN: 'true', LUNARVEIL_DEV_MATCHER_KEY_SEED: SEED,
    }).simulatedChain).toEqual({ matcherKeySeedHex: SEED, maliciousMatcher: false });
  });

  it.each(['production', 'staging', undefined])('refuses to simulate the chain in %s', environment => {
    expect(() => parseMatcherWorkerConfigV1({
      ...(environment === undefined ? {} : { LUNARVEIL_ENV: environment }),
      LUNARVEIL_SIMULATED_CHAIN: 'true', LUNARVEIL_DEV_MATCHER_KEY_SEED: SEED,
    })).toThrow('SIMULATED_CHAIN_REQUIRES_DEVELOPMENT');
  });

  it('refuses a missing or malformed seed', () => {
    for (const seed of [undefined, 'abc', '5a'.repeat(31)]) {
      expect(() => parseMatcherWorkerConfigV1({
        LUNARVEIL_ENV: 'development', LUNARVEIL_SIMULATED_CHAIN: 'true',
        ...(seed === undefined ? {} : { LUNARVEIL_DEV_MATCHER_KEY_SEED: seed }),
      })).toThrow('SIMULATED_CHAIN_REQUIRES_MATCHER_KEY_SEED');
    }
  });

  it('rejects ambiguous flag values instead of guessing', () => {
    expect(() => parseMatcherWorkerConfigV1({ LUNARVEIL_SIMULATED_CHAIN: 'yes' })).toThrow('INVALID_SIMULATED_CHAIN');
  });

  it('refuses malicious-matcher mode without the simulated chain', () => {
    expect(() => parseMatcherWorkerConfigV1({ LUNARVEIL_DEMO_MALICIOUS_MATCHER: 'true' }))
      .toThrow('MALICIOUS_MATCHER_REQUIRES_SIMULATED_CHAIN');
  });
});
