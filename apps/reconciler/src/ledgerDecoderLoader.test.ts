import { describe, expect, it } from 'vitest';

import { LedgerDecoderLoadError, loadLedgerDecoderV1 } from './ledgerDecoderLoader.js';

/** A decoder adapter is an ordinary ES module; a data: URL is one here. */
function moduleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const VALID_MODULE = moduleUrl(`
  export const createLunarveilLedgerCommitmentIndexV1 = () => ({
    locate: async ({ commitment }) =>
      commitment === 'ab'.repeat(32) ? { member: true, leafIndex: '2' } : { member: false },
  });
`);

describe('loadLedgerDecoderV1', () => {
  it('returns undefined when no decoder is configured', async () => {
    expect(await loadLedgerDecoderV1(undefined)).toBeUndefined();
    expect(await loadLedgerDecoderV1('')).toBeUndefined();
    expect(await loadLedgerDecoderV1('   ')).toBeUndefined();
  });

  it('loads a decoder adapter and returns a usable commitment index', async () => {
    const index = await loadLedgerDecoderV1(VALID_MODULE);
    expect(index).toBeDefined();
    expect(await index?.locate({ stateHex: 'aabb', commitment: 'ab'.repeat(32) }))
      .toEqual({ member: true, leafIndex: '2' });
    expect(await index?.locate({ stateHex: 'aabb', commitment: 'cd'.repeat(32) }))
      .toEqual({ member: false });
  });

  it('rejects a specifier containing whitespace or control characters', async () => {
    await expect(loadLedgerDecoderV1('file:///decoder with space.js'))
      .rejects.toThrow(new LedgerDecoderLoadError('INVALID_SPECIFIER'));
    await expect(loadLedgerDecoderV1('a'.repeat(1_025)))
      .rejects.toThrow(new LedgerDecoderLoadError('INVALID_SPECIFIER'));
  });

  it('stops startup when a configured decoder cannot be loaded', async () => {
    // Silently continuing would leave a reconciler that can never accept an
    // order while looking correctly configured.
    await expect(loadLedgerDecoderV1('file:///definitely/missing/decoder.mjs'))
      .rejects.toThrow(new LedgerDecoderLoadError('LOAD_FAILED'));
  });

  it('never echoes the underlying module resolution error', async () => {
    const error = await loadLedgerDecoderV1('file:///c:/secret-path/decoder.mjs').catch((thrown: unknown) => thrown);
    expect(String(error)).not.toContain('secret-path');
  });

  it('rejects a module missing the required export', async () => {
    await expect(loadLedgerDecoderV1(moduleUrl('export const somethingElse = 1;')))
      .rejects.toThrow(new LedgerDecoderLoadError('INVALID_EXPORT'));
  });

  it('rejects a factory that does not return a commitment index', async () => {
    await expect(loadLedgerDecoderV1(moduleUrl(
      'export const createLunarveilLedgerCommitmentIndexV1 = () => ({ notLocate: 1 });',
    ))).rejects.toThrow(new LedgerDecoderLoadError('INVALID_EXPORT'));
  });

  it('treats a throwing factory as a load failure rather than a partial decoder', async () => {
    await expect(loadLedgerDecoderV1(moduleUrl(
      'export const createLunarveilLedgerCommitmentIndexV1 = () => { throw new Error("no keys"); };',
    ))).rejects.toThrow(new LedgerDecoderLoadError('LOAD_FAILED'));
  });
});
