import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { SucceedEntirely, type PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import {
  Contract,
  ledger,
} from '../contracts/managed/fair-clearing-n4/contract/index.js';
import {
  getContractDeployment,
  recordContractDeployment,
  resolveNetwork,
  setActiveNetwork,
  type NetworkConfig,
  type NetworkId,
} from './network';
import { getPrivateStatePassword } from './runtime-secrets';
import { createWallet, unshieldedToken, type WalletContext } from './wallet';

// @ts-expect-error Required by the installed indexer client for subscriptions.
globalThis.WebSocket = WebSocket;

export const CONTRACT_ID = 'lunarveil-fair-clearing-n4-v1' as const;
const INITIAL_EPOCH_SEQUENCE = 7n;
const EXPECTED_PROOF_SERVER_VERSION = '8.1.0';
const DEPLOYER_SEED = 'LUNARVEIL_M3_DEPLOYER_SEED';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'fair-clearing-n4');
const M3_MARKET_ID = domainBytes('LUNARVEIL_M3_N4_CHECKPOINT_MARKET_V1');
const M3_RULE_VERSION_HASH = domainBytes('LUNARVEIL_M3_N4_RULE_VERSION_V1');
const M3_CONFIG_HASH = domainBytes('LUNARVEIL_M3_N4_CONFIG_V1');
type M3CircuitId = 'submitOrderCommitment' | 'closeEpoch' | 'cancelOrder' | 'proveFairSolution';

export const compiledContract = CompiledContract.make(CONTRACT_ID, Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

export class SafeCheckpointError extends Error {}

function domainBytes(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function secretSeedFrom(name: string, network: NetworkId): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SafeCheckpointError(
      `${name} is required for ${network}. Inject it through the runtime environment or a secret manager.`,
    );
  }
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    throw new SafeCheckpointError(`${name} must be exactly 32 bytes encoded as 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

export async function assertProofServer(config: NetworkConfig): Promise<void> {
  const base = new URL(config.proofServer);
  const versionUrl = new URL(`${base.pathname.replace(/\/$/u, '')}/version`, base);
  let response: Response;
  try {
    response = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new SafeCheckpointError(
      'Controlled proof server is unavailable. Run `npm run midnight:proof-server:start` in another terminal.',
    );
  }
  const version = (await response.text()).trim();
  if (!response.ok || version !== EXPECTED_PROOF_SERVER_VERSION) {
    throw new SafeCheckpointError(
      `Proof server version mismatch; expected ${EXPECTED_PROOF_SERVER_VERSION}.`,
    );
  }
}

export function createProviders(
  walletCtx: WalletContext,
  networkConfig: NetworkConfig,
  privateStatePassword: string,
) {
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: Parameters<WalletContext['wallet']['balanceUnboundTransaction']>[0], ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1_000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: Parameters<WalletContext['wallet']['submitTransaction']>[0]) =>
      walletCtx.wallet.submitTransaction(tx),
  };
  const zkConfigProvider = new NodeZkConfigProvider<M3CircuitId>(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: 'midnight-level-db',
      privateStateStoreName: 'lunarveil-m3-private-state',
      signingKeyStoreName: 'lunarveil-m3-signing-keys',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

export async function prepareFundedWallet(
  network: Exclude<NetworkId, 'undeployed'>,
  networkConfig: NetworkConfig,
  seed: string,
): Promise<WalletContext> {
  const walletCtx = await createWallet({
    network, networkConfig, seed,
    syncBatchUpdates: { size: 100, timeout: 20, spacing: 0 },
  });
  console.log('  deployer: syncing Preview/Preprod wallet from the indexer (no private state is cached)');
  // Only completion flags and public ledger-event cursors may leave the wallet.
  // Never log state objects, balances, keys or transaction payloads.
  let syncFlags = { shielded: false, unshielded: false, dust: false };
  let syncCursors = { shielded: '0/0', dust: '0/0' };
  const progress = walletCtx.wallet.state().subscribe({
    next: (state) => {
      syncFlags = {
        shielded: state.shielded.state.progress.isStrictlyComplete(),
        unshielded: state.unshielded.progress.isStrictlyComplete(),
        dust: state.dust.state.progress.isStrictlyComplete(),
      };
      syncCursors = {
        shielded: `${state.shielded.state.progress.appliedIndex}/${state.shielded.state.progress.highestRelevantWalletIndex}`,
        dust: `${state.dust.state.progress.appliedIndex}/${state.dust.state.progress.highestRelevantWalletIndex}`,
      };
    },
    error: () => { /* The awaited sync below supplies the sanitized failure. */ },
  });
  const progressTimer = setInterval(() => {
    console.log(`  deployer sync complete: shielded=${syncFlags.shielded} unshielded=${syncFlags.unshielded} dust=${syncFlags.dust}`);
    console.log(`  public ledger replay cursors: shielded=${syncCursors.shielded} dust=${syncCursors.dust}`);
  }, 30_000);
  let syncTimeout: ReturnType<typeof setTimeout> | undefined;
  let synced: Awaited<ReturnType<WalletContext['wallet']['waitForSyncedState']>>;
  try {
    synced = await Promise.race([
      walletCtx.wallet.waitForSyncedState(),
      new Promise<never>((_resolve, reject) => {
        syncTimeout = setTimeout(() => reject(new SafeCheckpointError(
          'M3 wallet sync timed out before any registration or deployment; check indexer synchronization.',
        )), 30 * 60 * 1_000);
      }),
    ]);
  } catch (error) {
    await walletCtx.wallet.stop();
    throw error;
  } finally {
    clearTimeout(syncTimeout);
    clearInterval(progressTimer);
    progress.unsubscribe();
  }
  const address = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const tNight = synced.unshielded.balances[unshieldedToken().raw] ?? 0n;
  if (tNight === 0n) {
    await walletCtx.wallet.stop();
    throw new SafeCheckpointError(
      `M3 deployer is unfunded. Fund public address ${address} using ${networkConfig.faucet}, then rerun.`,
    );
  }

  const unregisteredUtxos = synced.unshielded.availableCoins.filter(
    (coin) => !coin.meta?.registeredForDustGeneration,
  );
  if (unregisteredUtxos.length > 0) {
    console.log('  deployer: registering funded NIGHT outputs for DUST generation');
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregisteredUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const registrationTxId = await walletCtx.wallet.submitTransaction(await walletCtx.wallet.finalizeRecipe(recipe));
    console.log(`  DUST registration: tx=${registrationTxId}`);
  }

  if (synced.dust.balance(new Date()) === 0n) {
    console.log('  deployer: waiting for indexed DUST generation');
    try {
      await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(
          Rx.filter((state) => state.isSynced && state.dust.balance(new Date()) > 0n),
          Rx.timeout({ first: 5 * 60 * 1_000 }),
        ),
      );
    } catch {
      await walletCtx.wallet.stop();
      throw new SafeCheckpointError('M3 deployer did not generate DUST within five minutes; rerun later.');
    }
  }
  console.log(`  deployer: synchronized and transaction-ready (${address})`);
  return walletCtx;
}

export async function readLedger(publicDataProvider: PublicDataProvider, contractAddress: string) {
  const state = await publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new SafeCheckpointError('Indexer returned no state for the recorded M3 contract.');
  return ledger(state.data);
}

function assertFreshInitialLedger(current: Awaited<ReturnType<typeof readLedger>>): void {
  if (
    current.currentEpochSequence !== INITIAL_EPOCH_SEQUENCE
    || !bytesEqual(current.marketId, M3_MARKET_ID)
    || !bytesEqual(current.ruleVersionHash, M3_RULE_VERSION_HASH)
    || !bytesEqual(current.configHash, M3_CONFIG_HASH)
    || current.nextOrderIndex !== 0n
    || current.epochClosed
    || !current.consumedOrderNullifiers.isEmpty()
    || current.fairSolutionSubmitted
  ) {
    throw new SafeCheckpointError(
      'Recorded M3 contract does not match the expected pristine N=4 checkpoint configuration.',
    );
  }
}

async function main(): Promise<void> {
  const { network, config: networkConfig } = resolveNetwork();
  if (network === 'undeployed') {
    throw new SafeCheckpointError(
      'M3 chain checkpoint requires `--network preview` or `--network preprod`; Docker devnet is excluded.',
    );
  }
  setNetworkId(networkConfig.networkId);
  const recordedDeployment = getContractDeployment(network, CONTRACT_ID);
  if (recordedDeployment) {
    const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
    const current = await readLedger(publicDataProvider, recordedDeployment.address);
    assertFreshInitialLedger(current);
    const deploymentTx = await publicDataProvider.watchForDeployTxData(recordedDeployment.address);
    if (deploymentTx.status !== SucceedEntirely) {
      throw new SafeCheckpointError('Recorded M3 deployment did not succeed entirely.');
    }
    console.log(`  deploy: tx=${deploymentTx.txId} block=${deploymentTx.blockHeight} status=${deploymentTx.status}`);
    console.log(`M3 N=4 deployment checkpoint verified: network=${network} contract=${recordedDeployment.address}`);
    return;
  }
  if (process.argv.includes('--verify-only')) {
    throw new SafeCheckpointError('No recorded M3 deployment exists; verification cannot submit a transaction.');
  }
  const seed = secretSeedFrom(DEPLOYER_SEED, network);
  let privateStatePassword: string;
  try {
    privateStatePassword = getPrivateStatePassword();
  } catch {
    throw new SafeCheckpointError(
      'PRIVATE_STATE_PASSWORD is required and must satisfy the configured strength policy.',
    );
  }

  await assertProofServer(networkConfig);
  setActiveNetwork(network);
  console.log(`Lunarveil M3 N=4 deployment checkpoint: ${network}`);

  let wallet: WalletContext | undefined;
  try {
    wallet = await prepareFundedWallet(network, networkConfig, seed);
    const providers = createProviders(wallet, networkConfig, privateStatePassword);
    const deployerAddress = wallet.unshieldedKeystore.getBech32Address().toString();

    let deployment = getContractDeployment(network, CONTRACT_ID);
    if (!deployment) {
      console.log('  deploy: preparing M3 N=4 contract transaction');
      let deployed;
      try {
        deployed = await deployContract(providers, {
          compiledContract,
          args: [INITIAL_EPOCH_SEQUENCE, M3_MARKET_ID, M3_RULE_VERSION_HASH, M3_CONFIG_HASH],
        });
      } catch {
        throw new SafeCheckpointError(
          'M3 deployment failed with an uncertain outcome. Do not retry automatically; reconcile the public chain first.',
        );
      }
      if (deployed.deployTxData.public.status !== SucceedEntirely) {
        throw new SafeCheckpointError(
          `M3 deployment finalized with status ${deployed.deployTxData.public.status}; state was not accepted.`,
        );
      }
      const contractAddress = deployed.deployTxData.public.contractAddress;
      recordContractDeployment(network, CONTRACT_ID, contractAddress, deployerAddress);
      deployment = getContractDeployment(network, CONTRACT_ID);
      if (!deployment) throw new SafeCheckpointError('Public deployment metadata was not recorded.');
      console.log(`  deploy: tx=${deployed.deployTxData.public.txId} block=${deployed.deployTxData.public.blockHeight}`);
    }

    const current = await readLedger(providers.publicDataProvider, deployment.address);
    assertFreshInitialLedger(current);
    console.log(`M3 N=4 deployment checkpoint verified: contract=${deployment.address}`);
  } finally {
    await wallet?.wallet.stop();
  }
}

function isMain(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  main().catch((error: unknown) => {
    const message = error instanceof SafeCheckpointError
      ? error.message
      : 'M3 chain checkpoint failed; private SDK details were suppressed.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
