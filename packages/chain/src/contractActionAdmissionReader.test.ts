import { describe, expect, it } from 'vitest';

import {
  ContractActionAdmissionReaderError,
  ContractActionAdmissionReaderV1,
} from './contractActionAdmissionReader.js';
import type { CommitmentMembershipV1, ContractStateCommitmentIndexV1 } from './commitmentMembership.js';
import type { ContractActionSourceV1, ContractActionV1 } from './contractActionSource.js';
import { StaticMarketContractRegistryV1 } from './marketContractRegistry.js';

const ADDRESS = '5f5b5b99f645ceec4bdca5df79fbec7cc83d60b5d78007d05a23aaaffb327d91';
const registry = new StaticMarketContractRegistryV1({ 'market-1': ADDRESS });

function commitment(byte: string): string {
  return byte.repeat(32);
}

const TARGET = commitment('ab');

/**
 * Stands in for the Compact-generated ledger decoder: the serialized state is
 * a one-byte tag followed by the commitment leaves in insertion order, which
 * gives membership *and* a real leaf index without a compiler in the test.
 */
const membership: ContractStateCommitmentIndexV1 = {
  async locate(input): Promise<CommitmentMembershipV1> {
    const leaves: readonly string[] = input.stateHex.slice(2).match(/.{64}/gu) ?? [];
    const index = leaves.indexOf(input.commitment);
    return index < 0 ? { member: false } : { member: true, leafIndex: String(index) };
  },
};

interface FakeActionV1 {
  readonly height: bigint;
  readonly txId: string;
  readonly leaves: readonly string[];
}

function encode(action: FakeActionV1): ContractActionV1 {
  return {
    address: ADDRESS,
    stateHex: `00${action.leaves.join('')}`,
    txId: action.txId,
    blockHeight: action.height,
  };
}

function history(actions: readonly FakeActionV1[]): { source: ContractActionSourceV1; heightQueries: bigint[] } {
  const heightQueries: bigint[] = [];
  const ordered = [...actions].sort((left, right) => (left.height < right.height ? -1 : 1));
  return {
    heightQueries,
    source: {
      async readLatestAction() {
        const last = ordered[ordered.length - 1];
        return last === undefined ? undefined : encode(last);
      },
      async readActionAtHeight(input) {
        heightQueries.push(input.blockHeight);
        let found: FakeActionV1 | undefined;
        for (const action of ordered) {
          if (action.height <= input.blockHeight) found = action;
        }
        return found === undefined ? undefined : encode(found);
      },
    },
  };
}

function reader(
  source: ContractActionSourceV1,
  options: { readonly maxSearchQueries?: number } = {},
  index: ContractStateCommitmentIndexV1 = membership,
): ContractActionAdmissionReaderV1 {
  return new ContractActionAdmissionReaderV1(
    { registry, actions: source, membership: index, readTipHeight: async () => 730_100n },
    options,
  );
}

describe('ContractActionAdmissionReaderV1', () => {
  it('correlates the admitting transaction, leaf index and inclusion height', async () => {
    const { source } = history([
      { height: 730_000n, txId: 'deploy-tx', leaves: [] },
      { height: 730_010n, txId: 'other-tx', leaves: [commitment('11')] },
      { height: 730_027n, txId: 'admitting-tx', leaves: [commitment('11'), TARGET] },
      { height: 730_040n, txId: 'later-tx', leaves: [commitment('11'), TARGET, commitment('22')] },
    ]);

    expect(await reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET })).toEqual({
      present: true,
      txId: 'admitting-tx',
      leafIndex: '1',
      inclusionHeight: 730_027n,
    });
  });

  it('reports absence only from a decodable current state', async () => {
    const { source } = history([
      { height: 730_000n, txId: 'deploy-tx', leaves: [] },
      { height: 730_040n, txId: 'later-tx', leaves: [commitment('11')] },
    ]);

    // { present: false } is what the reorg re-check turns into REVOKED, so it
    // must only ever come from real evidence of absence.
    expect(await reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .toEqual({ present: false });
  });

  it('finds a recent admission in a handful of queries on a long chain', async () => {
    const { source, heightQueries } = history([
      { height: 1n, txId: 'deploy-tx', leaves: [] },
      { height: 730_020n, txId: 'admitting-tx', leaves: [TARGET] },
      { height: 730_025n, txId: 'later-tx', leaves: [TARGET, commitment('22')] },
    ]);

    const read = await reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET });
    expect(read).toMatchObject({ present: true, txId: 'admitting-tx', inclusionHeight: 730_020n });
    // A linear scan of 730,000 blocks would be unusable; the galloping search
    // keeps a recent admission logarithmic in the distance, not the height.
    expect(heightQueries.length).toBeLessThanOrEqual(16);
  });

  it('finds an admission in the very first block the contract was ever active in', async () => {
    const { source } = history([{ height: 0n, txId: 'genesis-tx', leaves: [TARGET] }]);
    expect(await reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET })).toEqual({
      present: true, txId: 'genesis-tx', leafIndex: '0', inclusionHeight: 0n,
    });
  });

  it('fails closed when the market has no known contract', async () => {
    const { source } = history([{ height: 5n, txId: 'tx', leaves: [TARGET] }]);
    await expect(reader(source).readAdmission({ marketId: 'market-2', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('MARKET_CONTRACT_UNRESOLVED'));
  });

  it('fails closed when the indexer has no view of the contract at all', async () => {
    const { source } = history([]);
    await expect(reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('CONTRACT_ACTION_UNAVAILABLE'));
  });

  it('rejects a malformed admission query before touching the chain', async () => {
    const { source, heightQueries } = history([{ height: 5n, txId: 'tx', leaves: [TARGET] }]);
    await expect(reader(source).readAdmission({ marketId: 'market-1', commitment: 'short' }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('INVALID_ADMISSION_QUERY'));
    await expect(reader(source).readAdmission({ marketId: '', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('INVALID_ADMISSION_QUERY'));
    expect(heightQueries).toEqual([]);
  });

  it('fails closed rather than exceeding its query budget', async () => {
    const { source } = history([
      { height: 1n, txId: 'deploy-tx', leaves: [] },
      { height: 2n, txId: 'admitting-tx', leaves: [TARGET] },
      { height: 900_000n, txId: 'later-tx', leaves: [TARGET, commitment('22')] },
    ]);
    await expect(reader(source, { maxSearchQueries: 3 }).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('ADMISSION_SEARCH_EXHAUSTED'));
  });

  it('rejects an action that does not belong to the queried contract', async () => {
    const source: ContractActionSourceV1 = {
      async readLatestAction() {
        return { address: 'ff'.repeat(32), stateHex: `00${TARGET}`, txId: 'tx', blockHeight: 10n };
      },
      async readActionAtHeight() { return undefined; },
    };
    await expect(reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('INVALID_CONTRACT_ACTION'));
  });

  it('propagates an undecodable state instead of reporting absence', async () => {
    const { source } = history([{ height: 5n, txId: 'tx', leaves: [TARGET] }]);
    const broken: ContractStateCommitmentIndexV1 = {
      async locate() { throw new Error('unsupported ledger version'); },
    };
    // Reporting { present: false } here would raise a false ADMISSION_REVOKED
    // alert for every accepted order in the re-check window.
    await expect(reader(source, {}, broken).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .rejects.toThrow('unsupported ledger version');
  });

  it('rejects a membership result that claims a leaf without a valid index', async () => {
    const { source } = history([{ height: 5n, txId: 'tx', leaves: [TARGET] }]);
    const bogus = { async locate() { return { member: true, leafIndex: '-1' } as CommitmentMembershipV1; } };
    await expect(reader(source, {}, bogus).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('INVALID_MEMBERSHIP_RESULT'));
  });

  it('fails closed when the history shifts under the search', async () => {
    // Every historical probe answers with an action from *above* the tip
    // action, which is what a view moving mid-search looks like.
    const source: ContractActionSourceV1 = {
      async readLatestAction() {
        return { address: ADDRESS, stateHex: `00${TARGET}`, txId: 'tip-tx', blockHeight: 130n };
      },
      async readActionAtHeight() {
        return { address: ADDRESS, stateHex: `00${TARGET}`, txId: 'shifted-tx', blockHeight: 200n };
      },
    };
    await expect(reader(source).readAdmission({ marketId: 'market-1', commitment: TARGET }))
      .rejects.toThrow(new ContractActionAdmissionReaderError('ADMISSION_SEARCH_INCONSISTENT'));
  });

  it('delegates the tip height to the injected reader', async () => {
    const { source } = history([{ height: 5n, txId: 'tx', leaves: [] }]);
    expect(await reader(source).readTipHeight()).toBe(730_100n);
  });
});
