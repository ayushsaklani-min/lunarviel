import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { SucceedEntirely, type FinalizedTxData, type PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import {
  Contract,
  ledger,
  pureCircuits,
  type OrderIntentV1,
} from '../contracts/managed/order-commitment/contract/index.js';
import {
  getContractDeployment,
  recordContractDeployment,
  resolveNetwork,
  setActiveNetwork,
  type NetworkConfig,
  type NetworkId,
} from './network';
import {
  admissionIsApplied,
  cancellationIsApplied,
  closeIsApplied,
} from './m2-reconciliation';
import { getPrivateStatePassword } from './runtime-secrets';
import { createWallet, unshieldedToken, type WalletContext } from './wallet';

// @ts-expect-error Required by the installed indexer client for subscriptions.
globalThis.WebSocket = WebSocket;

const CONTRACT_ID = 'lunarveil-order-commitment-v1' as const;
const INITIAL_EPOCH_SEQUENCE = 7n;
const EXPECTED_PROOF_SERVER_VERSION = '8.1.0';
const WALLET_A_SEED = 'LUNARVEIL_M2_WALLET_A_SEED';
const WALLET_B_SEED = 'LUNARVEIL_M2_WALLET_B_SEED';
type M2CircuitId = 'submitOrderCommitment' | 'closeEpoch' | 'cancelOrder';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'order-commitment');

const compiledContract = CompiledContract.make(CONTRACT_ID, Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

class SafeCheckpointError extends Error {}

function secretSeedFrom(name: string, network: NetworkId): string {
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

function random32(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

function domainBytes(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

function makeOrder(ownerSecret: Uint8Array, side: boolean): OrderIntentV1 {
  const createdAtMs = BigInt(Date.now());
  return {
    version: 1n,
    marketId: domainBytes('LUNARVEIL_M2_CHAIN_CHECKPOINT_MARKET'),
    epochSequence: INITIAL_EPOCH_SEQUENCE,
    ownerPublicKey: pureCircuits.deriveOwnerAuthorization(ownerSecret),
    side,
    orderType: 0n,
    quantityLots: 100n,
    limitPriceTicks: side ? 41_900n : 42_100n,
    minFillLots: 25n,
    tif: 0n,
    allowPartial: true,
    nonce: random32(),
    createdAtMs,
    expiresAtMs: createdAtMs + 3_600_000n,
  };
}

function logFinalized(label: string, tx: FinalizedTxData): void {
  if (tx.status !== SucceedEntirely) {
    throw new SafeCheckpointError(`${label} finalized with status ${tx.status}; state was not accepted.`);
  }
  console.log(`  ${label}: tx=${tx.txId} block=${tx.blockHeight}`);
}

async function assertProofServer(config: NetworkConfig): Promise<void> {
  const base = new URL(config.proofServer);
  const versionUrl = new URL(`${base.pathname.replace(/\/$/u, '')}/version`, base);
  let response: Response;
  try {
    response = await fetch(versionUrl, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new SafeCheckpointError(
      'Controlled proof server is unavailable. Run `npm run proof-server:start` in another terminal.',
    );
  }
  const version = (await response.text()).trim();
  if (!response.ok || version !== EXPECTED_PROOF_SERVER_VERSION) {
    throw new SafeCheckpointError(
      `Proof server version mismatch; expected ${EXPECTED_PROOF_SERVER_VERSION}.`,
    );
  }
}

function createProviders(
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
  const zkConfigProvider = new NodeZkConfigProvider<M2CircuitId>(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: 'midnight-level-db',
      privateStateStoreName: 'lunarveil-m2-private-state',
      signingKeyStoreName: 'lunarveil-m2-signing-keys',
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

async function prepareFundedWallet(
  label: string,
  network: Exclude<NetworkId, 'undeployed'>,
  networkConfig: NetworkConfig,
  seed: string,
): Promise<WalletContext> {
  const walletCtx = await createWallet({ network, networkConfig, seed });
  const synced = await walletCtx.wallet.waitForSyncedState();
  const address = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const tNight = synced.unshielded.balances[unshieldedToken().raw] ?? 0n;
  if (tNight === 0n) {
    await walletCtx.wallet.stop();
    throw new SafeCheckpointError(
      `${label} is unfunded. Fund public address ${address} using ${networkConfig.faucet}, then rerun.`,
    );
  }

  const unregisteredUtxos = synced.unshielded.availableCoins.filter(
    (coin) => !coin.meta?.registeredForDustGeneration,
  );
  if (unregisteredUtxos.length > 0) {
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregisteredUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
    const txId = await walletCtx.wallet.submitTransaction(finalized);
    console.log(`  ${label}: submitted DUST registration tx=${txId}`);
  }

  if (synced.dust.balance(new Date()) === 0n) {
    try {
      await Rx.firstValueFrom(
        walletCtx.wallet.state().pipe(
          Rx.filter((state) => state.isSynced && state.dust.balance(new Date()) > 0n),
          Rx.timeout({ first: 5 * 60 * 1_000 }),
        ),
      );
    } catch {
      await walletCtx.wallet.stop();
      throw new SafeCheckpointError(`${label} did not generate DUST within five minutes; rerun later.`);
    }
  }
  console.log(`  ${label}: synchronized and transaction-ready (${address})`);
  return walletCtx;
}

async function readLedger(publicDataProvider: PublicDataProvider, contractAddress: string) {
  const state = await publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new SafeCheckpointError('Indexer returned no state for the recorded M2 contract.');
  return ledger(state.data);
}

async function waitForApplied(
  predicate: () => Promise<boolean>,
  attempts = 12,
  delayMs = 5_000,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function submitWithReconciliation(
  label: string,
  submit: () => Promise<{ public: FinalizedTxData }>,
  isApplied: () => Promise<boolean>,
): Promise<void> {
  if (await isApplied()) {
    console.log(`  ${label}: already applied; reconciled from indexed state`);
    return;
  }
  try {
    const tx = await submit();
    logFinalized(label, tx.public);
  } catch {
    if (await waitForApplied(isApplied)) {
      console.log(`  ${label}: submission outcome reconciled from indexed state`);
      return;
    }
    throw new SafeCheckpointError(
      `${label} failed and indexed state does not show the requested effect; private SDK details were suppressed.`,
    );
  }
  if (!(await waitForApplied(isApplied))) {
    throw new SafeCheckpointError(`${label} finalized but its effect was not found in indexed state.`);
  }
}

async function expectRejected(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    console.log(`  ${label}: rejected as required`);
    return;
  }
  throw new SafeCheckpointError(`${label} unexpectedly succeeded.`);
}

async function main(): Promise<void> {
  const { network, config: networkConfig } = resolveNetwork();
  if (network === 'undeployed') {
    throw new SafeCheckpointError(
      'M2 chain checkpoint requires `--network preview` or `--network preprod`; Docker devnet is excluded.',
    );
  }
  const seedA = secretSeedFrom(WALLET_A_SEED, network);
  const seedB = secretSeedFrom(WALLET_B_SEED, network);
  if (seedA === seedB) throw new SafeCheckpointError('M2 wallet A and wallet B seeds must be distinct.');
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
  console.log(`Lunarveil M2 chain checkpoint: ${network}`);

  let walletA: WalletContext | undefined;
  let walletB: WalletContext | undefined;
  const ownerSecretA = random32();
  const ownerSecretB = random32();
  const blindingA = random32();
  const blindingB = random32();
  const admissionRequestA = random32();
  const admissionRequestB = random32();
  const closeRequest = random32();
  const cancelRequest = random32();
  const orderA = makeOrder(ownerSecretA, false);
  const orderB = makeOrder(ownerSecretB, true);

  try {
    walletA = await prepareFundedWallet('wallet A', network, networkConfig, seedA);
    walletB = await prepareFundedWallet('wallet B', network, networkConfig, seedB);
    const providersA = createProviders(walletA, networkConfig, privateStatePassword);
    const providersB = createProviders(walletB, networkConfig, privateStatePassword);
    const deployerAddress = walletA.unshieldedKeystore.getBech32Address().toString();

    let deployment = getContractDeployment(network, CONTRACT_ID);
    if (!deployment) {
      let deployed;
      try {
        deployed = await deployContract(providersA, {
          compiledContract,
          args: [INITIAL_EPOCH_SEQUENCE],
        });
      } catch {
        throw new SafeCheckpointError(
          'M2 deployment failed with an uncertain outcome. Do not retry automatically; reconcile the public chain first.',
        );
      }
      logFinalized('deploy', deployed.deployTxData.public);
      const contractAddress = deployed.deployTxData.public.contractAddress;
      recordContractDeployment(network, CONTRACT_ID, contractAddress, deployerAddress);
      deployment = getContractDeployment(network, CONTRACT_ID);
      if (!deployment) throw new SafeCheckpointError('Public deployment metadata was not recorded.');
    }

    const contractAddress = deployment.address;
    const initialLedger = await readLedger(providersA.publicDataProvider, contractAddress);
    if (initialLedger.currentEpochSequence !== INITIAL_EPOCH_SEQUENCE) {
      throw new SafeCheckpointError('Recorded contract has the wrong epoch sequence.');
    }
    if (initialLedger.epochClosed) {
      throw new SafeCheckpointError('Recorded M2 checkpoint contract is already closed; use a fresh deployment.');
    }
    if (initialLedger.nextOrderIndex !== 0n || !initialLedger.consumedOrderNullifiers.isEmpty()) {
      throw new SafeCheckpointError(
        'Recorded M2 checkpoint contract is not pristine; reconcile it manually and use a fresh deployment.',
      );
    }

    const contractA = await findDeployedContract(providersA, { compiledContract, contractAddress });
    const contractB = await findDeployedContract(providersB, { compiledContract, contractAddress });
    const commitmentA = pureCircuits.deriveOrderCommitment(orderA, blindingA);
    const commitmentB = pureCircuits.deriveOrderCommitment(orderB, blindingB);

    const admissionApplied = (commitment: Uint8Array) => async () => {
      const current = await readLedger(providersA.publicDataProvider, contractAddress);
      return admissionIsApplied(current, commitment);
    };
    await submitWithReconciliation(
      'wallet A admission',
      () => contractA.callTx.submitOrderCommitment(
        INITIAL_EPOCH_SEQUENCE,
        commitmentA,
        admissionRequestA,
      ),
      admissionApplied(commitmentA),
    );
    await submitWithReconciliation(
      'wallet B admission',
      () => contractB.callTx.submitOrderCommitment(
        INITIAL_EPOCH_SEQUENCE,
        commitmentB,
        admissionRequestB,
      ),
      admissionApplied(commitmentB),
    );

    const beforeClose = await readLedger(providersA.publicDataProvider, contractAddress);
    const frozenRoot = beforeClose.orderCommitments.root();
    const closeApplied = async () => {
      const current = await readLedger(providersA.publicDataProvider, contractAddress);
      return closeIsApplied(current, frozenRoot, closeRequest);
    };
    await submitWithReconciliation(
      'epoch close',
      () => contractA.callTx.closeEpoch(INITIAL_EPOCH_SEQUENCE, frozenRoot, closeRequest),
      closeApplied,
    );

    const closedLedger = await readLedger(providersA.publicDataProvider, contractAddress);
    const pathA = closedLedger.orderCommitments.findPathForLeaf(commitmentA);
    if (!pathA) throw new SafeCheckpointError('Wallet A commitment is absent from the frozen indexed root.');
    const leafIndexA = 0n;
    const expectedNullifier = pureCircuits.deriveOrderNullifier(commitmentA, ownerSecretA);
    const cancellationApplied = async () => {
      const current = await readLedger(providersA.publicDataProvider, contractAddress);
      return cancellationIsApplied(current, expectedNullifier);
    };
    await submitWithReconciliation(
      'wallet A cancellation',
      () => contractA.callTx.cancelOrder(
        orderA,
        blindingA,
        pathA,
        leafIndexA,
        ownerSecretA,
        cancelRequest,
      ),
      cancellationApplied,
    );

    await expectRejected('post-close admission', () => contractB.callTx.submitOrderCommitment(
      INITIAL_EPOCH_SEQUENCE,
      random32(),
      random32(),
    ));
    await expectRejected('cancellation replay', () => contractA.callTx.cancelOrder(
      orderA,
      blindingA,
      pathA,
      leafIndexA,
      ownerSecretA,
      cancelRequest,
    ));

    const finalLedger = await readLedger(providersA.publicDataProvider, contractAddress);
    if (
      finalLedger.closedOrderCount !== 2n
      || finalLedger.closedStartIndex !== 0n
      || finalLedger.closedEndIndexExclusive !== 2n
      || !finalLedger.epochClosed
      || !finalLedger.consumedOrderNullifiers.member(expectedNullifier)
    ) {
      throw new SafeCheckpointError('Final indexed M2 state does not satisfy checkpoint invariants.');
    }
    console.log(`M2 chain checkpoint verified: contract=${contractAddress}`);
  } finally {
    await Promise.allSettled([walletA?.wallet.stop(), walletB?.wallet.stop()].filter(Boolean));
    for (const secret of [
      ownerSecretA,
      ownerSecretB,
      blindingA,
      blindingB,
      admissionRequestA,
      admissionRequestB,
      closeRequest,
      cancelRequest,
      orderA.nonce,
      orderB.nonce,
    ]) {
      secret.fill(0);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof SafeCheckpointError
    ? error.message
    : 'M2 chain checkpoint failed; private SDK details were suppressed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
