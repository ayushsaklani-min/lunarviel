import { describe, expect, it } from 'vitest';
import { bech32m } from '@scure/base';
import { walletIdentityFromAddressV1 } from './walletIdentity.js';

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const hex = Buffer.from(bytes).toString('hex');
const encode = (prefix: string, value = bytes) => bech32m.encode(prefix, bech32m.toWords(value), false);

describe('wallet identity normalization', () => {
  it('decodes an unshielded address on each supported network', () => {
    for (const network of ['undeployed', 'preview', 'preprod', 'mainnet']) {
      expect(walletIdentityFromAddressV1(encode(network === 'mainnet' ? 'mn_addr' : `mn_addr_${network}`), network)).toBe(hex);
    }
  });
  it('preserves canonical raw ledger identities', () => {
    expect(walletIdentityFromAddressV1(hex.toUpperCase(), 'preview')).toBe(hex);
  });
  it('rejects a wrong network or address type', () => {
    for (const prefix of ['mn_addr_preprod', 'mn_dust_preview', 'mn_shield-addr_preview']) {
      expect(() => walletIdentityFromAddressV1(encode(prefix), 'preview')).toThrow('NETWORK_MISMATCH');
    }
    expect(() => walletIdentityFromAddressV1(hex, 'unknown')).toThrow('NETWORK_MISMATCH');
  });
  it('rejects checksum corruption, malformed input and wrong byte length', () => {
    const address = encode('mn_addr_preview');
    for (const value of [address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q'), '', 'not-an-address', encode('mn_addr_preview', bytes.slice(1))]) {
      expect(() => walletIdentityFromAddressV1(value, 'preview')).toThrow('INVALID_WALLET_ADDRESS');
    }
  });
});
