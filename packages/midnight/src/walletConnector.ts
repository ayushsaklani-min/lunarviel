import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';

export const SUPPORTED_CONNECTOR_API_VERSION = '4.0.1';

export interface WalletDescriptor {
  id: string;
  rdns: string;
  name: string;
  apiVersion: string;
  duplicateRdns: boolean;
  icon?: string;
}

export type WalletRegistry = Readonly<Record<string, unknown>>;

export class WalletConnectorError extends Error {
  readonly code:
    | 'WALLET_NOT_FOUND'
    | 'UNSUPPORTED_API_VERSION'
    | 'INVALID_WALLET_API'
    | 'WALLET_DISCONNECTED'
    | 'NETWORK_MISMATCH';

  constructor(code: WalletConnectorError['code']) {
    super(code);
    this.name = 'WalletConnectorError';
    this.code = code;
  }
}

function isInitialAPI(value: unknown): value is InitialAPI {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InitialAPI>;
  return typeof candidate.rdns === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.icon === 'string' &&
    typeof candidate.apiVersion === 'string' &&
    typeof candidate.connect === 'function';
}

function safeText(value: string, maximumLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximumLength);
}

function safeRdns(value: string): string {
  const normalized = safeText(value, 253).toLowerCase();
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(normalized)
    ? normalized
    : 'invalid.wallet.identifier';
}

function safeIcon(value: string): string | undefined {
  if (/^https:\/\/[^\s]{1,2048}$/i.test(value)) return value;
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length <= 512_000) {
    return value;
  }
  return undefined;
}

function descriptor(id: string, api: InitialAPI, duplicateRdns: boolean): WalletDescriptor {
  const result: WalletDescriptor = {
    id,
    rdns: safeRdns(api.rdns),
    name: safeText(api.name, 80) || 'Unnamed Midnight wallet',
    apiVersion: api.apiVersion,
    duplicateRdns,
  };
  const icon = safeIcon(api.icon);
  if (icon !== undefined) result.icon = icon;
  return result;
}

export function discoverCompatibleWallets(registry: WalletRegistry): WalletDescriptor[] {
  const candidates = Object.entries(registry)
    .filter((entry): entry is [string, InitialAPI] => isInitialAPI(entry[1]))
    .filter(([, api]) => api.apiVersion === SUPPORTED_CONNECTOR_API_VERSION);
  const counts = new Map<string, number>();
  for (const [, api] of candidates) {
    const rdns = safeRdns(api.rdns);
    counts.set(rdns, (counts.get(rdns) ?? 0) + 1);
  }
  return candidates
    .map(([id, api]) => descriptor(id, api, (counts.get(safeRdns(api.rdns)) ?? 0) > 1))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function connectSelectedWallet(
  registry: WalletRegistry,
  walletId: string,
  networkId: string,
): Promise<ConnectedAPI> {
  const candidate = registry[walletId];
  if (candidate === undefined) throw new WalletConnectorError('WALLET_NOT_FOUND');
  if (!isInitialAPI(candidate)) throw new WalletConnectorError('INVALID_WALLET_API');
  // Preserve the runtime-validated boundary explicitly; some DOM/global declaration
  // combinations widen indexed connector registries back to object-like values.
  const wallet = candidate as InitialAPI;
  if (wallet.apiVersion !== SUPPORTED_CONNECTOR_API_VERSION) {
    throw new WalletConnectorError('UNSUPPORTED_API_VERSION');
  }
  const connected = await wallet.connect(networkId);
  const [status, configuration] = await Promise.all([
    connected.getConnectionStatus(),
    connected.getConfiguration(),
  ]);
  if (status.status !== 'connected') throw new WalletConnectorError('WALLET_DISCONNECTED');
  if (status.networkId !== networkId || configuration.networkId !== networkId) {
    throw new WalletConnectorError('NETWORK_MISMATCH');
  }
  return connected;
}
