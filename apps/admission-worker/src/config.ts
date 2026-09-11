export interface AdmissionWorkerConfigV1 {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly chainModule: string;
}

export class AdmissionWorkerConfigError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AdmissionWorkerConfigError'; }
}

type Env = Readonly<Record<string, string | undefined>>;

function integer(value: string | undefined, fallback: number, min: number, max: number, code: string): number {
  if (value === undefined || value === '') return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new AdmissionWorkerConfigError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new AdmissionWorkerConfigError(code);
  return parsed;
}

export function parseAdmissionWorkerConfigV1(env: Env = process.env): AdmissionWorkerConfigV1 {
  const chainModule = env.LUNARVEIL_ADMISSION_CHAIN_MODULE?.trim();
  if (!chainModule || chainModule.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(chainModule)) {
    throw new AdmissionWorkerConfigError('INVALID_CHAIN_MODULE');
  }
  return {
    intervalMs: integer(env.LUNARVEIL_ADMISSION_INTERVAL_MS, 30_000, 1_000, 3_600_000, 'INVALID_INTERVAL'),
    batchSize: integer(env.LUNARVEIL_ADMISSION_BATCH_SIZE, 10, 1, 100, 'INVALID_BATCH_SIZE'),
    chainModule,
  };
}
