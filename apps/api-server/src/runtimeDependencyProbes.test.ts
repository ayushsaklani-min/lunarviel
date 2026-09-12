import { describe, expect, it } from 'vitest';

import { createRuntimeDependencyProbesV1 } from './runtimeDependencyProbes.js';

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('runtime dependency probes', () => {
  it('reports unavailable when optional dependency endpoints are not configured', async () => {
    const probes = createRuntimeDependencyProbesV1({});
    await expect(probes.chainSource()).resolves.toBe('UNAVAILABLE');
    await expect(probes.prover()).resolves.toBe('UNAVAILABLE');
  });

  it('accepts only a valid public indexer tip response', async () => {
    const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
    const probes = createRuntimeDependencyProbesV1({ indexerUrl: 'https://indexer.example/graphql' }, {
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        return response({ data: { block: { height: 730_027 } } });
      },
    });
    await expect(probes.chainSource()).resolves.toBe('READY');
    expect(requests).toEqual([{
      url: 'https://indexer.example/graphql',
      body: { query: '{ block { height } }' },
    }]);
  });

  it('fails closed when the indexer response is malformed or unavailable', async () => {
    const malformed = createRuntimeDependencyProbesV1({ indexerUrl: 'https://indexer.example/graphql' }, {
      fetchImpl: async () => response({ data: { block: { height: '730027' } } }),
    });
    await expect(malformed.chainSource()).resolves.toBe('DEGRADED');

    const unavailable = createRuntimeDependencyProbesV1({ indexerUrl: 'https://indexer.example/graphql' }, {
      fetchImpl: async () => { throw new Error('private transport detail'); },
    });
    await expect(unavailable.chainSource()).resolves.toBe('DEGRADED');
  });

  it('requires health, readiness and the pinned proof-server version', async () => {
    const probes = createRuntimeDependencyProbesV1({ proofServerUrl: 'https://prover.example/private/' }, {
      fetchImpl: async (url) => {
        if (url.endsWith('/health') || url.endsWith('/ready')) return response({ status: 'ok' });
        if (url.endsWith('/version')) return response('8.1.0');
        throw new Error('unexpected request');
      },
    });
    await expect(probes.prover()).resolves.toBe('READY');

    const versionDrift = createRuntimeDependencyProbesV1({ proofServerUrl: 'https://prover.example' }, {
      fetchImpl: async (url) => response(url.endsWith('/version') ? '9.0.0-rc.1' : { status: 'ok' }),
    });
    await expect(versionDrift.prover()).resolves.toBe('DEGRADED');
  });
});
