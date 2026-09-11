import type { ConnectedAPI, HistoryEntry } from '@midnight-ntwrk/dapp-connector-api';
import { describe, expect, it, vi } from 'vitest';

import { SettlementError } from './errors.js';
import { PairwiseIntentSettlementAdapter } from './pairwiseIntentSettlementAdapter.js';
import type { ParticipantPayload, PrivatePairwiseAllocationV1 } from './types.js';

const TOKEN_A = '11'.repeat(32);
const TOKEN_B = '22'.repeat(32);

function allocation(): PrivatePairwiseAllocationV1 {
  return {
    version: 1,
    sessionId: 'settlement-session-1',
    networkId: 'preview',
    initiatorInput: {
      kind: 'shielded',
      type: TOKEN_A,
      value: 7n,
    },
    initiatorOutput: {
      kind: 'shielded',
      type: TOKEN_B,
      value: 11n,
      recipient: 'mn_shield-addr-counterparty-token-b',
    },
  };
}

function wallet(overrides: Partial<ConnectedAPI> = {}): ConnectedAPI {
  return {
    getConnectionStatus: vi.fn(async () => ({ status: 'connected', networkId: 'preview' })),
    getConfiguration: vi.fn(async () => ({
      indexerUri: 'https://indexer.example.test',
      indexerWsUri: 'wss://indexer.example.test',
      substrateNodeUri: 'wss://node.example.test',
      networkId: 'preview',
    })),
    hintUsage: vi.fn(async () => undefined),
    makeIntent: vi.fn(async () => ({ tx: 'sealed-initiator-transaction' })),
    balanceSealedTransaction: vi.fn(async () => ({ tx: 'sealed-balanced-transaction' })),
    getTxHistory: vi.fn(async () => []),
    submitTransaction: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ConnectedAPI;
}

async function readyAdapter(options: {
  initiator?: ConnectedAPI;
  counterparty?: ConnectedAPI;
} = {}) {
  const initiator = options.initiator ?? wallet();
  const counterparty = options.counterparty ?? wallet();
  const adapter = new PairwiseIntentSettlementAdapter(allocation(), { initiator, counterparty });
  const request = await adapter.createFirmupRequest('init-request-1');
  const payload: ParticipantPayload = {
    version: 1,
    sessionId: request.sessionId,
    counterpartyRequestId: 'counter-request-1',
    opaqueTransaction: request.opaqueTransaction,
    payloadFingerprint: request.payloadFingerprint,
  };
  await adapter.acceptParticipantPayload(payload);
  return { adapter, initiator, counterparty, request, payload };
}

describe('PairwiseIntentSettlementAdapter', () => {
  it('uses the exact Connector 4.0.1 intent and sealed-balancing signatures', async () => {
    const { adapter, initiator, counterparty } = await readyAdapter();

    expect(initiator.makeIntent).toHaveBeenCalledWith(
      [allocation().initiatorInput],
      [allocation().initiatorOutput],
      { intentId: 'random', payFees: false },
    );
    expect(counterparty.balanceSealedTransaction).toHaveBeenCalledWith(
      'sealed-initiator-transaction',
      { payFees: true },
    );
    expect(await adapter.readiness()).toBe('READY');
  });

  it('submits once and reconciles the single new successful wallet-history entry', async () => {
    let history: HistoryEntry[] = [];
    const counterparty = wallet({ getTxHistory: vi.fn(async () => history) });
    const { adapter } = await readyAdapter({ counterparty });

    const receipt = await adapter.submitAtomicSettlement('submit-request-1');
    expect(receipt.txHash).toBeUndefined();
    expect(receipt.submissionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(counterparty.submitTransaction).toHaveBeenCalledTimes(1);

    history = [{
      txHash: 'ab'.repeat(32),
      txStatus: { status: 'finalized', executionStatus: { 1: 'Success', 2: 'Success' } },
    }];
    await expect(adapter.reconcile()).resolves.toEqual({
      status: 'CONFIRMED',
      txHash: 'ab'.repeat(32),
    });
    expect(adapter.state()).toBe('CONFIRMED');
  });

  it('makes firm-up and submission idempotent while rejecting key conflicts', async () => {
    const initiator = wallet();
    const { adapter, request, payload, counterparty } = await readyAdapter({ initiator });
    await expect(adapter.createFirmupRequest('init-request-1')).resolves.toBe(request);
    expect(initiator.makeIntent).toHaveBeenCalledTimes(1);
    await expect(adapter.acceptParticipantPayload(payload)).resolves.toBeUndefined();
    expect(counterparty.balanceSealedTransaction).toHaveBeenCalledTimes(1);

    const first = await adapter.submitAtomicSettlement('submit-request-1');
    await expect(adapter.submitAtomicSettlement('submit-request-1')).resolves.toBe(first);
    expect(counterparty.submitTransaction).toHaveBeenCalledTimes(1);
    await expect(adapter.submitAtomicSettlement('submit-request-2')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('rejects a disconnected or wrong-network wallet before creating private intent data', async () => {
    const initiator = wallet({
      getConnectionStatus: vi.fn(async () => ({ status: 'connected', networkId: 'preprod' })),
    });
    const adapter = new PairwiseIntentSettlementAdapter(allocation(), {
      initiator,
      counterparty: wallet(),
    });
    await expect(adapter.createFirmupRequest('init-request-1')).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    });
    expect(initiator.makeIntent).not.toHaveBeenCalled();
  });

  it('rejects altered participant transaction payloads and fingerprints', async () => {
    const adapter = new PairwiseIntentSettlementAdapter(allocation(), {
      initiator: wallet(),
      counterparty: wallet(),
    });
    const request = await adapter.createFirmupRequest('init-request-1');
    await expect(adapter.acceptParticipantPayload({
      version: 1,
      sessionId: request.sessionId,
      counterpartyRequestId: 'counter-request-1',
      opaqueTransaction: `${request.opaqueTransaction}-altered`,
      payloadFingerprint: request.payloadFingerprint,
    })).rejects.toMatchObject({ code: 'INVALID_PARTICIPANT_PAYLOAD' });
  });

  it('rejects a counterparty response that did not change the imbalanced intent', async () => {
    const counterparty = wallet({
      balanceSealedTransaction: vi.fn(async tx => ({ tx })),
    });
    const adapter = new PairwiseIntentSettlementAdapter(allocation(), {
      initiator: wallet(),
      counterparty,
    });
    const request = await adapter.createFirmupRequest('init-request-1');
    await expect(adapter.acceptParticipantPayload({
      version: 1,
      sessionId: request.sessionId,
      counterpartyRequestId: 'counter-request-1',
      opaqueTransaction: request.opaqueTransaction,
      payloadFingerprint: request.payloadFingerprint,
    })).rejects.toMatchObject({ code: 'WALLET_RESPONSE_INVALID' });
  });

  it('fails closed when wallet history cannot identify one submission', async () => {
    let history: HistoryEntry[] = [];
    const counterparty = wallet({ getTxHistory: vi.fn(async () => history) });
    const { adapter } = await readyAdapter({ counterparty });
    await adapter.submitAtomicSettlement('submit-request-1');
    history = [
      { txHash: 'aa'.repeat(32), txStatus: { status: 'pending' } },
      { txHash: 'bb'.repeat(32), txStatus: { status: 'pending' } },
    ];
    await expect(adapter.reconcile()).resolves.toEqual({ status: 'UNKNOWN' });
    expect(adapter.state()).toBe('SUBMITTED');
  });

  it('treats a failed execution section as final settlement failure', async () => {
    let history: HistoryEntry[] = [];
    const counterparty = wallet({ getTxHistory: vi.fn(async () => history) });
    const { adapter } = await readyAdapter({ counterparty });
    await adapter.submitAtomicSettlement('submit-request-1');
    history = [{
      txHash: 'cc'.repeat(32),
      txStatus: { status: 'confirmed', executionStatus: { 1: 'Success', 2: 'Failure' } },
    }];
    await expect(adapter.reconcile()).resolves.toEqual({
      status: 'FAILED',
      txHash: 'cc'.repeat(32),
    });
    expect(adapter.state()).toBe('FAILED_FINAL');
  });

  it('sanitizes connector errors without retaining private wallet reasons', async () => {
    const privateReason = 'contains-sensitive-wallet-payload';
    const initiator = wallet({
      makeIntent: vi.fn(async () => {
        throw Object.assign(new Error(privateReason), {
          type: 'DAppConnectorAPIError',
          code: 'InvalidRequest',
          reason: privateReason,
        });
      }),
    });
    const adapter = new PairwiseIntentSettlementAdapter(allocation(), {
      initiator,
      counterparty: wallet(),
    });
    try {
      await adapter.createFirmupRequest('init-request-1');
      expect.fail('expected wallet request rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SettlementError);
      expect(error).toMatchObject({ code: 'WALLET_INVALID_REQUEST' });
      expect(String(error)).not.toContain(privateReason);
    }
  });

  it('rejects invalid amounts and same-token swaps before wallet use', () => {
    expect(() => new PairwiseIntentSettlementAdapter({
      ...allocation(),
      initiatorInput: { ...allocation().initiatorInput, value: 0n },
    }, { initiator: wallet(), counterparty: wallet() })).toThrowError('INVALID_ALLOCATION');
    expect(() => new PairwiseIntentSettlementAdapter({
      ...allocation(),
      initiatorOutput: { ...allocation().initiatorOutput, type: TOKEN_A },
    }, { initiator: wallet(), counterparty: wallet() })).toThrowError('INVALID_ALLOCATION');
  });
});
