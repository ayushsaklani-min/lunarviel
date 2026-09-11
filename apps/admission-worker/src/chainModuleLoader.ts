import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { OrderAdmissionChainV1 } from '@lunarveil/matcher';

interface ChainModuleV1 {
  readonly createOrderAdmissionChainV1?: () => OrderAdmissionChainV1 | Promise<OrderAdmissionChainV1>;
}

export async function loadOrderAdmissionChainV1(modulePath: string): Promise<OrderAdmissionChainV1> {
  if (!isAbsolute(modulePath)) throw new Error('CHAIN_MODULE_MUST_BE_ABSOLUTE');
  const loaded = await import(pathToFileURL(modulePath).href) as ChainModuleV1;
  if (typeof loaded.createOrderAdmissionChainV1 !== 'function') throw new Error('INVALID_CHAIN_MODULE');
  const chain = await loaded.createOrderAdmissionChainV1();
  if (!chain || typeof chain.isAdmitted !== 'function' || typeof chain.submit !== 'function') {
    throw new Error('INVALID_CHAIN_MODULE');
  }
  if (chain.close !== undefined && typeof chain.close !== 'function') throw new Error('INVALID_CHAIN_MODULE');
  return chain;
}
