import { describe, expect, it } from 'vitest';

import { LunarveilRuntimeConfigError, parseLunarveilRuntimeConfigV1 } from './runtimeConfig.js';

describe('parseLunarveilRuntimeConfigV1', () => {
  it('uses safe local defaults without exposing secrets', () => {
    expect(parseLunarveilRuntimeConfigV1({})).toEqual({
      environment: 'development', host: '127.0.0.1', port: 4000, bodyLimitBytes: 65536,
      allowedOrigins: [], trustProxy: false,
    });
  });

  it('validates network settings and origins', () => {
    expect(parseLunarveilRuntimeConfigV1({ LUNARVEIL_API_PORT: '4400', LUNARVEIL_API_HOST: '0.0.0.0', LUNARVEIL_ALLOWED_ORIGINS: 'https://app.example,https://admin.example', LUNARVEIL_TRUST_PROXY: 'true' })).toMatchObject({ port: 4400, host: '0.0.0.0', trustProxy: true });
    expect(() => parseLunarveilRuntimeConfigV1({ LUNARVEIL_API_PORT: '0' })).toThrowError(new LunarveilRuntimeConfigError('INVALID_PORT'));
    expect(() => parseLunarveilRuntimeConfigV1({ LUNARVEIL_ALLOWED_ORIGINS: '*' })).toThrowError(new LunarveilRuntimeConfigError('INVALID_ORIGINS'));
  });

  it('fails closed when production dependencies are incomplete', () => {
    expect(() => parseLunarveilRuntimeConfigV1({ LUNARVEIL_ENV: 'production', LUNARVEIL_ALLOWED_ORIGINS: 'https://app.example' })).toThrowError(new LunarveilRuntimeConfigError('PRODUCTION_CONFIG_INCOMPLETE'));
    expect(() => parseLunarveilRuntimeConfigV1({ LUNARVEIL_ENV: 'qa' })).toThrowError(new LunarveilRuntimeConfigError('INVALID_ENVIRONMENT'));
    expect(() => parseLunarveilRuntimeConfigV1({ LUNARVEIL_ENV: 'staging' })).toThrowError(new LunarveilRuntimeConfigError('INVALID_ORIGINS'));
  });
});

describe('browser origin allowlist', () => {
  it('allows a loopback http origin in development only', () => {
    const development = parseLunarveilRuntimeConfigV1({
      LUNARVEIL_ENV: 'development',
      LUNARVEIL_ALLOWED_ORIGINS: 'http://127.0.0.1:3000,http://localhost:3000',
    });
    expect(development.allowedOrigins).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);

    // Without this a local frontend cannot be allowlisted at all, and the
    // browser UI is unreachable in development. Production stays https-only.
    expect(() => parseLunarveilRuntimeConfigV1({
      LUNARVEIL_ENV: 'production',
      LUNARVEIL_ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      LUNARVEIL_DATABASE_URL: 'postgresql://example.invalid/db',
      LUNARVEIL_KMS_PROVIDER: 'test',
      LUNARVEIL_CHAIN_NETWORK: 'preview',
    })).toThrow();
  });

  it('still refuses a plaintext remote origin in development', () => {
    expect(() => parseLunarveilRuntimeConfigV1({
      LUNARVEIL_ENV: 'development',
      LUNARVEIL_ALLOWED_ORIGINS: 'http://app.lunarveil.test',
    })).toThrow();
  });
});
