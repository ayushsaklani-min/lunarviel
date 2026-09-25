import { LunarveilApiError } from './errors.js';
import {
  DEPENDENCY_COMPONENT_NAMES_V1,
  DEPENDENCY_STATES_V1,
  EPOCH_STATES_V1,
  MARKET_STATUSES_V1,
  type DependencyComponentV1,
  type EpochResultV1,
  type EpochV1,
  ORDER_SUBMISSION_STATES_V1,
  TRADER_ORDER_STATES_V1,
  type MarketV1,
  type MatcherKeyV1,
  type OrderEnvelopeWireV1,
  type OrderSubmissionV1,
  type SessionChallengeV1,
  type TraderOrderV1,
  type SessionV1,
  type SystemStatusV1,
} from './publicTypes.js';

const DECIMAL_PATTERN = /^[0-9]+$/u;
// The identifier shape the server's own market sources enforce.
const MARKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface LunarveilApiClientOptionsV1 {
  /** Absolute `http:`/`https:` origin of the API, with no credentials. */
  readonly baseUrl: string;
  /** Injected for tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function requireString(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return value;
}

function requireDecimal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 78 || !DECIMAL_PATTERN.test(value)) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return value;
}

function requireCount(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return value;
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return value as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return value as Record<string, unknown>;
}

/**
 * Rebuilds each value from known fields only. An unexpected field the server
 * grows later is dropped here rather than reaching a component, so no future
 * response can accidentally render something this client never reviewed.
 */
function parseMarket(value: unknown): MarketV1 {
  const raw = asRecord(value);
  return {
    id: requireString(raw.id, 128),
    marketKey: requireString(raw.marketKey, 128),
    baseAssetId: requireString(raw.baseAssetId, 128),
    quoteAssetId: requireString(raw.quoteAssetId, 128),
    tickSizeAtomic: requireDecimal(raw.tickSizeAtomic),
    lotSizeAtomic: requireDecimal(raw.lotSizeAtomic),
    epochDurationSeconds: requireCount(raw.epochDurationSeconds, 1),
    maxOrdersPerEpoch: requireCount(raw.maxOrdersPerEpoch, 1),
    minBatchPrivacy: requireCount(raw.minBatchPrivacy, 1),
    matchingRuleVersion: requireString(raw.matchingRuleVersion, 64),
    status: requireMember(raw.status, MARKET_STATUSES_V1),
  };
}

function parseEpoch(value: unknown): EpochV1 {
  const raw = asRecord(value);
  return {
    id: requireString(raw.id, 128),
    marketId: requireString(raw.marketId, 128),
    sequence: requireDecimal(raw.sequence),
    state: requireMember(raw.state, EPOCH_STATES_V1),
    orderCount: requireCount(raw.orderCount, 0),
    maxOrders: requireCount(raw.maxOrders, 1),
    scheduledCloseAtMs: requireDecimal(raw.scheduledCloseAtMs),
    ruleVersion: requireString(raw.ruleVersion, 64),
    configHash: requireString(raw.configHash, 256),
  };
}

function parseEpochResult(value: unknown): EpochResultV1 {
  const raw = asRecord(value);
  const state = requireMember(raw.state, ['FINALIZED', 'INVALIDATED'] as const);
  if (typeof raw.simulated !== 'boolean') throw new LunarveilApiError('MALFORMED_RESPONSE');
  return {
    epochId: requireString(raw.epochId, 128),
    sequence: requireDecimal(raw.sequence),
    state,
    closedAtMs: requireDecimal(raw.closedAtMs),
    orderCount: requireCount(raw.orderCount, 0),
    matchedOrderCount: requireCount(raw.matchedOrderCount, 0),
    ...(raw.clearingPriceTicks === undefined ? {} : { clearingPriceTicks: requireDecimal(raw.clearingPriceTicks) }),
    totalVolumeLots: requireDecimal(raw.totalVolumeLots),
    rejectedSolutionCount: requireCount(raw.rejectedSolutionCount, 0),
    ...(raw.proofReference === undefined ? {} : { proofReference: requireString(raw.proofReference, 256) }),
    ...(raw.settlementReference === undefined ? {} : { settlementReference: requireString(raw.settlementReference, 256) }),
    simulated: raw.simulated,
  };
}

function parseSystemStatus(value: unknown): SystemStatusV1 {
  const raw = asRecord(value);
  if (!Array.isArray(raw.components)) throw new LunarveilApiError('MALFORMED_RESPONSE');
  const components: DependencyComponentV1[] = raw.components.map(entry => {
    const component = asRecord(entry);
    return {
      name: requireMember(component.name, DEPENDENCY_COMPONENT_NAMES_V1),
      state: requireMember(component.state, DEPENDENCY_STATES_V1),
    };
  });
  return { state: requireMember(raw.state, DEPENDENCY_STATES_V1), components };
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

function requireBase64Url(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !BASE64URL_PATTERN.test(value)) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return value;
}

function parseSessionChallenge(value: unknown): SessionChallengeV1 {
  const raw = asRecord(value);
  return {
    id: requireString(raw.id, 128),
    domain: requireString(raw.domain, 255),
    walletIdentity: requireString(raw.walletIdentity, 256),
    nonce: requireBase64Url(raw.nonce, 512),
    issuedAtMs: requireDecimal(raw.issuedAtMs),
    expiresAtMs: requireDecimal(raw.expiresAtMs),
  };
}

function parseSession(value: unknown): SessionV1 {
  const raw = asRecord(value);
  const base = {
    token: requireBase64Url(raw.token, 512),
    expiresAtMs: requireDecimal(raw.expiresAtMs),
  };
  if (raw.traderTagHash === undefined) return base;
  if (typeof raw.traderTagHash !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.traderTagHash)) {
    throw new LunarveilApiError('MALFORMED_RESPONSE');
  }
  return { ...base, traderTagHash: raw.traderTagHash };
}

function parseMatcherKey(value: unknown): MatcherKeyV1 {
  const raw = asRecord(value);
  if (raw.version !== 1) throw new LunarveilApiError('MALFORMED_RESPONSE');
  return {
    version: 1,
    keyId: requireString(raw.keyId, 128),
    algorithm: requireString(raw.algorithm, 64),
    publicKey: requireBase64Url(raw.publicKey, 512),
    activeFromMs: requireDecimal(raw.activeFromMs),
    expiresAtMs: requireDecimal(raw.expiresAtMs),
  };
}

function parseOrderSubmission(value: unknown): OrderSubmissionV1 {
  const raw = asRecord(value);
  if (typeof raw.replayed !== 'boolean') throw new LunarveilApiError('MALFORMED_RESPONSE');
  return {
    orderId: requireString(raw.orderId, 128),
    clientRequestId: requireString(raw.clientRequestId, 64),
    state: requireMember(raw.state, ORDER_SUBMISSION_STATES_V1),
    replayed: raw.replayed,
    createdAtMs: requireDecimal(raw.createdAtMs),
  };
}

function parseTraderOrder(value: unknown): TraderOrderV1 {
  const raw = asRecord(value);
  const order: TraderOrderV1 = {
    orderId: requireString(raw.orderId, 128),
    clientRequestId: requireString(raw.clientRequestId, 64),
    marketId: requireString(raw.marketId, 128),
    epochId: requireString(raw.epochId, 128),
    commitment: requireString(raw.commitment, 64),
    state: requireMember(raw.state, TRADER_ORDER_STATES_V1),
    createdAtMs: requireDecimal(raw.createdAtMs),
  };
  return {
    ...order,
    ...(raw.acceptedAtMs === undefined ? {} : { acceptedAtMs: requireDecimal(raw.acceptedAtMs) }),
    ...(raw.chainAdmissionTxId === undefined
      ? {}
      : { chainAdmissionTxId: requireString(raw.chainAdmissionTxId, 255) }),
    ...(raw.leafIndex === undefined ? {} : { leafIndex: requireDecimal(raw.leafIndex) }),
    ...(raw.admissionSubmittedTxId === undefined
      ? {}
      : { admissionSubmittedTxId: requireString(raw.admissionSubmittedTxId, 255) }),
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LunarveilApiError('INVALID_BASE_URL');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '') {
    throw new LunarveilApiError('INVALID_BASE_URL');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

/**
 * Read-only client for the public Lunarveil API.
 *
 * It only reaches endpoints that carry public catalog data: no credential, no
 * session token, no order ciphertext and no private field passes through it.
 * Every response is re-validated and rebuilt from known fields, and every
 * failure surfaces as a sanitized `LunarveilApiError` — a UI can render a
 * stable code, never a server message.
 */
export class LunarveilApiClientV1 {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LunarveilApiClientOptionsV1) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    this.timeoutMs = timeoutMs;
    const platformFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof platformFetch !== 'function') throw new LunarveilApiError('INVALID_ARGUMENT');
    // Bound to the global on purpose. A browser's `fetch` throws
    // "Illegal invocation" when called as a method of any other object, and
    // storing it on `this` does exactly that. Node's `fetch` does not care,
    // so this failed only in a real browser — every test passed because they
    // inject a plain function. See ADR-0040.
    this.fetchImpl = platformFetch.bind(globalThis);
  }

  async listMarkets(init: { readonly signal?: AbortSignal } = {}): Promise<readonly MarketV1[]> {
    const body = asRecord(await this.getJson('/v1/markets', init));
    if (!Array.isArray(body.markets)) throw new LunarveilApiError('MALFORMED_RESPONSE');
    return body.markets.map(parseMarket);
  }

  async getMarketEpoch(
    marketId: string,
    init: { readonly signal?: AbortSignal } = {},
  ): Promise<EpochV1> {
    if (typeof marketId !== 'string' || !MARKET_ID_PATTERN.test(marketId)) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    return parseEpoch(await this.getJson(`/v1/markets/${encodeURIComponent(marketId)}/epoch`, init));
  }

  /** Recent finished epochs of one market, newest first. Public aggregates only. */
  async listEpochResults(
    marketId: string,
    input: { readonly limit?: number } = {},
    init: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly EpochResultV1[]> {
    if (typeof marketId !== 'string' || !MARKET_ID_PATTERN.test(marketId)) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    const query = input.limit === undefined ? '' : `?limit=${input.limit}`;
    const body = asRecord(await this.getJson(`/v1/markets/${encodeURIComponent(marketId)}/results${query}`, init));
    if (!Array.isArray(body.results)) throw new LunarveilApiError('MALFORMED_RESPONSE');
    return body.results.map(parseEpochResult);
  }

  async getSystemStatus(init: { readonly signal?: AbortSignal } = {}): Promise<SystemStatusV1> {
    return parseSystemStatus(await this.getJson('/v1/system/status', init));
  }

  /**
   * Opens a wallet-authentication challenge.
   *
   * The challenge is public: it is exactly what the wallet must sign, and
   * carries nothing secret. Build the message to sign with
   * `buildSessionSigningMessageV1` so both sides use one definition.
   */
  async createSessionChallenge(
    input: { readonly domain: string; readonly walletIdentity: string },
    init: { readonly signal?: AbortSignal } = {},
  ): Promise<SessionChallengeV1> {
    if (typeof input.domain !== 'string' || input.domain.length === 0 || input.domain.length > 255
      || typeof input.walletIdentity !== 'string' || input.walletIdentity.length === 0
      || input.walletIdentity.length > 256) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    return parseSessionChallenge(await this.sendJson('/v1/sessions/challenges', {
      domain: input.domain, walletIdentity: input.walletIdentity,
    }, init));
  }

  /**
   * Exchanges a signed challenge for a session token.
   *
   * The returned token is a credential. Hold it in memory only: it must never
   * reach `localStorage`, a log line or a URL.
   */
  async verifySessionChallenge(
    input: {
      readonly challengeId: string;
      readonly signature: string;
      readonly verifyingKey?: string;
      readonly signedData?: string;
    },
    init: { readonly signal?: AbortSignal } = {},
  ): Promise<SessionV1> {
    if (typeof input.challengeId !== 'string' || input.challengeId.length === 0 || input.challengeId.length > 128
      || typeof input.signature !== 'string' || !BASE64URL_PATTERN.test(input.signature)
      || input.signature.length > 4096) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    const body: Record<string, string> = { challengeId: input.challengeId, signature: input.signature };
    if (input.verifyingKey !== undefined) {
      if (!/^[0-9a-fA-F]{2,512}$/u.test(input.verifyingKey)) throw new LunarveilApiError('INVALID_ARGUMENT');
      body.verifyingKey = input.verifyingKey;
    }
    if (input.signedData !== undefined) {
      if (!BASE64URL_PATTERN.test(input.signedData) || input.signedData.length > 8192) {
        throw new LunarveilApiError('INVALID_ARGUMENT');
      }
      body.signedData = input.signedData;
    }
    return parseSession(await this.sendJson('/v1/sessions/verify', body, init));
  }

  /** Public metadata for the key an order envelope must be sealed to. */
  async getMatcherKey(init: { readonly signal?: AbortSignal } = {}): Promise<MatcherKeyV1> {
    return parseMatcherKey(await this.getJson('/v1/matcher-key', init));
  }

  /**
   * Submits an already-encrypted order.
   *
   * The envelope is ciphertext plus public metadata: this client never sees,
   * and cannot see, the order's side, price or quantity. The session token is
   * passed explicitly for this one call rather than held by the client, so
   * nothing is ever attached to a request by accident.
   */
  async submitOrder(
    input: {
      readonly bearerToken: string;
      readonly envelope: OrderEnvelopeWireV1;
      readonly clientSignature: string;
      readonly verifyingKey?: string;
      readonly signedData?: string;
    },
    init: { readonly signal?: AbortSignal } = {},
  ): Promise<OrderSubmissionV1> {
    if (typeof input.bearerToken !== 'string' || !BASE64URL_PATTERN.test(input.bearerToken)
      || input.bearerToken.length > 512) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    if (typeof input.clientSignature !== 'string' || !BASE64URL_PATTERN.test(input.clientSignature)
      || input.clientSignature.length > 4096) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    const body: Record<string, unknown> = {
      envelope: input.envelope,
      clientSignature: input.clientSignature,
    };
    if (input.verifyingKey !== undefined) {
      if (!/^[0-9a-fA-F]{2,512}$/u.test(input.verifyingKey)) throw new LunarveilApiError('INVALID_ARGUMENT');
      body.verifyingKey = input.verifyingKey;
    }
    if (input.signedData !== undefined) {
      if (!BASE64URL_PATTERN.test(input.signedData) || input.signedData.length > 16384) {
        throw new LunarveilApiError('INVALID_ARGUMENT');
      }
      body.signedData = input.signedData;
    }
    return parseOrderSubmission(await this.sendJson('/v1/orders', body, init, input.bearerToken));
  }

  /**
   * Lists the authenticated trader's own orders.
   *
   * The server derives whose orders these are from the session token; there is
   * no parameter for naming a trader, by design.
   */
  async listMyOrders(
    input: { readonly bearerToken: string; readonly limit?: number },
    init: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly TraderOrderV1[]> {
    if (typeof input.bearerToken !== 'string' || !BASE64URL_PATTERN.test(input.bearerToken)
      || input.bearerToken.length > 512) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    if (input.limit !== undefined
      && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)) {
      throw new LunarveilApiError('INVALID_ARGUMENT');
    }
    const query = input.limit === undefined ? '' : `?limit=${input.limit}`;
    const body = asRecord(await this.getJson(`/v1/orders${query}`, init, input.bearerToken));
    if (!Array.isArray(body.orders)) throw new LunarveilApiError('MALFORMED_RESPONSE');
    return body.orders.map(parseTraderOrder);
  }

  private async getJson(
    path: string,
    init: { readonly signal?: AbortSignal },
    bearerToken?: string,
  ): Promise<unknown> {
    const response = await this.send(path, init.signal, undefined, bearerToken);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LunarveilApiError('MALFORMED_RESPONSE', { status: response.status });
    }

    if (!response.ok) throw this.toServerError(response.status, payload);
    return payload;
  }

  private async sendJson(
    path: string,
    body: Readonly<Record<string, unknown>>,
    init: { readonly signal?: AbortSignal },
    bearerToken?: string,
  ): Promise<unknown> {
    const response = await this.send(path, init.signal, body, bearerToken);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LunarveilApiError('MALFORMED_RESPONSE', { status: response.status });
    }
    if (!response.ok) throw this.toServerError(response.status, payload);
    return payload;
  }

  /**
   * Issues one request under a timeout.
   *
   * The timeout is built from `AbortController` and a timer rather than
   * `AbortSignal.timeout`/`AbortSignal.any`, which are not present in every
   * runtime this client has to work in (a jsdom test environment among them).
   * It covers reaching response headers; body parsing is bounded by the
   * caller's own signal.
   */
  private async send(
    path: string,
    signal: AbortSignal | undefined,
    body?: Readonly<Record<string, unknown>>,
    bearerToken?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const forwardAbort = (): void => { controller.abort(); };
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          // Only ever the token this call was explicitly given.
          ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
        },
        // Ambient credentials are never attached; a session token, when one
        // exists, is passed explicitly by a caller that needs it.
        credentials: 'omit',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new LunarveilApiError('TIMEOUT');
      // Never re-throw the platform error: it can carry the resolved URL.
      throw new LunarveilApiError('NETWORK_FAILURE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private toServerError(status: number, payload: unknown): LunarveilApiError {
    let serverCode: string | undefined;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const code = (payload as { code?: unknown }).code;
      if (typeof code === 'string') serverCode = code;
    }
    const options = serverCode === undefined ? { status } : { status, serverCode };
    if (status === 503) return new LunarveilApiError('SERVICE_UNAVAILABLE', options);
    if (status >= 500) return new LunarveilApiError('INTERNAL_ERROR', options);
    return new LunarveilApiError('REQUEST_REJECTED', options);
  }
}
