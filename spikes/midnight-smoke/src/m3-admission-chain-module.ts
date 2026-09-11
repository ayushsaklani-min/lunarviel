import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { SucceedEntirely } from '@midnight-ntwrk/midnight-js-types';

import {
  MidnightOrderAdmissionChainV1,
  type MidnightAdmissionContractV1,
} from '@lunarveil/midnight';

import {
  assertProofServer,
  compiledContract,
  createProviders,
  prepareFundedWallet,
  readLedger,
  secretSeedFrom,
  SafeCheckpointError,
} from './m3-chain-checkpoint.js';
import { resolveNetwork, type NetworkId } from './network.js';
import { getPrivateStatePassword } from './runtime-secrets.js';

const ADMISSION_WALLET_SEED = 'LUNARVEIL_ADMISSION_WALLET_SEED';

function configuredNetwork(): Exclude<NetworkId, 'undeployed'> {
  const value = process.env.LUNARVEIL_CHAIN_NETWORK;
  if (value !== 'preview' && value !== 'preprod') {
    throw new SafeCheckpointError('LUNARVEIL_CHAIN_NETWORK must be preview or preprod.');
  }
  return value;
}

function bytes32(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new SafeCheckpointError('Invalid public commitment.');
  return new Uint8Array(Buffer.from(value, 'hex'));
}

/**
 * Deployment module loaded by apps/admission-worker. It owns one funded
 * in-memory wallet for the process lifetime and never exposes wallet state or
 * balances to the application logger.
 */
export async function createOrderAdmissionChainV1() {
  const network = configuredNetwork();
  const { config } = resolveNetwork({
    argv: ['node', 'm3-admission-chain-module', '--network', network],
    env: process.env,
  });
  setNetworkId(config.networkId);
  await assertProofServer(config);
  const seed = secretSeedFrom(ADMISSION_WALLET_SEED, network);
  let privateStatePassword: string;
  try {
    privateStatePassword = getPrivateStatePassword();
  } catch {
    throw new SafeCheckpointError('PRIVATE_STATE_PASSWORD is missing or does not satisfy the strength policy.');
  }

  const wallet = await prepareFundedWallet(network, config, seed);
  try {
    const providers = createProviders(wallet, config, privateStatePassword);
    const contracts = new Map<string, ReturnType<typeof findDeployedContract>>();
    const contractAt = async (contractAddress: string): Promise<MidnightAdmissionContractV1> => {
      let found = contracts.get(contractAddress);
      if (found === undefined) {
        found = findDeployedContract(providers, { compiledContract, contractAddress });
        contracts.set(contractAddress, found);
      }
      // Midnight.js erases the generated circuit interface to Contract.Any at
      // this generic discovery boundary. The generated M3 declaration and its
      // checked call signature are the authority for this localized cast.
      return await found as unknown as MidnightAdmissionContractV1;
    };

    const adapter = new MidnightOrderAdmissionChainV1({
      succeedEntirelyStatus: SucceedEntirely,
      contractAt,
      async isCommitmentAdmitted(contractAddress, epochSequence, commitmentHex) {
        const commitment = bytes32(commitmentHex);
        try {
          const current = await readLedger(providers.publicDataProvider, contractAddress);
          if (current.currentEpochSequence !== epochSequence) {
            throw new SafeCheckpointError('The indexed contract epoch does not match the database epoch.');
          }
          if (current.orderCommitments.findPathForLeaf(commitment)) return true;
          if (current.epochClosed) throw new SafeCheckpointError('The indexed contract epoch is already closed.');
          return false;
        } finally {
          commitment.fill(0);
        }
      },
    });

    let closed = false;
    return {
      isAdmitted: adapter.isAdmitted.bind(adapter),
      submit: adapter.submit.bind(adapter),
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await wallet.wallet.stop();
      },
    };
  } catch (error) {
    await wallet.wallet.stop();
    throw error;
  }
}
