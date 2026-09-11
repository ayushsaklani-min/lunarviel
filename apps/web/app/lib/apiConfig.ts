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
  constructor(readonly code: 'INVALID_API_BASE_URL') {
    super(code);
    this.name = 'ApiConfigError';
  }
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
