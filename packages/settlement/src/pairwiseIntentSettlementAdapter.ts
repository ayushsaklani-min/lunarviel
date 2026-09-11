import type { ConnectedAPI, HistoryEntry } from '@midnight-ntwrk/dapp-connector-api';

import { SettlementError, sanitizeConnectorError } from './errors.js';
import { fingerprintOpaquePayload } from './fingerprint.js';
import type {
  FirmupRequest,
  PairwiseAdapterOptions,
  PairwiseWallets,
  ParticipantPayload,
  PrivatePairwiseAllocationV1,
  ReconciliationResult,
  SettlementAdapter,
  SettlementReadiness,
  SettlementState,
  SubmissionReceipt,
  WalletHistorySnapshot,
} from './types.js';
import { assertPairwiseAllocation, assertRequestId } from './validation.js';

const DEFAULT_MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;
const DEFAULT_HISTORY_PAGE_SIZE = 100;

function historySnapshot(entries: readonly HistoryEntry[]): WalletHistorySnapshot {
  return new Map(entries.map(entry => [entry.txHash, entry]));
}

function executionSucceeded(entry: HistoryEntry): boolean {
  if (entry.txStatus.status !== 'confirmed' && entry.txStatus.status !== 'finalized') return false;
  return Object.values(entry.txStatus.executionStatus).every(status => status === 'Success');
}

export class PairwiseIntentSettlementAdapter implements SettlementAdapter {
  readonly #allocation: PrivatePairwiseAllocationV1;
  readonly #wallets: PairwiseWallets;
  readonly #maxSerializedTransactionBytes: number;
  readonly #historyPageSize: number;

  #state: SettlementState = 'CREATED';
  #initiatorRequestId?: string;
  #counterpartyRequestId?: string;
  #submissionRequestId?: string;
  #firmupRequest: FirmupRequest | undefined;
  #finalTransaction: string | undefined;
  #finalFingerprint: string | undefined;
  #historyBeforeSubmission: WalletHistorySnapshot | undefined;
  #receipt: SubmissionReceipt | undefined;

  constructor(
    allocation: PrivatePairwiseAllocationV1,
    wallets: PairwiseWallets,
    options: PairwiseAdapterOptions = {},
  ) {
    assertPairwiseAllocation(allocation);
    this.#allocation = allocation;
    this.#wallets = wallets;
    this.#maxSerializedTransactionBytes = options.maxSerializedTransactionBytes ?? DEFAULT_MAX_TRANSACTION_BYTES;
    this.#historyPageSize = options.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
    if (!Number.isSafeInteger(this.#maxSerializedTransactionBytes) || this.#maxSerializedTransactionBytes < 1) {
      throw new SettlementError('INVALID_ALLOCATION');
    }
    if (!Number.isSafeInteger(this.#historyPageSize) || this.#historyPageSize < 1) {
      throw new SettlementError('INVALID_ALLOCATION');
    }
  }

  state(): SettlementState {
    return this.#state;
  }

  async #assertWalletNetwork(wallet: ConnectedAPI): Promise<void> {
    const [status, configuration] = await Promise.all([
      wallet.getConnectionStatus(),
      wallet.getConfiguration(),
    ]);
    if (status.status !== 'connected') throw new SettlementError('WALLET_DISCONNECTED');
    if (
      status.networkId !== this.#allocation.networkId ||
      configuration.networkId !== this.#allocation.networkId
    ) {
      throw new SettlementError('NETWORK_MISMATCH');
    }
  }

  #assertOpaqueTransaction(transaction: string): void {
    const length = new TextEncoder().encode(transaction).byteLength;
    if (length === 0 || length > this.#maxSerializedTransactionBytes) {
      throw new SettlementError('WALLET_RESPONSE_INVALID');
    }
  }

  async createFirmupRequest(clientRequestId: string): Promise<FirmupRequest> {
    assertRequestId(clientRequestId);
    if (this.#firmupRequest !== undefined) {
      if (this.#initiatorRequestId !== clientRequestId) {
        throw new SettlementError('IDEMPOTENCY_CONFLICT');
      }
      return this.#firmupRequest;
    }
    if (this.#state !== 'CREATED') throw new SettlementError('INVALID_STATE');

    try {
      await this.#assertWalletNetwork(this.#wallets.initiator);
      await this.#wallets.initiator.hintUsage(['makeIntent']);
      const { tx } = await this.#wallets.initiator.makeIntent(
        [this.#allocation.initiatorInput],
        [this.#allocation.initiatorOutput],
        { intentId: 'random', payFees: false },
      );
      this.#assertOpaqueTransaction(tx);
      const request: FirmupRequest = {
        version: 1,
        sessionId: this.#allocation.sessionId,
        initiatorRequestId: clientRequestId,
        opaqueTransaction: tx,
        payloadFingerprint: await fingerprintOpaquePayload(tx),
      };
      this.#initiatorRequestId = clientRequestId;
      this.#firmupRequest = request;
      this.#state = 'COLLECTING';
      return request;
    } catch (error) {
      if (error instanceof SettlementError) throw error;
      throw sanitizeConnectorError(error);
    }
  }

  async acceptParticipantPayload(payload: ParticipantPayload): Promise<void> {
    assertRequestId(payload.counterpartyRequestId);
    if (this.#state === 'READY') {
      if (this.#counterpartyRequestId !== payload.counterpartyRequestId) {
        throw new SettlementError('IDEMPOTENCY_CONFLICT');
      }
      return;
    }
    if (this.#state !== 'COLLECTING' || this.#firmupRequest === undefined) {
      throw new SettlementError('INVALID_STATE');
    }
    if (
      payload.version !== 1 ||
      payload.sessionId !== this.#allocation.sessionId ||
      payload.opaqueTransaction !== this.#firmupRequest.opaqueTransaction ||
      payload.payloadFingerprint !== this.#firmupRequest.payloadFingerprint ||
      await fingerprintOpaquePayload(payload.opaqueTransaction) !== payload.payloadFingerprint
    ) {
      throw new SettlementError('INVALID_PARTICIPANT_PAYLOAD');
    }

    try {
      await this.#assertWalletNetwork(this.#wallets.counterparty);
      await this.#wallets.counterparty.hintUsage([
        'balanceSealedTransaction',
        'submitTransaction',
        'getTxHistory',
      ]);
      const { tx } = await this.#wallets.counterparty.balanceSealedTransaction(
        payload.opaqueTransaction,
        { payFees: true },
      );
      this.#assertOpaqueTransaction(tx);
      const finalFingerprint = await fingerprintOpaquePayload(tx);
      if (finalFingerprint === payload.payloadFingerprint) {
        throw new SettlementError('WALLET_RESPONSE_INVALID');
      }
      this.#counterpartyRequestId = payload.counterpartyRequestId;
      this.#finalTransaction = tx;
      this.#finalFingerprint = finalFingerprint;
      this.#state = 'READY';
    } catch (error) {
      if (error instanceof SettlementError) throw error;
      throw sanitizeConnectorError(error);
    }
  }

  async readiness(): Promise<SettlementReadiness> {
    if (this.#state === 'READY') return 'READY';
    if (this.#state === 'FAILED_FINAL') return 'INVALID';
    return 'COLLECTING';
  }

  async submitAtomicSettlement(clientRequestId: string): Promise<SubmissionReceipt> {
    assertRequestId(clientRequestId);
    if (this.#receipt !== undefined) {
      if (this.#submissionRequestId !== clientRequestId) {
        throw new SettlementError('IDEMPOTENCY_CONFLICT');
      }
      return this.#receipt;
    }
    if (
      this.#state !== 'READY' ||
      this.#finalTransaction === undefined ||
      this.#finalFingerprint === undefined
    ) {
      throw new SettlementError('INVALID_STATE');
    }

    try {
      const history = await this.#wallets.counterparty.getTxHistory(0, this.#historyPageSize);
      this.#historyBeforeSubmission = historySnapshot(history);
      await this.#wallets.counterparty.submitTransaction(this.#finalTransaction);
      this.#submissionRequestId = clientRequestId;
      this.#receipt = {
        sessionId: this.#allocation.sessionId,
        submissionFingerprint: this.#finalFingerprint,
      };
      this.#finalTransaction = undefined;
      this.#state = 'SUBMITTED';
      return this.#receipt;
    } catch (error) {
      // Submission outcome may be uncertain. Never retry automatically with another key.
      this.#state = 'FAILED_RECOVERABLE';
      if (error instanceof SettlementError) throw error;
      throw sanitizeConnectorError(error);
    }
  }

  async reconcile(): Promise<ReconciliationResult> {
    if (
      (this.#state !== 'SUBMITTED' && this.#state !== 'FAILED_RECOVERABLE') ||
      this.#historyBeforeSubmission === undefined
    ) {
      throw new SettlementError('INVALID_STATE');
    }

    try {
      const latest = await this.#wallets.counterparty.getTxHistory(0, this.#historyPageSize);
      const candidates = latest.filter(
        (entry: HistoryEntry) => !this.#historyBeforeSubmission?.has(entry.txHash),
      );
      if (candidates.length === 0) return { status: 'PENDING' };
      if (candidates.length !== 1) return { status: 'UNKNOWN' };

      const entry = candidates[0];
      if (entry === undefined) return { status: 'UNKNOWN' };
      if (entry.txStatus.status === 'pending') return { status: 'PENDING', txHash: entry.txHash };
      if (entry.txStatus.status === 'discarded' || !executionSucceeded(entry)) {
        this.#state = 'FAILED_FINAL';
        return { status: 'FAILED', txHash: entry.txHash };
      }
      this.#state = 'CONFIRMED';
      if (this.#receipt !== undefined) this.#receipt = { ...this.#receipt, txHash: entry.txHash };
      this.#firmupRequest = undefined;
      return { status: 'CONFIRMED', txHash: entry.txHash };
    } catch (error) {
      if (error instanceof SettlementError) throw error;
      throw sanitizeConnectorError(error);
    }
  }
}
