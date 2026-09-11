import type { LedgerSignatureApiV1 } from './ledgerWalletSignatureVerifier.js';

/**
 * Loads the real ledger signature primitives.
 *
 * The import is dynamic and happens once at the composition root: the module
 * is WebAssembly, and nothing that merely imports this package should pay to
 * instantiate it.
 */
export async function loadLedgerSignatureApiV1(): Promise<LedgerSignatureApiV1> {
  const ledger = await import('@midnight-ntwrk/ledger-v8');
  return {
    verifySignature: (verifyingKey, data, signature) => ledger.verifySignature(verifyingKey, data, signature),
    addressFromKey: verifyingKey => ledger.addressFromKey(verifyingKey),
  };
}
