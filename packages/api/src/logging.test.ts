import { describe, expect, it } from 'vitest';

import { createRedactedLoggerV1, jsonLineSinkV1, sameClientHashV1, type EmittedLogEventV1 } from './logging.js';

const nowMs = () => 1_800_000_000_000n;
const key = new Uint8Array(32).fill(9);

function collector() {
  const events: EmittedLogEventV1[] = [];
  return { events, sink: (event: EmittedLogEventV1) => { events.push(event); } };
}

describe('createRedactedLoggerV1', () => {
  it('emits only allowlisted fields with a service name and timestamp', () => {
    const { events, sink } = collector();
    const logger = createRedactedLoggerV1({ sink, nowMs, clientHashKey: key });
    logger.log({
      level: 'info', event: 'http.request', route: '/v1/markets/:marketId/epoch', method: 'GET',
      statusCode: 200, durationMs: 12.7, requestId: 'req-1', clientHash: logger.hashClient('203.0.113.5')!,
    });
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual([
      'clientHash', 'durationMs', 'event', 'level', 'method', 'requestId', 'route', 'service', 'statusCode', 'timestampMs',
    ]);
    expect(events[0]).toMatchObject({
      service: 'lunarveil-api', timestampMs: '1800000000000', durationMs: 13, route: '/v1/markets/:marketId/epoch',
    });
  });

  it('drops fields that are unknown, malformed or out of range instead of emitting them', () => {
    const { events, sink } = collector();
    const logger = createRedactedLoggerV1({ sink, nowMs, clientHashKey: key });
    logger.log({
      level: 'warn', event: 'http.request',
      route: '/v1/orders?envelope=AQID', method: 'TRACE' as 'GET', statusCode: 99, durationMs: -1,
      code: 'not_a_code', requestId: 'req 1', clientHash: 'zz',
      envelope: 'AQID', authorization: 'Bearer secret', side: 'BUY',
    } as never);
    expect(events[0]).toEqual({
      timestampMs: '1800000000000', service: 'lunarveil-api', level: 'warn', event: 'http.request',
    });
  });

  it('refuses an event with an invalid level or name rather than guessing', () => {
    const { events, sink } = collector();
    const logger = createRedactedLoggerV1({ sink, nowMs, clientHashKey: key });
    logger.log({ level: 'debug' as 'info', event: 'http.request' });
    logger.log({ level: 'info', event: 'HTTP.Request' });
    logger.log({ level: 'info', event: '' });
    logger.log(undefined as never);
    expect(events).toEqual([]);
  });

  it('hashes client addresses stably per key and never emits the address', () => {
    const { events, sink } = collector();
    const logger = createRedactedLoggerV1({ sink, nowMs, clientHashKey: key });
    const hash = logger.hashClient('203.0.113.5');
    expect(hash).toMatch(/^[0-9a-f]{32}$/u);
    expect(hash).not.toContain('203');
    expect(logger.hashClient('203.0.113.5')).toBe(hash);
    expect(logger.hashClient('203.0.113.6')).not.toBe(hash);
    expect(logger.hashClient('')).toBeUndefined();
    expect(logger.hashClient('x'.repeat(65))).toBeUndefined();

    const other = createRedactedLoggerV1({ sink, nowMs, clientHashKey: new Uint8Array(32).fill(8) });
    expect(other.hashClient('203.0.113.5')).not.toBe(hash);
    expect(sameClientHashV1(hash!, logger.hashClient('203.0.113.5')!)).toBe(true);
    expect(sameClientHashV1(hash!, other.hashClient('203.0.113.5')!)).toBe(false);
    expect(events).toEqual([]);
  });

  it('generates a per-process key when none is supplied and rejects a short one', () => {
    const { sink } = collector();
    const first = createRedactedLoggerV1({ sink, nowMs });
    const second = createRedactedLoggerV1({ sink, nowMs });
    expect(first.hashClient('203.0.113.5')).not.toBe(second.hashClient('203.0.113.5'));
    expect(() => createRedactedLoggerV1({ sink, nowMs, clientHashKey: new Uint8Array(8) })).toThrow('INVALID_LOG_KEY');
  });

  it('keeps handling requests when the sink throws', () => {
    const logger = createRedactedLoggerV1({ sink() { throw new Error('disk full'); }, nowMs, clientHashKey: key });
    expect(() => logger.log({ level: 'error', event: 'http.request', statusCode: 500 })).not.toThrow();
  });

  it('writes one JSON line per event', () => {
    const lines: string[] = [];
    const logger = createRedactedLoggerV1({ sink: jsonLineSinkV1(line => lines.push(line)), nowMs, clientHashKey: key });
    logger.log({ level: 'info', event: 'http.request', statusCode: 200 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'lunarveil-api', statusCode: 200 });
  });
});
