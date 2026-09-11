import { createHash, randomUUID } from 'node:crypto';

import type { SerializableSqlClient, SerializableSqlPool } from './orderEnvelopeRepository.js';

export interface OnChainAdmissionRecordV1 {
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly txId: string;
  readonly leafIndex?: string;
}

export type DurableChainAdmissionDecisionV1 =
  | {
    readonly action: 'ACCEPT';
    readonly code: 'ADMISSION_CONFIRMED';
    readonly sourceIds: readonly string[];
    readonly admission: OnChainAdmissionRecordV1;
  }
  | {
    readonly action: 'PAUSE';
    readonly code: 'INDEXER_DISAGREEMENT' | 'ONCHAIN_ADMISSION_MISMATCH';
    readonly sourceIds: readonly string[];
  };

export interface ChainAdmissionTransitionResultV1 {
  readonly state: 'PENDING_CHAIN' | 'ACCEPTED';
  readonly replayed: boolean;
}

export class ChainAdmissionReconciliationRepositoryError extends Error {
  constructor(readonly code: 'ORDER_NOT_FOUND' | 'INVALID_STATE' | 'DECISION_CONFLICT' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'ChainAdmissionReconciliationRepositoryError';
  }
}

interface LockedOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly state: 'PENDING_CHAIN' | 'ACCEPTED' | 'REJECTED';
  readonly chainAdmissionTxId: string | null;
  readonly leafIndex: string | null;
}

const LOCK_ORDER = `
  SELECT "id", "marketId", "epochId", "commitment", "state", "chainAdmissionTxId", "leafIndex"
  FROM "OrderEnvelope" WHERE "id" = $1 FOR UPDATE
`;

const INSERT_RECONCILIATION = `
  INSERT INTO "OrderAdmissionReconciliation" (
    "id", "orderId", "state", "decisionCode", "decisionHash", "sourceIds", "admissionTxId", "leafIndex"
  ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
  ON CONFLICT ("orderId", "decisionHash") DO NOTHING
  RETURNING "id"
`;

const SELECT_RECONCILIATION = `
  SELECT "id" FROM "OrderAdmissionReconciliation"
  WHERE "orderId" = $1 AND "decisionHash" = $2
`;

const ACCEPT_ORDER = `
  UPDATE "OrderEnvelope"
  SET "state" = 'ACCEPTED', "chainAdmissionTxId" = $2, "leafIndex" = $3,
      "acceptedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = $1 AND "state" = 'PENDING_CHAIN'
  RETURNING "id"
`;

function assertPublicValue(value: string): void {
  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ChainAdmissionReconciliationRepositoryError('DECISION_CONFLICT');
  }
}

function normalizedSourceIds(sourceIds: readonly string[]): readonly string[] {
  const normalized = [...sourceIds].sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < normalized.length; index++) {
    assertPublicValue(normalized[index]!);
    if (index > 0 && normalized[index - 1] === normalized[index]) {
      throw new ChainAdmissionReconciliationRepositoryError('DECISION_CONFLICT');
    }
  }
  return normalized;
}

function decisionHash(decision: DurableChainAdmissionDecisionV1, sourceIds: readonly string[]): string {
  const parts = ['LUNARVEIL_CHAIN_ADMISSION_DECISION_V1', decision.action, decision.code, ...sourceIds];
  if (decision.action === 'ACCEPT') {
    const admission = decision.admission;
    assertPublicValue(admission.marketId);
    assertPublicValue(admission.epochId);
    assertPublicValue(admission.commitment);
    assertPublicValue(admission.txId);
    if (admission.leafIndex !== undefined && !/^(0|[1-9][0-9]*)$/u.test(admission.leafIndex)) {
      throw new ChainAdmissionReconciliationRepositoryError('DECISION_CONFLICT');
    }
    parts.push(admission.marketId, admission.epochId, admission.commitment, admission.txId, admission.leafIndex ?? '');
  }
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

function sameAcceptedAdmission(order: LockedOrderRow, decision: Extract<DurableChainAdmissionDecisionV1, { action: 'ACCEPT' }>): boolean {
  return order.marketId === decision.admission.marketId
    && order.epochId === decision.admission.epochId
    && order.commitment === decision.admission.commitment
    && order.chainAdmissionTxId === decision.admission.txId
    && order.leafIndex === (decision.admission.leafIndex ?? null);
}

/**
 * Applies public consensus decisions atomically. A PAUSE records sanitized
 * evidence but never promotes the order; only matching ACCEPT evidence may
 * transition PENDING_CHAIN to ACCEPTED.
 */
export class PostgresChainAdmissionReconciliationRepository {
  private readonly newId: () => string;

  constructor(private readonly pool: SerializableSqlPool, options: { readonly newId?: () => string } = {}) {
    this.newId = options.newId ?? randomUUID;
  }

  async apply(orderId: string, decision: DurableChainAdmissionDecisionV1): Promise<ChainAdmissionTransitionResultV1> {
    assertPublicValue(orderId);
    const sourceIds = normalizedSourceIds(decision.sourceIds);
    const hash = decisionHash(decision, sourceIds);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const locked = await client.query<LockedOrderRow>(LOCK_ORDER, [orderId]);
      const order = locked.rows[0];
      if (!order) throw new ChainAdmissionReconciliationRepositoryError('ORDER_NOT_FOUND');
      if (order.state === 'ACCEPTED') {
        if (decision.action === 'ACCEPT' && sameAcceptedAdmission(order, decision)) {
          await client.query('COMMIT');
          return { state: 'ACCEPTED', replayed: true };
        }
        throw new ChainAdmissionReconciliationRepositoryError('INVALID_STATE');
      }
      if (order.state !== 'PENDING_CHAIN') throw new ChainAdmissionReconciliationRepositoryError('INVALID_STATE');
      if (decision.action === 'ACCEPT' && (
        order.marketId !== decision.admission.marketId
        || order.epochId !== decision.admission.epochId
        || order.commitment !== decision.admission.commitment
      )) throw new ChainAdmissionReconciliationRepositoryError('DECISION_CONFLICT');

      const inserted = await client.query<{ id: string }>(INSERT_RECONCILIATION, [
        this.newId(),
        order.id,
        decision.action === 'ACCEPT' ? 'CONFIRMED' : 'PAUSED',
        decision.code,
        hash,
        JSON.stringify(sourceIds),
        decision.action === 'ACCEPT' ? decision.admission.txId : null,
        decision.action === 'ACCEPT' ? decision.admission.leafIndex ?? null : null,
      ]);
      if (inserted.rows.length === 0) {
        const existing = await client.query<{ id: string }>(SELECT_RECONCILIATION, [order.id, hash]);
        if (existing.rows.length === 0) throw new ChainAdmissionReconciliationRepositoryError('DECISION_CONFLICT');
        await client.query('COMMIT');
        return { state: 'PENDING_CHAIN', replayed: true };
      }
      if (decision.action === 'PAUSE') {
        await client.query('COMMIT');
        return { state: 'PENDING_CHAIN', replayed: false };
      }
      const accepted = await client.query<{ id: string }>(ACCEPT_ORDER, [
        order.id,
        decision.admission.txId,
        decision.admission.leafIndex ?? null,
      ]);
      if (accepted.rows.length !== 1) throw new ChainAdmissionReconciliationRepositoryError('DATABASE_FAILURE');
      await client.query('COMMIT');
      return { state: 'ACCEPTED', replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original outcome */ }
      if (error instanceof ChainAdmissionReconciliationRepositoryError) throw error;
      throw new ChainAdmissionReconciliationRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }
}
