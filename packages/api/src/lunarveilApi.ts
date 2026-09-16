import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

import type { AllocationEnvelopeV1, MatcherEncryptionPublicKeyV1, OrderEnvelopeV1 } from '@lunarveil/crypto';
import {
  AuthenticatedOrderSubmissionError,
  type AuthenticatedOrderSubmissionServiceV1,
  SessionChallengeError,
  type InMemorySessionChallengeService,
} from '@lunarveil/matcher';
import type { RedactedLogEventV1 } from './logging.js';
import type { RateLimitDecisionV1 } from './runtimeConfig.js';
import type { LunarveilRuntimeConfigV1 } from './runtimeConfig.js';

interface ApiErrorPayload {
  readonly error: 'REQUEST_REJECTED' | 'SERVICE_UNAVAILABLE' | 'INTERNAL_ERROR';
  readonly code: string;
}

class ApiError extends Error {
  constructor(readonly statusCode: number, readonly payload: ApiErrorPayload) {
    super(payload.code);
    this.name = 'ApiError';
  }
}

export interface LunarveilApiDependencies {
  readonly sessions: Pick<InMemorySessionChallengeService, 'create' | 'verify'>;
  readonly orders: Pick<AuthenticatedOrderSubmissionServiceV1, 'submit'>;
  readonly matcherKeys: { activePublicKey(nowMs: bigint): MatcherEncryptionPublicKeyV1 };
  readonly markets: PublicMarketCatalog;
  readonly systemStatus: SanitizedSystemStatusProvider;
  readonly allocations?: EncryptedAllocationTransportV1;
  /**
   * Issues a trader's pseudonymous tag after authentication. Optional so a
   * deployment whose binding verifier needs no issued tag keeps working; when
   * absent, `/v1/sessions/verify` simply omits the field.
   */
  readonly traderTags?: { tagFor(walletIdentityHash: string): string };
  /**
   * The authenticated trader's own order history. Optional so a deployment
   * without it simply does not expose the route.
   */
  readonly orderHistory?: {
    list(input: { readonly bearerToken: string; readonly limit?: number }): Promise<readonly {
      readonly orderId: string;
      readonly clientRequestId: string;
      readonly marketId: string;
      readonly epochId: string;
      readonly commitment: string;
      readonly state: string;
      readonly createdAtMs: bigint;
      readonly acceptedAtMs: bigint | undefined;
      readonly chainAdmissionTxId: string | undefined;
      readonly leafIndex: string | undefined;
      readonly admissionSubmittedTxId?: string | undefined;
    }[]>;
  };
  /**
   * Process-local or shared/durable limiter. A durable limiter answers
   * asynchronously, so its decision is always awaited before routing.
   */
  readonly rateLimiter?: {
    consume(key: string, nowMs: bigint): RateLimitDecisionV1 | Promise<RateLimitDecisionV1>;
  };
  readonly allowedOrigins?: readonly string[];
  /**
   * Redacting structured logger. Only allowlisted request metadata is passed;
   * no body, header, envelope, token or error message ever reaches it.
   */
  readonly logger?: {
    log(event: RedactedLogEventV1): void;
    hashClient(address: string): string | undefined;
  };
  readonly nowMs: () => bigint;
}

export interface EncryptedAllocationTransportV1 {
  get(input: { readonly epochId: string; readonly bearerToken: string }): Promise<EncryptedAllocationResponseV1 | undefined>;
  receiveFirmup(input: {
    readonly epochId: string;
    readonly allocationId: string;
    readonly clientRequestId: string;
    readonly bearerToken: string;
    readonly ciphertextPayload: Uint8Array;
  }): Promise<{ readonly state: 'RECEIVED' | 'READY' | 'RECOMPUTE_REQUIRED'; readonly replayed: boolean }>;
}

export interface EncryptedAllocationResponseV1 {
  readonly envelope: AllocationEnvelopeV1;
  readonly solutionCommitment: string;
  readonly firmDeadlineMs: string;
}

export type SanitizedDependencyState = 'READY' | 'DEGRADED' | 'UNAVAILABLE' | 'PAUSED';

export interface SanitizedSystemStatusV1 {
  readonly state: SanitizedDependencyState;
  readonly components: readonly {
    readonly name: 'DATABASE' | 'MATCHER' | 'CHAIN_SOURCE' | 'PROVER' | 'KMS';
    readonly state: SanitizedDependencyState;
  }[];
}

export interface SanitizedSystemStatusProvider {
  read(): Promise<SanitizedSystemStatusV1>;
}

const DEPENDENCY_NAMES = ['DATABASE', 'MATCHER', 'CHAIN_SOURCE', 'PROVER', 'KMS'] as const;
const DEPENDENCY_STATES = new Set(['READY', 'DEGRADED', 'UNAVAILABLE', 'PAUSED']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

function sanitizedStatus(input: SanitizedSystemStatusV1): SanitizedSystemStatusV1 {
  if (!input || !DEPENDENCY_STATES.has(input.state) || !Array.isArray(input.components)
    || input.components.length > DEPENDENCY_NAMES.length) throw new Error('INVALID_STATUS');
  const names = new Set<string>();
  const components = input.components.map(component => {
    if (!component || !DEPENDENCY_NAMES.includes(component.name) || !DEPENDENCY_STATES.has(component.state)
      || names.has(component.name)) throw new Error('INVALID_STATUS');
    names.add(component.name);
    return { name: component.name, state: component.state };
  });
  const fullyReady = names.size === DEPENDENCY_NAMES.length && components.every(component => component.state === 'READY');
  return { state: input.state === 'READY' && !fullyReady ? 'DEGRADED' : input.state, components };
}

export interface PublicMarketV1 {
  readonly id: string;
  readonly marketKey: string;
  readonly baseAssetId: string;
  readonly quoteAssetId: string;
  readonly tickSizeAtomic: string;
  readonly lotSizeAtomic: string;
  readonly epochDurationSeconds: number;
  readonly maxOrdersPerEpoch: number;
  readonly minBatchPrivacy: number;
  readonly matchingRuleVersion: string;
  readonly status: 'ACTIVE' | 'ADMISSION_PAUSED' | 'SETTLEMENT_ONLY' | 'DISABLED';
}

export interface PublicEpochV1 {
  readonly id: string;
  readonly marketId: string;
  readonly sequence: string;
  readonly state: 'OPEN' | 'CLOSED' | 'PROVING' | 'PENDING_FIRMUP' | 'SETTLING' | 'FINALIZED' | 'RECOMPUTE' | 'INVALIDATED';
  readonly orderCount: number;
  readonly maxOrders: number;
  readonly scheduledCloseAtMs: string;
  readonly ruleVersion: string;
  readonly configHash: string;
}

export interface PublicMarketCatalog {
  listMarkets(): Promise<readonly PublicMarketV1[]>;
  currentEpoch(marketId: string): Promise<PublicEpochV1 | undefined>;
}

interface CreateChallengeBody {
  readonly domain: string;
  readonly walletIdentity: string;
}

interface VerifyChallengeBody {
  readonly challengeId: string;
  readonly signature: string;
  /** Hex verifying key from the wallet connector, when it supplies one. */
  readonly verifyingKey?: string;
  /** Base64url of the exact bytes the wallet reports having signed. */
  readonly signedData?: string;
}

interface SubmitOrderBody {
  readonly envelope: OrderEnvelopeV1;
  readonly clientSignature: string;
  /** Hex verifying key from the wallet connector, when it supplies one. */
  readonly verifyingKey?: string;
  /** Base64url of the exact bytes the wallet reports having signed. */
  readonly signedData?: string;
}

interface AllocationParams { readonly epochId: string; }
interface FirmupBody {
  readonly allocationId: string;
  readonly clientRequestId: string;
  readonly ciphertextPayload: string;
}

const base64UrlPattern = '^[A-Za-z0-9_-]+$';

const envelopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'version', 'clientRequestId', 'marketId', 'epochId', 'commitment', 'traderTagHash',
    'encryptionKeyId', 'algorithm', 'ephemeralPublicKey', 'salt', 'nonce', 'ciphertext',
  ],
  properties: {
    version: { const: 1 },
    clientRequestId: { type: 'string', minLength: 36, maxLength: 36 },
    marketId: { type: 'string', minLength: 1, maxLength: 128 },
    epochId: { type: 'string', minLength: 1, maxLength: 128 },
    commitment: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]+$' },
    traderTagHash: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]+$' },
    encryptionKeyId: { type: 'string', minLength: 1, maxLength: 128 },
    algorithm: { const: 'X25519-HKDF-SHA256-AES-256-GCM' },
    ephemeralPublicKey: { type: 'string', minLength: 43, maxLength: 44, pattern: base64UrlPattern },
    salt: { type: 'string', minLength: 22, maxLength: 22, pattern: base64UrlPattern },
    nonce: { type: 'string', minLength: 16, maxLength: 16, pattern: base64UrlPattern },
    ciphertext: { type: 'string', minLength: 22, maxLength: 65536, pattern: base64UrlPattern },
  },
} as const;

function decodeBase64Url(value: string): Uint8Array {
  if (!new RegExp(base64UrlPattern, 'u').test(value) || value.length % 4 === 1) {
    throw new ApiError(400, { error: 'REQUEST_REJECTED', code: 'INVALID_ENCODING' });
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length === 0) throw new ApiError(400, { error: 'REQUEST_REJECTED', code: 'INVALID_ENCODING' });
  return new Uint8Array(bytes);
}

function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new ApiError(401, { error: 'REQUEST_REJECTED', code: 'SESSION_REQUIRED' });
  }
  const token = authorization.slice('Bearer '.length);
  if (!token || !new RegExp(base64UrlPattern, 'u').test(token)) {
    throw new ApiError(401, { error: 'REQUEST_REJECTED', code: 'SESSION_REQUIRED' });
  }
  return token;
}

function sessionError(error: unknown): never {
  if (!(error instanceof SessionChallengeError)) {
    throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'SESSION_SERVICE_UNAVAILABLE' });
  }
  const statusCode = error.code === 'INVALID_DOMAIN' || error.code === 'INVALID_WALLET_IDENTITY' ? 400 : 401;
  throw new ApiError(statusCode, { error: 'REQUEST_REJECTED', code: error.code });
}

function submissionError(error: unknown): never {
  if (error instanceof AuthenticatedOrderSubmissionError) {
    const statusCode = error.code === 'SESSION_INVALID' ? 401 : error.code === 'IDENTITY_MISMATCH' ? 403 : 400;
    throw new ApiError(statusCode, { error: 'REQUEST_REJECTED', code: error.code });
  }
  throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'ORDER_SERVICE_UNAVAILABLE' });
}

function matcherKeyError(): never {
  throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'MATCHER_KEY_UNAVAILABLE' });
}

function marketError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'MARKET_CATALOG_UNAVAILABLE' });
}

function allocationError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'ALLOCATION_SERVICE_UNAVAILABLE' });
}

/**
 * Builds an injectable HTTP boundary. It deliberately has no listen call,
 * environment-secret loader, database URL, or Connector-specific verifier.
 */
export function buildLunarveilApi(
  dependencies: LunarveilApiDependencies,
  options: Partial<Pick<LunarveilRuntimeConfigV1, 'bodyLimitBytes' | 'trustProxy'>> = {},
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: options.bodyLimitBytes ?? 64 * 1024, trustProxy: options.trustProxy ?? false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send(error.payload);
    const errorRecord = typeof error === 'object' && error !== null
      ? error as { validation?: unknown; code?: unknown }
      : undefined;
    if (errorRecord?.validation !== undefined) {
      return reply.code(400).send({ error: 'REQUEST_REJECTED', code: 'VALIDATION_FAILED' });
    }
    if (errorRecord?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'REQUEST_REJECTED', code: 'REQUEST_TOO_LARGE' });
    }
    return reply.code(500).send({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'REQUEST_REJECTED', code: 'NOT_FOUND' }));
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  if (dependencies.logger !== undefined) {
    const logger = dependencies.logger;
    const startedAtMs = new WeakMap<object, number>();
    app.addHook('onRequest', async request => {
      startedAtMs.set(request, performance.now());
    });
    app.addHook('onResponse', async (request, reply) => {
      const started = startedAtMs.get(request);
      const statusCode = reply.statusCode;
      const route = request.routeOptions.url;
      const clientHash = logger.hashClient(request.ip);
      logger.log({
        level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        event: 'http.request',
        statusCode,
        // Route pattern only: a populated URL can carry caller-supplied identifiers.
        ...(route !== undefined ? { route } : {}),
        ...(METHODS.has(request.method) ? { method: request.method as 'GET' } : {}),
        ...(started !== undefined ? { durationMs: performance.now() - started } : {}),
        ...(typeof request.id === 'string' ? { requestId: request.id } : {}),
        ...(clientHash !== undefined ? { clientHash } : {}),
      });
    });
  }

  if (dependencies.rateLimiter !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      const decision = await dependencies.rateLimiter!.consume(`${request.ip}:${request.routeOptions.url}`, dependencies.nowMs());
      if (!decision.allowed) {
        reply.header('retry-after', String(decision.retryAfterSeconds));
        return reply.code(429).send({ error: 'REQUEST_REJECTED', code: 'RATE_LIMITED' });
      }
    });
  }
  if (dependencies.allowedOrigins !== undefined) {
    const allowed = new Set(dependencies.allowedOrigins);
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin !== undefined && !allowed.has(origin)) {
        return reply.code(403).send({ error: 'REQUEST_REJECTED', code: 'ORIGIN_NOT_ALLOWED' });
      }
    });
    app.register(cors, {
      origin: [...allowed],
      methods: ['GET', 'HEAD', 'POST'],
      allowedHeaders: ['authorization', 'content-type'],
      exposedHeaders: ['retry-after'],
      credentials: false,
      strictPreflight: true,
    });
  }

  app.get('/healthz', {
    schema: { response: { 200: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', const: 'ready' } } } } },
  }, async () => ({ status: 'ready' as const }));

  app.get('/readyz', async (_request, reply) => {
    try {
      const status = sanitizedStatus(await dependencies.systemStatus.read());
      const ready = status.state === 'READY' && status.components.every(component => component.state === 'READY');
      if (!ready) return reply.code(503).send({ status: 'not_ready', code: 'DEPENDENCY_NOT_READY' });
      return { status: 'ready' as const };
    } catch {
      return reply.code(503).send({ status: 'not_ready', code: 'STATUS_UNAVAILABLE' });
    }
  });

  app.get('/v1/matcher-key', async () => {
    try {
      const key = dependencies.matcherKeys.activePublicKey(dependencies.nowMs());
      return {
        version: key.version,
        keyId: key.keyId,
        algorithm: key.algorithm,
        publicKey: key.publicKey,
        activeFromMs: key.activeFromMs.toString(),
        expiresAtMs: key.expiresAtMs.toString(),
      };
    } catch {
      return matcherKeyError();
    }
  });

  app.get('/v1/markets', async () => {
    try {
      return { markets: await dependencies.markets.listMarkets() };
    } catch (error) {
      return marketError(error);
    }
  });

  app.get('/v1/system/status', async () => {
    try {
      return sanitizedStatus(await dependencies.systemStatus.read());
    } catch {
      throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'STATUS_UNAVAILABLE' });
    }
  });

  app.get<{ Params: { marketId: string } }>('/v1/markets/:marketId/epoch', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['marketId'], properties: { marketId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request) => {
    try {
      const epoch = await dependencies.markets.currentEpoch(request.params.marketId);
      if (epoch === undefined) throw new ApiError(404, { error: 'REQUEST_REJECTED', code: 'MARKET_OR_EPOCH_NOT_FOUND' });
      return epoch;
    } catch (error) {
      return marketError(error);
    }
  });

  if (dependencies.allocations !== undefined) {
    app.get<{ Params: AllocationParams }>('/v1/epochs/:epochId/allocation', {
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['epochId'], properties: { epochId: { type: 'string', minLength: 1, maxLength: 128 } } },
      },
    }, async (request) => {
      try {
        const result = await dependencies.allocations!.get({ epochId: request.params.epochId, bearerToken: bearerToken(request.headers.authorization) });
        if (result === undefined) throw new ApiError(404, { error: 'REQUEST_REJECTED', code: 'ALLOCATION_NOT_FOUND' });
        return result;
      } catch (error) {
        return allocationError(error);
      }
    });

    app.post<{ Params: AllocationParams; Body: FirmupBody }>('/v1/epochs/:epochId/firmup', {
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['epochId'], properties: { epochId: { type: 'string', minLength: 1, maxLength: 128 } } },
        body: {
          type: 'object', additionalProperties: false, required: ['allocationId', 'clientRequestId', 'ciphertextPayload'], properties: {
            allocationId: { type: 'string', minLength: 1, maxLength: 128 },
            clientRequestId: { type: 'string', minLength: 36, maxLength: 36 },
            ciphertextPayload: { type: 'string', minLength: 2, maxLength: 65536, pattern: base64UrlPattern },
          },
        },
      },
    }, async (request) => {
      const ciphertextPayload = decodeBase64Url(request.body.ciphertextPayload);
      try {
        const result = await dependencies.allocations!.receiveFirmup({
          epochId: request.params.epochId,
          allocationId: request.body.allocationId,
          clientRequestId: request.body.clientRequestId,
          bearerToken: bearerToken(request.headers.authorization),
          ciphertextPayload,
        });
        return result;
      } catch (error) {
        return allocationError(error);
      } finally {
        ciphertextPayload.fill(0);
      }
    });
  }

  app.post<{ Body: CreateChallengeBody }>('/v1/sessions/challenges', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['domain', 'walletIdentity'], properties: {
          domain: { type: 'string', minLength: 1, maxLength: 255 },
          walletIdentity: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  }, async (request) => {
    try {
      const challenge = dependencies.sessions.create(request.body);
      return {
        id: challenge.id,
        domain: challenge.domain,
        walletIdentity: challenge.walletIdentity,
        nonce: challenge.nonce,
        issuedAtMs: challenge.issuedAtMs.toString(),
        expiresAtMs: challenge.expiresAtMs.toString(),
      };
    } catch (error) {
      return sessionError(error);
    }
  });

  app.post<{ Body: VerifyChallengeBody }>('/v1/sessions/verify', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['challengeId', 'signature'], properties: {
          challengeId: { type: 'string', minLength: 1, maxLength: 128 },
          signature: { type: 'string', minLength: 1, maxLength: 4096, pattern: base64UrlPattern },
          // Both are optional so a deployment whose verifier does not need
          // them keeps working unchanged.
          verifyingKey: { type: 'string', minLength: 2, maxLength: 512, pattern: '^[0-9a-fA-F]+$' },
          signedData: { type: 'string', minLength: 1, maxLength: 8192, pattern: base64UrlPattern },
        },
      },
    },
  }, async (request) => {
    const signature = decodeBase64Url(request.body.signature);
    const signedData = request.body.signedData === undefined
      ? undefined
      : decodeBase64Url(request.body.signedData);
    try {
      const session = await dependencies.sessions.verify({
        challengeId: request.body.challengeId,
        signature,
        verifyingKey: request.body.verifyingKey,
        signedData,
      });
      // The trader tag is issued here because only this service can derive it:
      // it is an HMAC over the session identity, so a client cannot compute
      // its own and an outside observer cannot link a wallet to its orders.
      const traderTagHash = dependencies.traderTags?.tagFor(session.walletIdentityHash);
      return traderTagHash === undefined
        ? { token: session.token, expiresAtMs: session.expiresAtMs.toString() }
        : { token: session.token, expiresAtMs: session.expiresAtMs.toString(), traderTagHash };
    } catch (error) {
      return sessionError(error);
    } finally {
      signature.fill(0);
      signedData?.fill(0);
    }
  });

  if (dependencies.orderHistory !== undefined) {
    app.get<{ Querystring: { limit?: number } }>('/v1/orders', {
      schema: {
        querystring: {
          type: 'object', additionalProperties: false, properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    }, async (request) => {
      try {
        // The trader tag is derived from the session inside the service.
        // There is deliberately no way to ask for another trader's orders.
        const orders = await dependencies.orderHistory!.list({
          bearerToken: bearerToken(request.headers.authorization),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        return {
          orders: orders.map(order => ({
            orderId: order.orderId,
            clientRequestId: order.clientRequestId,
            marketId: order.marketId,
            epochId: order.epochId,
            commitment: order.commitment,
            state: order.state,
            createdAtMs: order.createdAtMs.toString(),
            ...(order.acceptedAtMs === undefined ? {} : { acceptedAtMs: order.acceptedAtMs.toString() }),
            ...(order.chainAdmissionTxId === undefined ? {} : { chainAdmissionTxId: order.chainAdmissionTxId }),
            ...(order.leafIndex === undefined ? {} : { leafIndex: order.leafIndex }),
            ...(order.admissionSubmittedTxId === undefined ? {} : { admissionSubmittedTxId: order.admissionSubmittedTxId }),
          })),
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const code = (error as { code?: unknown }).code;
        if (code === 'SESSION_INVALID') {
          throw new ApiError(401, { error: 'REQUEST_REJECTED', code: 'SESSION_INVALID' });
        }
        if (code === 'INVALID_LIMIT') {
          throw new ApiError(400, { error: 'REQUEST_REJECTED', code: 'INVALID_LIMIT' });
        }
        throw new ApiError(503, { error: 'SERVICE_UNAVAILABLE', code: 'HISTORY_UNAVAILABLE' });
      }
    });
  }

  app.post<{ Body: SubmitOrderBody }>('/v1/orders', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['envelope', 'clientSignature'], properties: {
          envelope: envelopeSchema,
          clientSignature: { type: 'string', minLength: 1, maxLength: 4096, pattern: base64UrlPattern },
          verifyingKey: { type: 'string', minLength: 2, maxLength: 512, pattern: '^[0-9a-fA-F]+$' },
          signedData: { type: 'string', minLength: 1, maxLength: 16384, pattern: base64UrlPattern },
        },
      },
    },
  }, async (request) => {
    const signature = decodeBase64Url(request.body.clientSignature);
    const signedData = request.body.signedData === undefined
      ? undefined
      : decodeBase64Url(request.body.signedData);
    try {
      const result = await dependencies.orders.submit({
        bearerToken: bearerToken(request.headers.authorization),
        envelope: request.body.envelope,
        clientSignature: signature,
        verifyingKey: request.body.verifyingKey,
        signedData,
      });
      return {
        orderId: result.record.id,
        clientRequestId: result.record.clientRequestId,
        state: result.record.state,
        replayed: result.replayed,
        createdAtMs: result.record.createdAtMs.toString(),
      };
    } catch (error) {
      return submissionError(error);
    } finally {
      signature.fill(0);
    }
  });

  return app;
}
