import { describe, expect, it } from 'vitest';

import {
  MarketContractRegistryError,
  StaticMarketContractRegistryV1,
  isMarketIdV1,
  normalizeContractAddressV1,
} from './marketContractRegistry.js';

// The verified M3 Preview deployment address, as recorded in project memory.
const DEPLOYED = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';

describe('normalizeContractAddressV1', () => {
  it('accepts the real deployed address and lower-cases it', () => {
    expect(normalizeContractAddressV1(DEPLOYED)).toBe(DEPLOYED);
    expect(normalizeContractAddressV1(DEPLOYED.toUpperCase())).toBe(DEPLOYED);
    expect(normalizeContractAddressV1(`  ${DEPLOYED}  `)).toBe(DEPLOYED);
  });

  it('rejects anything that is not whole-byte hex of a plausible length', () => {
    expect(normalizeContractAddressV1('')).toBeUndefined();
    expect(normalizeContractAddressV1('0x'.concat(DEPLOYED))).toBeUndefined();
    // Odd length is not a whole number of bytes.
    expect(normalizeContractAddressV1('a'.repeat(65))).toBeUndefined();
    expect(normalizeContractAddressV1('zz'.repeat(32))).toBeUndefined();
    expect(normalizeContractAddressV1('ab'.repeat(4))).toBeUndefined();
    expect(normalizeContractAddressV1(DEPLOYED.repeat(5))).toBeUndefined();
    expect(normalizeContractAddressV1(undefined)).toBeUndefined();
    expect(normalizeContractAddressV1(123)).toBeUndefined();
  });
});

describe('isMarketIdV1', () => {
  it('accepts the identifier shape the database sources already enforce', () => {
    expect(isMarketIdV1('market-1')).toBe(true);
    expect(isMarketIdV1('a')).toBe(true);
  });

  it('rejects empty, over-long, leading-punctuation and whitespace-bearing ids', () => {
    expect(isMarketIdV1('')).toBe(false);
    expect(isMarketIdV1('-leading')).toBe(false);
    expect(isMarketIdV1('a'.repeat(129))).toBe(false);
    expect(isMarketIdV1('market with space')).toBe(false);
    expect(isMarketIdV1(42)).toBe(false);
  });
});

describe('StaticMarketContractRegistryV1', () => {
  it('resolves a configured market and normalizes the configured address', async () => {
    const registry = new StaticMarketContractRegistryV1({ 'market-1': DEPLOYED.toUpperCase() });
    expect(await registry.resolveContractAddress('market-1')).toBe(DEPLOYED);
  });

  it('returns undefined — not a guess — for an unknown market', async () => {
    const registry = new StaticMarketContractRegistryV1({ 'market-1': DEPLOYED });
    expect(await registry.resolveContractAddress('market-2')).toBeUndefined();
  });

  it('fails at construction on a malformed operator entry', () => {
    expect(() => new StaticMarketContractRegistryV1({ 'market-1': 'not-an-address' }))
      .toThrow(MarketContractRegistryError);
    expect(() => new StaticMarketContractRegistryV1({ '-bad-market': DEPLOYED }))
      .toThrow(MarketContractRegistryError);
  });

  it('rejects a malformed lookup rather than reporting it as unknown', async () => {
    const registry = new StaticMarketContractRegistryV1({ 'market-1': DEPLOYED });
    await expect(registry.resolveContractAddress('')).rejects.toThrow(MarketContractRegistryError);
  });
});
