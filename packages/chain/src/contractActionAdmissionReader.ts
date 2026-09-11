import type { ChainAdmissionQueryV1, ChainAdmissionReadV1, ChainLedgerReaderV1 } from './chainLedgerReader.js';
import type { CommitmentMembershipV1, ContractStateCommitmentIndexV1 } from './commitmentMembership.js';
import type { ContractActionSourceV1, ContractActionV1 } from './contractActionSource.js';
import { isMarketIdV1, normalizeContractAddressV1, type MarketContractRegistryV1 } from './marketContractRegistry.js';

const COMMITMENT_PATTERN = /^[0-9a-f]{64}$/u;
const TX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,255}$/u;
const LEAF_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/u;
const STATE_HEX_PATTERN = /^(?:[0-9a-f]{2})+$/u;
const DEFAULT_MAX_SEARCH_QUERIES = 64;

export type ContractActionAdmissionReaderErrorCodeV1 =
  | 'INVALID_ADMISSION_QUERY'
  | 'MARKET_CONTRACT_UNRESOLVED'
  | 'CONTRACT_ACTION_UNAVAILABLE'
  | 'INVALID_CONTRACT_ACTION'
  | 'INVALID_MEMBERSHIP_RESULT'
  | 'ADMISSION_SEARCH_EXHAUSTED'
  | 'ADMISSION_SEARCH_INCONSISTENT';

export class ContractActionAdmissionReaderError extends Error {
  constructor(readonly code: ContractActionAdmissionReaderErrorCodeV1) {
    super(code);
    this.name = 'ContractActionAdmissionReaderError';
  }
}

interface ProbeV1 {
  readonly member: boolean;
  readonly action: ContractActionV1 | undefined;
  readonly leafIndex: string | undefined;
}

function assertAction(action: ContractActionV1, address: string): void {
  if (
    typeof action !== 'object' || action === null
    || normalizeContractAddressV1(action.address) !== address
    || typeof action.stateHex !== 'string' || !STATE_HEX_PATTERN.test(action.stateHex)
    || typeof action.txId !== 'string' || !TX_ID_PATTERN.test(action.txId)
    || typeof action.blockHeight !== 'bigint' || action.blockHeight < 0n
  ) {
    throw new ContractActionAdmissionReaderError('INVALID_CONTRACT_ACTION');
  }
}

function assertMembership(result: CommitmentMembershipV1): CommitmentMembershipV1 {
  if (typeof result !== 'object' || result === null) {
    throw new ContractActionAdmissionReaderError('INVALID_MEMBERSHIP_RESULT');
  }
  if (result.member === false) return result;
  if (result.member !== true || typeof result.leafIndex !== 'string' || !LEAF_INDEX_PATTERN.test(result.leafIndex)) {
    throw new ContractActionAdmissionReaderError('INVALID_MEMBERSHIP_RESULT');
  }
  return result;
}

/**
 * Resolves an order's chain admission from the public contract-action history.
 *
 * This closes both gaps ADR-0035 recorded against the previous reader:
 *
 * 1. The market-to-contract mapping is supplied by an injected registry rather
 *    than guessed, so `marketId` resolves to a real deployed address.
 * 2. Transaction correlation no longer depends on the indexer JS client, whose
 *    tx-id correlation covers contract *deployments* only. A contract action
 *    carries its own transaction and block, so an ordinary contract call —
 *    which is what an order admission is — is correlated directly.
 *
 * ## Finding the admitting transaction
 *
 * The latest action only proves the commitment is in the *current* state; it
 * does not say which transaction put it there. Because the commitment tree is
 * append-only, "the commitment is in the state at or before height h" is
 * monotonic in h, so the admitting height is found by a galloping search
 * downward from the tip action followed by a binary search. That costs
 * O(log(distance-to-admission)) queries — a handful for a recently admitted
 * order — and is capped by `maxSearchQueries`, past which it fails closed
 * rather than hammering the indexer.
 *
 * Monotonicity is a property of the append-only tree in a *stable* view; a
 * reorg mid-search can break it. The located action is therefore re-checked
 * against the boundary height the search settled on, and a disagreeing search
 * fails closed instead of reporting an invented inclusion height.
 *
 * ## Failure semantics
 *
 * `{ present: false }` is returned only when the contract's current state is
 * decodable and genuinely does not contain the commitment — real chain
 * evidence of absence, which the reorg re-check is entitled to treat as a
 * revocation. Every other problem (unknown market, unreadable indexer,
 * undecodable state, exhausted search) throws, degrading to
 * `UNAVAILABLE`/`UNVERIFIABLE` at the consumers.
 */
export class ContractActionAdmissionReaderV1 implements ChainLedgerReaderV1 {
  private readonly maxSearchQueries: number;

  constructor(
    private readonly deps: {
      readonly registry: MarketContractRegistryV1;
      readonly actions: ContractActionSourceV1;
      readonly membership: ContractStateCommitmentIndexV1;
      readonly readTipHeight: () => Promise<bigint>;
    },
    options: { readonly maxSearchQueries?: number } = {},
  ) {
    const max = options.maxSearchQueries ?? DEFAULT_MAX_SEARCH_QUERIES;
    if (!Number.isSafeInteger(max) || max < 1) throw new Error('INVALID_MAX_SEARCH_QUERIES');
    this.maxSearchQueries = max;
  }

  async readTipHeight(): Promise<bigint> {
    return this.deps.readTipHeight();
  }

  async readAdmission(input: ChainAdmissionQueryV1): Promise<ChainAdmissionReadV1> {
    if (
      typeof input !== 'object' || input === null
      || !isMarketIdV1(input.marketId)
      || typeof input.commitment !== 'string' || !COMMITMENT_PATTERN.test(input.commitment)
    ) {
      throw new ContractActionAdmissionReaderError('INVALID_ADMISSION_QUERY');
    }

    const resolved = await this.deps.registry.resolveContractAddress(input.marketId);
    const address = normalizeContractAddressV1(resolved);
    if (address === undefined) throw new ContractActionAdmissionReaderError('MARKET_CONTRACT_UNRESOLVED');

    const latest = await this.deps.actions.readLatestAction({ address });
    // A deployed contract always has at least its own deploy action, so a
    // missing latest action means the indexer has no view of this contract —
    // not that the commitment is absent.
    if (latest === undefined) throw new ContractActionAdmissionReaderError('CONTRACT_ACTION_UNAVAILABLE');
    assertAction(latest, address);

    const latestMembership = assertMembership(
      await this.deps.membership.locate({ stateHex: latest.stateHex, commitment: input.commitment }),
    );
    if (!latestMembership.member) return { present: false };

    const cache = new Map<string, ProbeV1>();
    cache.set(latest.blockHeight.toString(), {
      member: true, action: latest, leafIndex: latestMembership.leafIndex,
    });
    let spent = 0;
    const probeAt = async (height: bigint): Promise<ProbeV1> => {
      const key = height.toString();
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      spent += 1;
      if (spent > this.maxSearchQueries) {
        throw new ContractActionAdmissionReaderError('ADMISSION_SEARCH_EXHAUSTED');
      }
      const action = await this.deps.actions.readActionAtHeight({ address, blockHeight: height });
      let probe: ProbeV1;
      if (action === undefined) {
        probe = { member: false, action: undefined, leafIndex: undefined };
      } else {
        assertAction(action, address);
        const located = assertMembership(
          await this.deps.membership.locate({ stateHex: action.stateHex, commitment: input.commitment }),
        );
        probe = located.member
          ? { member: true, action, leafIndex: located.leafIndex }
          : { member: false, action, leafIndex: undefined };
      }
      cache.set(key, probe);
      return probe;
    };

    // Gallop downward for a height where the commitment is absent, so the
    // binary search below has a proven lower bound rather than scanning from
    // genesis for every order.
    let lowestTrue = latest.blockHeight;
    let highestFalse = -1n;
    let step = 1n;
    while (lowestTrue > 0n) {
      const candidate = lowestTrue > step ? lowestTrue - step : 0n;
      const probe = await probeAt(candidate);
      if (!probe.member) { highestFalse = candidate; break; }
      lowestTrue = candidate;
      step *= 2n;
    }

    let low = highestFalse + 1n;
    let high = lowestTrue;
    while (low < high) {
      const mid = low + (high - low) / 2n;
      const probe = await probeAt(mid);
      if (probe.member) high = mid; else low = mid + 1n;
    }

    const admitting = await probeAt(low);
    if (!admitting.member || admitting.action === undefined || admitting.leafIndex === undefined) {
      throw new ContractActionAdmissionReaderError('ADMISSION_SEARCH_INCONSISTENT');
    }
    // The boundary height and the admitting action's own height must agree; if
    // they do not, the history moved under the search and the answer is not
    // trustworthy.
    if (admitting.action.blockHeight !== low) {
      throw new ContractActionAdmissionReaderError('ADMISSION_SEARCH_INCONSISTENT');
    }

    return {
      present: true,
      txId: admitting.action.txId,
      leafIndex: admitting.leafIndex,
      inclusionHeight: admitting.action.blockHeight,
    };
  }
}
