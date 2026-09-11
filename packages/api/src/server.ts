import type { FastifyInstance } from 'fastify';

import { buildLunarveilApi, type LunarveilApiDependencies } from './lunarveilApi.js';
import type { LunarveilRuntimeConfigV1 } from './runtimeConfig.js';

export interface StartedLunarveilApiV1 {
  readonly app: FastifyInstance;
  readonly address: string;
}

/** Explicit deployment composition; secret loading and TLS remain external. */
export async function startLunarveilApiV1(
  dependencies: LunarveilApiDependencies,
  config: LunarveilRuntimeConfigV1,
): Promise<StartedLunarveilApiV1> {
  // An empty allowlist means "no browser-origin enforcement configured", not
  // "allow nothing". Passing it through unconditionally installed the
  // enforcement hook with an empty allow-set, which answered 403 to every
  // request carrying an Origin header — that is, to every browser. See
  // ADR-0040.
  const originPolicy = config.allowedOrigins.length > 0
    ? { allowedOrigins: config.allowedOrigins }
    : {};
  const app = buildLunarveilApi({ ...dependencies, ...originPolicy }, {
    bodyLimitBytes: config.bodyLimitBytes,
    trustProxy: config.trustProxy,
  });
  try {
    const address = await app.listen({ host: config.host, port: config.port });
    return { app, address };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
