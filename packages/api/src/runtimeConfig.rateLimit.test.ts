import { describe, expect, it } from 'vitest';

import { InMemoryRateLimiterV1 } from './runtimeConfig.js';

describe('InMemoryRateLimiterV1', () => {
  it('allows a bounded fixed window and reports retry time without payload access', () => {
    const limiter = new InMemoryRateLimiterV1(2, 10_000n);
    expect(limiter.consume('client:/healthz', 1_000n)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume('client:/healthz', 2_000n)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.consume('client:/healthz', 3_000n)).toEqual({ allowed: false, retryAfterSeconds: 8 });
    expect(limiter.consume('client:/healthz', 11_000n)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('isolates keys and rejects invalid clock/key input', () => {
    const limiter = new InMemoryRateLimiterV1(1);
    expect(limiter.consume('a', 1n).allowed).toBe(true);
    expect(limiter.consume('b', 1n).allowed).toBe(true);
    expect(limiter.consume('', 1n)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.consume('a', -1n)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});
