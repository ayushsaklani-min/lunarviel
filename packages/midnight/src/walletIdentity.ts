import { bech32m } from '@scure/base';

import { WalletConnectorError } from './walletConnector.js';

/**
 * The API uses ledger addressFromKey's 32-byte hex identity. Lace displays
 * those same bytes as Bech32m. Decode before building/signing the challenge,
 * preserving the server's identity and order-signature binding unchanged.
 * Format checked against wallet-sdk-address-format 3.1.2 UnshieldedAddress.
 */
export function walletIdentityFromAddressV1(address: string, networkId: string): string {
  if (!['undeployed', 'preview', 'preprod', 'mainnet'].includes(networkId)) {
    throw new WalletConnectorError('NETWORK_MISMATCH');
  }
  // Raw identities remain supported for the existing local connector fixtures.
  if (/^[0-9a-fA-F]{64}$/u.test(address)) return address.toLowerCase();
  if (address.length > 128) throw new WalletConnectorError('INVALID_WALLET_ADDRESS');
  let decoded: { prefix: string; bytes: Uint8Array };
  try {
    decoded = bech32m.decodeToBytes(address);
  } catch {
    throw new WalletConnectorError('INVALID_WALLET_ADDRESS');
  }
  const prefix = networkId === 'mainnet' ? 'mn_addr' : `mn_addr_${networkId}`;
  if (decoded.prefix !== prefix) throw new WalletConnectorError('NETWORK_MISMATCH');
  if (decoded.bytes.length !== 32) throw new WalletConnectorError('INVALID_WALLET_ADDRESS');
  return Array.from(decoded.bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
