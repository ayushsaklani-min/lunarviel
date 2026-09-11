import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { SerializableSqlClient, SerializableSqlPool, SqlQueryResult } from './orderEnvelopeRepository.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024;

export interface EncryptedSettlementParticipantPayloadV1 {
  readonly sessionId: string;
  readonly traderTagHash: string;
  /** Already-encrypted opaque wallet payload. Never pass raw transaction text here. */
  readonly ciphertextPayload: Uint8Array;
}

export interface StoredSettlementParticipantPayloadV1 {
  readonly id: string;
  readonly sessionId: string;
  readonly traderTagHash: string;
  readonly receivedAtMs: bigint;
}

export interface SettlementParticipantPayloadRepositoryResult {
  readonly record: StoredSettlementParticipantPayloadV1;
  readonly replayed: boolean;
}

export class SettlementParticipantPayloadRepositoryError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'DATABASE_CONFLICT' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'SettlementParticipantPayloadRepositoryError';
  }
}

interface PayloadRow extends Record<string, unknown> {
  readonly id: string;
  readonly sessionId: string;
  readonly traderTagHash: string;
  readonly ciphertextPayload: Buffer;
  readonly receivedAt: Date | null;
}

const RETURNING_COLUMNS = '"id", "sessionId", "traderTagHash", "ciphertextPayload", "receivedAt"';

const INSERT_PAYLOAD = `
  INSERT INTO "SettlementParticipantPayload" (
    "id", "sessionId", "traderTagHash", "ciphertextPayload", "state", "receivedAt"
  ) VALUES ($1, $2, $3, $4, $5, NOW())
  ON CONFLICT ("sessionId", "traderTagHash") DO NOTHING
  RETURNING ${RETURNING_COLUMNS}
`;

const SELECT_EXISTING_PAYLOAD = `
  SELECT ${RETURNING_COLUMNS}
  FROM "SettlementParticipantPayload"
  WHERE "sessionId" = $1 AND "traderTagHash" = $2
  FOR SHARE
`;

function isDatabaseCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function assertInput(input: EncryptedSettlementParticipantPayloadV1): void {
  if (!IDENTIFIER_PATTERN.test(input.sessionId) || !HASH_PATTERN.test(input.traderTagHash)) {
    throw new SettlementParticipantPayloadRepositoryError('DATABASE_CONFLICT');
  }
  if (!(input.ciphertextPayload instanceof Uint8Array) || input.ciphertextPayload.length === 0
    || input.ciphertextPayload.length > MAX_CIPHERTEXT_BYTES) {
    throw new SettlementParticipantPayloadRepositoryError('DATABASE_CONFLICT');
  }
}

function fromRow(row: PayloadRow): StoredSettlementParticipantPayloadV1 {
  if (
    typeof row.id !== 'string' || row.id.length === 0 || !IDENTIFIER_PATTERN.test(row.sessionId)
    || !HASH_PATTERN.test(row.traderTagHash) || !(row.receivedAt instanceof Date)
    || !Number.isFinite(row.receivedAt.getTime())
  ) {
    throw new SettlementParticipantPayloadRepositoryError('DATABASE_CONFLICT');
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    traderTagHash: row.traderTagHash,
    receivedAtMs: BigInt(row.receivedAt.getTime()),
  };
}

function sameCiphertext(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Internal ciphertext-only persistence for a participant's firm-up payload.
 * No method returns ciphertext or a serialized wallet transaction.
 */
export class PostgresSettlementParticipantPayloadRepository {
  private readonly newId: () => string;

  constructor(private readonly pool: SerializableSqlPool, options: { readonly newId?: () => string } = {}) {
    this.newId = options.newId ?? randomUUID;
  }

  async submit(input: EncryptedSettlementParticipantPayloadV1): Promise<SettlementParticipantPayloadRepositoryResult> {
    assertInput(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.submitOnce(input);
      } catch (error) {
        if (isDatabaseCode(error, '40001') && attempt === 0) continue;
        if (error instanceof SettlementParticipantPayloadRepositoryError) throw error;
        throw new SettlementParticipantPayloadRepositoryError('DATABASE_FAILURE');
      }
    }
    throw new SettlementParticipantPayloadRepositoryError('DATABASE_FAILURE');
  }

  private async submitOnce(input: EncryptedSettlementParticipantPayloadV1): Promise<SettlementParticipantPayloadRepositoryResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const result = await this.insertOrReplay(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original outcome */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertOrReplay(
    client: SerializableSqlClient,
    input: EncryptedSettlementParticipantPayloadV1,
  ): Promise<SettlementParticipantPayloadRepositoryResult> {
    const ciphertext = Buffer.from(input.ciphertextPayload);
    try {
      let inserted: SqlQueryResult<PayloadRow>;
      try {
        inserted = await client.query<PayloadRow>(INSERT_PAYLOAD, [
          this.newId(), input.sessionId, input.traderTagHash, ciphertext, 'RECEIVED',
        ]);
      } catch (error) {
        if (!isDatabaseCode(error, '23505')) throw error;
        throw new SettlementParticipantPayloadRepositoryError('DATABASE_CONFLICT');
      }
      const row = inserted.rows[0];
      if (row !== undefined) return { record: fromRow(row), replayed: false };

      const existing = await client.query<PayloadRow>(SELECT_EXISTING_PAYLOAD, [input.sessionId, input.traderTagHash]);
      const existingRow = existing.rows[0];
      if (existingRow === undefined || !sameCiphertext(ciphertext, existingRow.ciphertextPayload)) {
        throw new SettlementParticipantPayloadRepositoryError('IDEMPOTENCY_CONFLICT');
      }
      return { record: fromRow(existingRow), replayed: true };
    } finally {
      ciphertext.fill(0);
    }
  }
}
