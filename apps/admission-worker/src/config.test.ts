import { describe, expect, it } from 'vitest';

import { parseAdmissionWorkerConfigV1 } from './config.js';

describe('parseAdmissionWorkerConfigV1', () => {
  it('uses bounded defaults with an explicit chain module', () => {
    expect(parseAdmissionWorkerConfigV1({ LUNARVEIL_ADMISSION_CHAIN_MODULE: 'C:\\runtime\\chain.mjs', LUNARVEIL_ADMISSION_PREFLIGHT_MODULE: 'C:\\runtime\\preflight.mjs' }))
      .toEqual({ intervalMs: 30_000, batchSize: 10, chainModule: 'C:\\runtime\\chain.mjs', preflightModule: 'C:\\runtime\\preflight.mjs' });
  });

  it('accepts bounded scheduler overrides', () => {
    expect(parseAdmissionWorkerConfigV1({
      LUNARVEIL_ADMISSION_CHAIN_MODULE: 'C:\\runtime\\chain.mjs',
      LUNARVEIL_ADMISSION_PREFLIGHT_MODULE: 'C:\\runtime\\preflight.mjs',
      LUNARVEIL_ADMISSION_INTERVAL_MS: '1000',
      LUNARVEIL_ADMISSION_BATCH_SIZE: '100',
    })).toMatchObject({ intervalMs: 1_000, batchSize: 100 });
  });

  it('fails closed when the chain module or bounds are invalid', () => {
    expect(() => parseAdmissionWorkerConfigV1({})).toThrowError(expect.objectContaining({ code: 'INVALID_CHAIN_MODULE' }));
    expect(() => parseAdmissionWorkerConfigV1({
      LUNARVEIL_ADMISSION_CHAIN_MODULE: 'C:\\runtime\\chain.mjs',
      LUNARVEIL_ADMISSION_PREFLIGHT_MODULE: 'C:\\runtime\\preflight.mjs',
      LUNARVEIL_ADMISSION_BATCH_SIZE: '101',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_BATCH_SIZE' }));
  });
});
