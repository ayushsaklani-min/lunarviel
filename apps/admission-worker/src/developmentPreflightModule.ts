import type { PostgresOrderEnvelopeRepository } from '@lunarveil/db';
import {
  M3AdmissionPreflightV1,
  SharedDevelopmentMatcherKeyStoreV1,
  type OrderAdmissionPreflightV1,
} from '@lunarveil/matcher';

const HEX_32 = /^(?:[0-9a-fA-F]{2}){32}$/u;

/**
 * Local-development composition only. The shared seed is intentionally
 * rejected outside `NODE_ENV=development`; hosted deployments must provide a
 * dedicated KMS-backed preflight module instead.
 */
export async function createOrderAdmissionPreflightV1(input: {
  readonly repository: PostgresOrderEnvelopeRepository;
  readonly nowMs: () => bigint;
}): Promise<OrderAdmissionPreflightV1> {
  if (process.env.NODE_ENV !== 'development') throw new Error('DEVELOPMENT_PREFLIGHT_REFUSED');
  const seedHex = process.env.LUNARVEIL_MATCHER_SHARED_SEED?.trim();
  const keyId = process.env.LUNARVEIL_MATCHER_KEY_ID?.trim();
  if (seedHex === undefined || !HEX_32.test(seedHex) || keyId === undefined || keyId === '') {
    throw new Error('DEVELOPMENT_PREFLIGHT_CONFIG_INVALID');
  }
  const now = input.nowMs();
  const store = await SharedDevelopmentMatcherKeyStoreV1.create({
    environment: 'development', seedHex, keyId,
    activeFromMs: 0n,
    expiresAtMs: now + 86_400_000n,
  });
  return new M3AdmissionPreflightV1(input.repository, {
    resolveExistingEnvelopeKey: async requestedKeyId => ({
      ...store.activePublicKey(input.nowMs()),
      privateKey: await store.resolvePrivateKey({ keyId: requestedKeyId, privateKeyRef: store.privateKeyRef }),
    }),
  }, input.nowMs);
}
