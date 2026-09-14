import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PostgresOrderEnvelopeRepository } from '@lunarveil/db';
import type { OrderAdmissionPreflightV1 } from '@lunarveil/matcher';

interface PreflightModuleV1 {
  readonly createOrderAdmissionPreflightV1?: (input: {
    readonly repository: PostgresOrderEnvelopeRepository;
    readonly nowMs: () => bigint;
  }) => OrderAdmissionPreflightV1 | Promise<OrderAdmissionPreflightV1>;
}

/** Loads the operator-owned KMS/key-resolver composition without hard-coding a vendor SDK. */
export async function loadOrderAdmissionPreflightV1(
  modulePath: string,
  input: { readonly repository: PostgresOrderEnvelopeRepository; readonly nowMs: () => bigint },
): Promise<OrderAdmissionPreflightV1> {
  if (!isAbsolute(modulePath)) throw new Error('PREFLIGHT_MODULE_MUST_BE_ABSOLUTE');
  const loaded = await import(pathToFileURL(modulePath).href) as PreflightModuleV1;
  if (typeof loaded.createOrderAdmissionPreflightV1 !== 'function') throw new Error('INVALID_PREFLIGHT_MODULE');
  const preflight = await loaded.createOrderAdmissionPreflightV1(input);
  if (!preflight || typeof preflight.validate !== 'function') throw new Error('INVALID_PREFLIGHT_MODULE');
  return preflight;
}
