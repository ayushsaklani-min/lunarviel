export type SettlementErrorCode =
  | 'INVALID_ALLOCATION'
  | 'INVALID_PARTICIPANT_PAYLOAD'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE'
  | 'NETWORK_MISMATCH'
  | 'WALLET_DISCONNECTED'
  | 'WALLET_PERMISSION_REJECTED'
  | 'WALLET_REQUEST_REJECTED'
  | 'WALLET_INVALID_REQUEST'
  | 'WALLET_INTERNAL_ERROR'
  | 'WALLET_RESPONSE_INVALID'
  | 'SUBMISSION_UNCERTAIN';

export class SettlementError extends Error {
  readonly code: SettlementErrorCode;

  constructor(code: SettlementErrorCode) {
    super(code);
    this.name = 'SettlementError';
    this.code = code;
  }
}

type ConnectorErrorShape = {
  type?: unknown;
  code?: unknown;
};

export function sanitizeConnectorError(error: unknown): SettlementError {
  const candidate = error as ConnectorErrorShape;
  if (candidate?.type !== 'DAppConnectorAPIError') {
    return new SettlementError('WALLET_INTERNAL_ERROR');
  }
  switch (candidate.code) {
    case 'PermissionRejected':
      return new SettlementError('WALLET_PERMISSION_REJECTED');
    case 'Rejected':
      return new SettlementError('WALLET_REQUEST_REJECTED');
    case 'InvalidRequest':
      return new SettlementError('WALLET_INVALID_REQUEST');
    case 'Disconnected':
      return new SettlementError('WALLET_DISCONNECTED');
    default:
      return new SettlementError('WALLET_INTERNAL_ERROR');
  }
}
