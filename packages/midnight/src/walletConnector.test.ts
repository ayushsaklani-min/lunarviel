import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { describe, expect, it, vi } from 'vitest';

import {
  connectSelectedWallet,
  discoverCompatibleWallets,
  SUPPORTED_CONNECTOR_API_VERSION,
} from './walletConnector.js';

function connected(networkId = 'preview'): ConnectedAPI {
  return {
    getConnectionStatus: vi.fn(async () => ({ status: 'connected', networkId })),
    getConfiguration: vi.fn(async () => ({
      indexerUri: 'https://indexer.example.test',
      indexerWsUri: 'wss://indexer.example.test',
      substrateNodeUri: 'wss://node.example.test',
      networkId,
    })),
  } as unknown as ConnectedAPI;
}

function initial(overrides: Partial<InitialAPI> = {}): InitialAPI {
  return {
    rdns: 'org.example.wallet',
    name: 'Example Wallet',
    icon: 'https://wallet.example.test/icon.png',
    apiVersion: SUPPORTED_CONNECTOR_API_VERSION,
    connect: vi.fn(async () => connected()),
    ...overrides,
  };
}

describe('wallet connector boundary', () => {
  it('discovers only exact pinned APIs and flags duplicate rdns identities', () => {
    const wallets = discoverCompatibleWallets({
      one: initial({ name: 'Wallet A' }),
      two: initial({ name: 'Wallet B' }),
      old: initial({ apiVersion: '3.0.0' }),
      malformed: { name: 'not an API' },
    });
    expect(wallets).toHaveLength(2);
    expect(wallets.every(wallet => wallet.duplicateRdns)).toBe(true);
  });

  it('sanitizes display metadata and rejects active-content icon schemes', () => {
    const [wallet] = discoverCompatibleWallets({
      one: initial({
        rdns: 'not valid',
        name: '\u0000Dangerous Wallet\u0007',
        icon: 'data:image/svg+xml,<svg onload=alert(1)>',
      }),
    });
    expect(wallet).toMatchObject({
      rdns: 'invalid.wallet.identifier',
      name: 'Dangerous Wallet',
    });
    expect(wallet?.icon).toBeUndefined();
  });

  it('connects only when status and wallet configuration match the requested network', async () => {
    const api = initial();
    await expect(connectSelectedWallet({ wallet: api }, 'wallet', 'preview')).resolves.toBeDefined();
    expect(api.connect).toHaveBeenCalledWith('preview');
  });

  it('fails closed on an unsupported API or mismatched wallet network', async () => {
    await expect(connectSelectedWallet({
      wallet: initial({ apiVersion: '4.1.0' }),
    }, 'wallet', 'preview')).rejects.toMatchObject({ code: 'UNSUPPORTED_API_VERSION' });

    await expect(connectSelectedWallet({
      wallet: initial({ connect: vi.fn(async () => connected('preprod')) }),
    }, 'wallet', 'preview')).rejects.toMatchObject({ code: 'NETWORK_MISMATCH' });
  });
});
