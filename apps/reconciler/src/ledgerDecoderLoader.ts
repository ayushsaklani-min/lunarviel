import type { ContractStateCommitmentIndexV1 } from '@lunarveil/chain';

export class LedgerDecoderLoadError extends Error {
  constructor(readonly code: 'INVALID_SPECIFIER' | 'LOAD_FAILED' | 'INVALID_EXPORT') {
    super(code);
    this.name = 'LedgerDecoderLoadError';
  }
}

/** The named export a decoder adapter module must provide. */
export const LEDGER_DECODER_EXPORT_V1 = 'createLunarveilLedgerCommitmentIndexV1';

interface DecoderModuleV1 {
  readonly [LEDGER_DECODER_EXPORT_V1]?: unknown;
}

function hasUnsafeSpecifierChar(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Loads the Compact-generated ledger decoder adapter named by
 * `LUNARVEIL_LEDGER_DECODER_MODULE`.
 *
 * The adapter lives outside this repository on purpose: decoding a serialized
 * contract state needs the generated ledger for the deployed contract, and
 * `**\/contracts/managed/` is a git-ignored build artifact. This seam lets the
 * deployment supply it without any generated code being vendored here.
 *
 * The specifier is trusted operator configuration — the same trust level as
 * `LUNARVEIL_DATABASE_URL` — and is imported as code. It is never derived from
 * a request, an order or any database row.
 *
 * Returns `undefined` when nothing is configured, which leaves the reconciler
 * on the fail-closed reader. Every other problem throws: a configured decoder
 * that will not load must stop startup rather than silently degrade to a
 * reconciler that can never accept an order.
 */
export async function loadLedgerDecoderV1(
  specifier: string | undefined,
): Promise<ContractStateCommitmentIndexV1 | undefined> {
  if (specifier === undefined || specifier.trim() === '') return undefined;
  const trimmed = specifier.trim();
  // No whitespace or control characters: a path containing spaces must
  // arrive percent-encoded in a file:// URL, which is what dynamic import
  // needs on Windows anyway.
  if (trimmed.length > 1_024 || hasUnsafeSpecifierChar(trimmed)) {
    throw new LedgerDecoderLoadError('INVALID_SPECIFIER');
  }

  let loaded: DecoderModuleV1;
  try {
    loaded = (await import(trimmed)) as DecoderModuleV1;
  } catch {
    // The underlying message can carry a resolved filesystem path.
    throw new LedgerDecoderLoadError('LOAD_FAILED');
  }

  const factory = loaded[LEDGER_DECODER_EXPORT_V1];
  if (typeof factory !== 'function') throw new LedgerDecoderLoadError('INVALID_EXPORT');

  let index: unknown;
  try {
    index = await (factory as () => unknown)();
  } catch {
    throw new LedgerDecoderLoadError('LOAD_FAILED');
  }
  if (typeof index !== 'object' || index === null || typeof (index as ContractStateCommitmentIndexV1).locate !== 'function') {
    throw new LedgerDecoderLoadError('INVALID_EXPORT');
  }
  return index as ContractStateCommitmentIndexV1;
}
