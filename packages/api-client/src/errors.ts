/**
 * Every failure this client can produce, as a stable machine code.
 *
 * `REQUEST_REJECTED`, `SERVICE_UNAVAILABLE` and `INTERNAL_ERROR` mirror the
 * server's own sanitized error envelope. The rest are client-side conditions.
 */
export type LunarveilApiErrorCodeV1 =
  | 'INVALID_BASE_URL'
  | 'INVALID_ARGUMENT'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'REQUEST_REJECTED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'MALFORMED_RESPONSE';

const SERVER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

/**
 * A sanitized transport failure.
 *
 * It deliberately carries no response body, no URL and no underlying error
 * message. A server error body can only contribute its allowlisted `code`
 * field, and only when that field looks like a machine code — anything else
 * is dropped rather than surfaced into a UI or a log.
 */
export class LunarveilApiError extends Error {
  readonly code: LunarveilApiErrorCodeV1;
  readonly status: number | undefined;
  /** The server's own sanitized `code`, when it supplied a well-formed one. */
  readonly serverCode: string | undefined;

  constructor(
    code: LunarveilApiErrorCodeV1,
    options: { readonly status?: number; readonly serverCode?: string } = {},
  ) {
    super(code);
    this.name = 'LunarveilApiError';
    this.code = code;
    this.status = options.status;
    this.serverCode = options.serverCode !== undefined && SERVER_CODE_PATTERN.test(options.serverCode)
      ? options.serverCode
      : undefined;
  }
}

export function isLunarveilApiError(value: unknown): value is LunarveilApiError {
  return value instanceof LunarveilApiError;
}
