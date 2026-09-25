/**
 * Resolves the Lunarveil API origin the browser should talk to.
 *
 * This runs on the server (a server component reads it and passes the result
 * down as a prop), so the value is decided once per render rather than through
 * a bundler-specific client environment mechanism.
 *
 * The default targets a locally composed `apps/api-server`. It is deliberately
 * a loopback address: a missing configuration must fail visibly in development,
 * never silently point a browser at some other origin.
 */
export const DEFAULT_API_BASE_URL_V1 = 'http://127.0.0.1:3001';

export class ApiConfigError extends Error {
  constructor(readonly code: 'INVALID_API_BASE_URL' | 'INVALID_CHAIN_NETWORK') {
    super(code);
    this.name = 'ApiConfigError';
  }
}

/** Network is explicit for hosted APIs; never silently select a real network. */
export function resolveWalletNetworkV1(env: Readonly<Record<string, string | undefined>> = {}): string {
  const value = env.LUNARVEIL_CHAIN_NETWORK?.trim();
  if (!value) {
    if (isLoopback(new URL(resolveApiBaseUrlV1(env)).hostname)) return 'undeployed';
    throw new ApiConfigError('INVALID_CHAIN_NETWORK');
  }
  if (['undeployed', 'preview', 'preprod', 'mainnet'].includes(value)) return value;
  throw new ApiConfigError('INVALID_CHAIN_NETWORK');
}

/** Deployed M3 N=4 Preview contract (public deployment metadata, ADR-0046). */
export const PREVIEW_MARKET_CONTRACT_ADDRESS_V1 =
  '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';

/** Public contract address for explorer links; never used to sign or submit. */
export function resolveMarketContractAddressV1(
  env: Readonly<Record<string, string | undefined>> = {},
  networkId: string,
): string | undefined {
  const value = env.LUNARVEIL_MARKET_CONTRACT_ADDRESS?.trim().toLowerCase();
  if (value !== undefined && value !== '') return /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
  return networkId === 'preview' ? PREVIEW_MARKET_CONTRACT_ADDRESS_V1 : undefined;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Validates an operator-supplied origin.
 *
 * Plaintext `http:` is accepted only for loopback development. Anything a
 * deployed browser would actually reach must be `https:`, so a misconfigured
 * deployment cannot downgrade the transport that carries order ciphertext
 * later in the product.
 */
export function resolveApiBaseUrlV1(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const configured = env.LUNARVEIL_API_BASE_URL;
  if (configured === undefined || configured.trim() === '') return DEFAULT_API_BASE_URL_V1;

  let parsed: URL;
  try {
    parsed = new URL(configured.trim());
  } catch {
    throw new ApiConfigError('INVALID_API_BASE_URL');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new ApiConfigError('INVALID_API_BASE_URL');
  }
  if (parsed.protocol === 'https:') return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) {
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  }
  throw new ApiConfigError('INVALID_API_BASE_URL');
}

/**
 * Whether this deployment talks to the development-only simulated chain
 * (`LUNARVEIL_DEMO_MODE=true`). It enables the in-browser demo wallet and
 * the copy that explains what is simulated. Anything but exactly `true` is off.
 */
export function resolveDemoModeV1(env: Readonly<Record<string, string | undefined>> = {}): boolean {
  return env.LUNARVEIL_DEMO_MODE === 'true';
}
