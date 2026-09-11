import type {
  ConnectedAPI,
  DesiredInput,
  DesiredOutput,
  HistoryEntry,
} from '@midnight-ntwrk/dapp-connector-api';

export type SettlementState =
  | 'CREATED'
  | 'COLLECTING'
  | 'READY'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED_RECOVERABLE'
  | 'FAILED_FINAL';

export type SettlementReadiness = 'COLLECTING' | 'READY' | 'INVALID';

export interface PrivatePairwiseAllocationV1 {
  version: 1;
  sessionId: string;
  networkId: string;
  initiatorInput: DesiredInput;
  initiatorOutput: DesiredOutput;
}

/** Sensitive wallet-produced payload. Encrypt if it crosses a process boundary. */
export interface FirmupRequest {
  version: 1;
  sessionId: string;
  initiatorRequestId: string;
  opaqueTransaction: string;
  payloadFingerprint: string;
}

/** Sensitive wallet-produced payload. Never place this object in application logs. */
export interface ParticipantPayload {
  version: 1;
  sessionId: string;
  counterpartyRequestId: string;
  opaqueTransaction: string;
  payloadFingerprint: string;
}

export interface SubmissionReceipt {
  sessionId: string;
  submissionFingerprint: string;
  /** Connector 4.0.1 returns void, so a chain hash is learned only during reconciliation. */
  txHash?: string;
}

export type ReconciliationResult =
  | { status: 'PENDING' | 'UNKNOWN'; txHash?: string }
  | { status: 'CONFIRMED'; txHash: string }
  | { status: 'FAILED'; txHash: string };

export interface SettlementAdapter {
  createFirmupRequest(clientRequestId: string): Promise<FirmupRequest>;
  acceptParticipantPayload(payload: ParticipantPayload): Promise<void>;
  readiness(): Promise<SettlementReadiness>;
  submitAtomicSettlement(clientRequestId: string): Promise<SubmissionReceipt>;
  reconcile(): Promise<ReconciliationResult>;
  state(): SettlementState;
}

export interface PairwiseWallets {
  initiator: ConnectedAPI;
  counterparty: ConnectedAPI;
}

export interface PairwiseAdapterOptions {
  historyPageSize?: number;
  maxSerializedTransactionBytes?: number;
}

export type WalletHistorySnapshot = ReadonlyMap<string, HistoryEntry>;
