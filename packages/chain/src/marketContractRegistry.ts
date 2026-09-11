/**
 * Lower-case hex, whole bytes. The verified M3 Preview deployment address is
 * 64 hex characters (32 bytes); the bounds are deliberately wider than that so
 * a future address encoding is not silently rejected, but never so wide that
 * an arbitrary string passes as an address.
 */
const CONTRACT_ADDRESS_PATTERN = /^(?:[0-9a-f]{2}){8,128}$/u;
const MARKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Normalizes case so address comparison is never case-sensitive by accident. */
export function normalizeContractAddressV1(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return CONTRACT_ADDRESS_PATTERN.test(normalized) ? normalized : undefined;
}

export function isMarketIdV1(value: unknown): value is string {
  return typeof value === 'string' && MARKET_ID_PATTERN.test(value);
}

/**
 * Resolves a market to the contract its order commitments are admitted into.
 *
 * `undefined` means "this system has no contract for that market". It is not
 * an error and not evidence about the chain: callers must fail closed on it
 * rather than treat the order as absent.
 */
export interface MarketContractRegistryV1 {
  resolveContractAddress(marketId: string): Promise<string | undefined>;
}

export class MarketContractRegistryError extends Error {
  constructor(readonly code: 'INVALID_MARKET_ID' | 'INVALID_CONTRACT_ADDRESS') {
    super(code);
    this.name = 'MarketContractRegistryError';
  }
}

/**
 * Frozen allowlist registry. Every entry is validated at construction so a
 * malformed operator-supplied address fails at startup, not mid-reconciliation.
 */
export class StaticMarketContractRegistryV1 implements MarketContractRegistryV1 {
  private readonly entries: ReadonlyMap<string, string>;

  constructor(entries: Readonly<Record<string, string>>) {
    const map = new Map<string, string>();
    for (const [marketId, address] of Object.entries(entries)) {
      if (!isMarketIdV1(marketId)) throw new MarketContractRegistryError('INVALID_MARKET_ID');
      const normalized = normalizeContractAddressV1(address);
      if (normalized === undefined) throw new MarketContractRegistryError('INVALID_CONTRACT_ADDRESS');
      map.set(marketId, normalized);
    }
    this.entries = map;
  }

  async resolveContractAddress(marketId: string): Promise<string | undefined> {
    if (!isMarketIdV1(marketId)) throw new MarketContractRegistryError('INVALID_MARKET_ID');
    return this.entries.get(marketId);
  }
}
