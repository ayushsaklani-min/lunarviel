import { randomUUID } from 'node:crypto';

import {
  canonicalOrderEnvelopeTransportV1,
  type OrderEnvelopeV1,
} from '@lunarveil/crypto';
import type { Pool } from 'pg';

export interface AuthenticatedOrderEnvelopeSubmissionV1 {
  readonly envelope: OrderEnvelopeV1;
  /** Verified by the session/signature layer before repository submission. */
  readonly clientSignature: Uint8Array;
  readonly chainAdmission?: {
    readonly txId: string;
    readonly leafIndex?: string;
  };
}

export interface StoredOrderEnvelopeRecordV1 {
  readonly id: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly state: 'PENDING_CHAIN' | 'ACCEPTED' | 'REJECTED';
  readonly createdAtMs: bigint;
}

export interface OrderEnvelopeRepositoryResult {
  readonly record: StoredOrderEnvelopeRecordV1;
  readonly replayed: boolean;
}

export class OrderEnvelopeRepositoryError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'DUPLICATE_COMMITMENT' | 'DATABASE_CONFLICT' | 'DATABASE_FAILURE') {
    super(code);
    this.name = 'OrderEnvelopeRepositoryError';
  }
}

type SqlValue = string | number | Buffer | null;

export interface SqlQueryResult<Row extends Record<string, unknown>> {
  readonly rows: readonly Row[];
}

export interface SerializableSqlClient {
  query<Row extends Record<string, unknown>>(text: string, values?: readonly SqlValue[]): Promise<SqlQueryResult<Row>>;
  release(): void;
}

export interface SerializableSqlPool {
  connect(): Promise<SerializableSqlClient>;
}

export interface PostgresOrderEnvelopeRepositoryOptions {
  readonly newId?: () => string;
}

interface OrderEnvelopeRow extends Record<string, unknown> {
  readonly id: string;
  readonly clientRequestId: string;
  readonly marketId: string;
  readonly epochId: string;
  readonly commitment: string;
  readonly encryptionKeyId: string;
  readonly envelopeVersion: number;
  readonly envelopeAlgorithm: string;
  readonly ephemeralPublicKey: string;
  readonly envelopeSalt: string;
  readonly envelopeNonce: string;
  readonly ciphertext: Buffer;
  readonly traderTagHash: string;
  readonly state: 'PENDING_CHAIN' | 'ACCEPTED' | 'REJECTED';
  readonly createdAt: Date;
}

const SELECT_ENVELOPE_COLUMNS = `
  "id", "clientRequestId", "marketId", "epochId", "commitment",
  "encryptionKeyId", "envelopeVersion", "envelopeAlgorithm",
  "ephemeralPublicKey", "envelopeSalt", "envelopeNonce", "ciphertext",
  "traderTagHash", "state", "createdAt"
`;

const INSERT_ENVELOPE = `
  INSERT INTO "OrderEnvelope" (
    "id", "clientRequestId", "marketId", "epochId", "commitment",
    "encryptionKeyId", "envelopeVersion", "envelopeAlgorithm",
    "ephemeralPublicKey", "envelopeSalt", "envelopeNonce", "ciphertext",
    "traderTagHash", "clientSignature", "chainAdmissionTxId", "leafIndex", "state", "updatedAt"
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP
  )
  ON CONFLICT DO NOTHING
  RETURNING ${SELECT_ENVELOPE_COLUMNS}
`;

const SELECT_BY_CLIENT_REQUEST_ID = `
  SELECT ${SELECT_ENVELOPE_COLUMNS}
  FROM "OrderEnvelope"
  WHERE "clientRequestId" = $1
`;

const SELECT_BY_COMMITMENT = `
  SELECT ${SELECT_ENVELOPE_COLUMNS}
  FROM "OrderEnvelope"
  WHERE "commitment" = $1
`;

const SELECT_PENDING_ENVELOPE_BY_ID = `
  SELECT ${SELECT_ENVELOPE_COLUMNS}
  FROM "OrderEnvelope"
  WHERE "id" = $1 AND "state" = 'PENDING_CHAIN'
`;

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function fromRow(row: OrderEnvelopeRow): StoredOrderEnvelopeRecordV1 {
  return {
    id: row.id,
    clientRequestId: row.clientRequestId,
    marketId: row.marketId,
    epochId: row.epochId,
    commitment: row.commitment,
    state: row.state,
    createdAtMs: BigInt(row.createdAt.getTime()),
  };
}

function envelopeFromRow(row: OrderEnvelopeRow): OrderEnvelopeV1 {
  if (row.envelopeVersion !== 1) throw new OrderEnvelopeRepositoryError('DATABASE_CONFLICT');
  return {
    version: 1,
    clientRequestId: row.clientRequestId,
    marketId: row.marketId,
    epochId: row.epochId,
    commitment: row.commitment,
    traderTagHash: row.traderTagHash,
    encryptionKeyId: row.encryptionKeyId,
    algorithm: row.envelopeAlgorithm as OrderEnvelopeV1['algorithm'],
    ephemeralPublicKey: row.ephemeralPublicKey,
    salt: row.envelopeSalt,
    nonce: row.envelopeNonce,
    ciphertext: row.ciphertext.toString('base64url'),
  };
}

function sameTransport(left: OrderEnvelopeV1, right: OrderEnvelopeV1): boolean {
  return canonicalOrderEnvelopeTransportV1(left) === canonicalOrderEnvelopeTransportV1(right);
}

function isDatabaseCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

/**
 * Parameterized, serializable repository for encrypted envelopes. It has no
 * raw-order parameter and never selects or returns client signature bytes.
 */
export class PostgresOrderEnvelopeRepository {
  private readonly newId: () => string;

  constructor(
    private readonly pool: SerializableSqlPool,
    options: PostgresOrderEnvelopeRepositoryOptions = {},
  ) {
    this.newId = options.newId ?? randomUUID;
  }

  async submit(input: AuthenticatedOrderEnvelopeSubmissionV1): Promise<OrderEnvelopeRepositoryResult> {
    if (!(input.clientSignature instanceof Uint8Array) || input.clientSignature.length === 0) {
      throw new OrderEnvelopeRepositoryError('DATABASE_CONFLICT');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.submitOnce(input);
      } catch (error) {
        if (isDatabaseCode(error, '40001') && attempt === 0) continue;
        if (error instanceof OrderEnvelopeRepositoryError) throw error;
        throw new OrderEnvelopeRepositoryError('DATABASE_FAILURE');
      }
    }
    throw new OrderEnvelopeRepositoryError('DATABASE_FAILURE');
  }

  /**
   * Matcher-only pre-admission path. It intentionally returns ciphertext, not
   * an opened order, and refuses rows no longer awaiting chain admission.
   * Never expose this method through public/API repository projections.
   */
  async loadPendingEnvelope(orderId: string): Promise<OrderEnvelopeV1> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(orderId)) {
      throw new OrderEnvelopeRepositoryError('DATABASE_CONFLICT');
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query<OrderEnvelopeRow>(SELECT_PENDING_ENVELOPE_BY_ID, [orderId]);
      const row = result.rows[0];
      if (row === undefined) throw new OrderEnvelopeRepositoryError('DATABASE_CONFLICT');
      return envelopeFromRow(row);
    } catch (error) {
      if (error instanceof OrderEnvelopeRepositoryError) throw error;
      throw new OrderEnvelopeRepositoryError('DATABASE_FAILURE');
    } finally {
      client.release();
    }
  }

  private async submitOnce(input: AuthenticatedOrderEnvelopeSubmissionV1): Promise<OrderEnvelopeRepositoryResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const inserted = await this.insertOrReplay(client, input);
      await client.query('COMMIT');
      return inserted;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original database outcome remains the only useful failure signal.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertOrReplay(
    client: SerializableSqlClient,
    input: AuthenticatedOrderEnvelopeSubmissionV1,
  ): Promise<OrderEnvelopeRepositoryResult> {
    const envelope = input.envelope;
    const ciphertext = base64UrlToBuffer(envelope.ciphertext);
    const signature = Buffer.from(input.clientSignature);
    try {
      // Handle every unique collision without aborting the transaction, so the
      // following reads can distinguish a replay, duplicate, or ID collision.
      const inserted = await client.query<OrderEnvelopeRow>(INSERT_ENVELOPE, [
        this.newId(),
        envelope.clientRequestId,
        envelope.marketId,
        envelope.epochId,
        envelope.commitment,
        envelope.encryptionKeyId,
        envelope.version,
        envelope.algorithm,
        envelope.ephemeralPublicKey,
        envelope.salt,
        envelope.nonce,
        ciphertext,
        envelope.traderTagHash,
        signature,
        input.chainAdmission?.txId ?? null,
        input.chainAdmission?.leafIndex ?? null,
        'PENDING_CHAIN',
      ]);

      const row = inserted.rows[0];
      if (row) return { record: fromRow(row), replayed: false };

      const existing = await client.query<OrderEnvelopeRow>(SELECT_BY_CLIENT_REQUEST_ID, [envelope.clientRequestId]);
      const existingRow = existing.rows[0];
      if (!existingRow) {
        const duplicate = await client.query<OrderEnvelopeRow>(SELECT_BY_COMMITMENT, [envelope.commitment]);
        if (duplicate.rows.length > 0) throw new OrderEnvelopeRepositoryError('DUPLICATE_COMMITMENT');
        throw new OrderEnvelopeRepositoryError('DATABASE_CONFLICT');
      }
      if (!sameTransport(envelope, envelopeFromRow(existingRow))) {
        throw new OrderEnvelopeRepositoryError('IDEMPOTENCY_CONFLICT');
      }
      return { record: fromRow(existingRow), replayed: true };
    } finally {
      ciphertext.fill(0);
      signature.fill(0);
    }
  }
}

/** Adapter for the pinned node-postgres client. */
export function nodePostgresSerializablePool(pool: Pool): SerializableSqlPool {
  return {
    async connect(): Promise<SerializableSqlClient> {
      const client = await pool.connect();
      return {
        async query<Row extends Record<string, unknown>>(text: string, values: readonly SqlValue[] = []) {
          const result = await client.query<Row>(text, [...values]);
          return { rows: result.rows };
        },
        release: () => client.release(),
      };
    },
  };
}
