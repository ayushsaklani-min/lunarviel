import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Structured logging for the encrypted-order boundary.
 *
 * The emitter is an allowlist, never a denylist: an event carries only the
 * fields named here, so a future route cannot leak a new field by forgetting to
 * redact it. Nothing derived from an order, envelope, allocation, signature,
 * session token, wallet or key material is representable in this type.
 */
export type LogLevelV1 = 'info' | 'warn' | 'error';

export interface RedactedLogEventV1 {
  readonly level: LogLevelV1;
  readonly event: string;
  /** Route pattern such as `/v1/markets/:marketId/epoch`, never a populated URL. */
  readonly route?: string;
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'OPTIONS';
  readonly statusCode?: number;
  readonly durationMs?: number;
  /** Sanitized machine code already safe for a client response. */
  readonly code?: string;
  readonly requestId?: string;
  /** Salted keyed digest of the client address; never the address itself. */
  readonly clientHash?: string;
}

export interface EmittedLogEventV1 extends RedactedLogEventV1 {
  readonly timestampMs: string;
  readonly service: 'lunarveil-api';
}

export type LogSinkV1 = (event: EmittedLogEventV1) => void;

const EVENT_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/u;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ROUTE_PATTERN = /^\/[A-Za-z0-9/:_.-]{0,255}$/u;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const LEVELS = new Set(['info', 'warn', 'error']);

function digest(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

/**
 * Builds a redacting structured logger. The client-address key is generated per
 * process unless supplied, so digests are correlatable within one deployment
 * and are not a stable cross-deployment identifier.
 */
export function createRedactedLoggerV1(options: {
  readonly sink: LogSinkV1;
  readonly nowMs: () => bigint;
  readonly clientHashKey?: Uint8Array;
}): {
  log(event: RedactedLogEventV1): void;
  hashClient(address: string): string | undefined;
} {
  const key = Buffer.from(options.clientHashKey ?? Buffer.from(randomUUID() + randomUUID(), 'utf8'));
  if (key.length < 16) throw new Error('INVALID_LOG_KEY');

  return {
    hashClient(address: string): string | undefined {
      return typeof address === 'string' && address.length > 0 && address.length <= 64
        ? digest(key, address)
        : undefined;
    },
    log(event: RedactedLogEventV1): void {
      if (!event || !LEVELS.has(event.level) || !EVENT_PATTERN.test(event.event)) return;
      const emitted: EmittedLogEventV1 = {
        timestampMs: options.nowMs().toString(),
        service: 'lunarveil-api',
        level: event.level,
        event: event.event,
        ...(event.route !== undefined && ROUTE_PATTERN.test(event.route) ? { route: event.route } : {}),
        ...(event.method !== undefined && METHODS.has(event.method) ? { method: event.method } : {}),
        ...(Number.isSafeInteger(event.statusCode) && event.statusCode! >= 100 && event.statusCode! <= 599
          ? { statusCode: event.statusCode } : {}),
        ...(Number.isFinite(event.durationMs) && event.durationMs! >= 0
          ? { durationMs: Math.round(event.durationMs!) } : {}),
        ...(event.code !== undefined && CODE_PATTERN.test(event.code) ? { code: event.code } : {}),
        ...(event.requestId !== undefined && /^[A-Za-z0-9-]{1,64}$/u.test(event.requestId)
          ? { requestId: event.requestId } : {}),
        ...(event.clientHash !== undefined && /^[0-9a-f]{32}$/u.test(event.clientHash)
          ? { clientHash: event.clientHash } : {}),
      };
      try {
        options.sink(emitted);
      } catch {
        // A failing sink must never break request handling or surface internals.
      }
    },
  };
}

/** Writes one JSON object per line. Never pass a sink that reformats untrusted input. */
export function jsonLineSinkV1(write: (line: string) => void): LogSinkV1 {
  return event => write(JSON.stringify(event));
}

/** Constant-time comparison for two same-length digests. */
export function sameClientHashV1(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
