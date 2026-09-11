import type { TraderOrderRecordV1 } from '@lunarveil/db';

import { type InMemorySessionChallengeService } from './sessionChallenge.js';

export interface TraderOrderHistoryRepository {
  listForTrader(input: {
    readonly traderTagHash: string;
    readonly limit: number;
  }): Promise<readonly TraderOrderRecordV1[]>;
}

/** Derives the caller's own trader tag; never accepts one from a request. */
export interface TraderTagIssuer {
  tagFor(walletIdentityHash: string): string;
}

export class TraderOrderHistoryServiceError extends Error {
  constructor(readonly code: 'SESSION_INVALID' | 'INVALID_LIMIT' | 'HISTORY_UNAVAILABLE') {
    super(code);
    this.name = 'TraderOrderHistoryServiceError';
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Lists the authenticated trader's own orders.
 *
 * ## The tag is derived, never accepted
 *
 * The only input is a bearer token. The service authenticates it, takes the
 * session's `walletIdentityHash`, and derives the trader tag from that. There
 * is deliberately no parameter through which a caller could name a tag: if
 * there were, anyone holding any valid session could read any trader's order
 * history by supplying someone else's tag. Since the tag is an HMAC only this
 * service can compute, a caller cannot guess one either.
 *
 * ## What comes back
 *
 * Workflow metadata only — state, timestamps, the public commitment and, once
 * admitted, the chain transaction. Order contents never leave the ciphertext,
 * and this service never decrypts anything.
 */
export class TraderOrderHistoryServiceV1 {
  constructor(
    private readonly sessions: Pick<InMemorySessionChallengeService, 'authenticate'>,
    private readonly traderTags: TraderTagIssuer,
    private readonly repository: TraderOrderHistoryRepository,
  ) {}

  async list(input: {
    readonly bearerToken: string;
    readonly limit?: number;
  }): Promise<readonly TraderOrderRecordV1[]> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new TraderOrderHistoryServiceError('INVALID_LIMIT');
    }

    let walletIdentityHash: string;
    try {
      walletIdentityHash = this.sessions.authenticate(input.bearerToken).walletIdentityHash;
    } catch {
      throw new TraderOrderHistoryServiceError('SESSION_INVALID');
    }

    let traderTagHash: string;
    try {
      traderTagHash = this.traderTags.tagFor(walletIdentityHash);
    } catch {
      throw new TraderOrderHistoryServiceError('HISTORY_UNAVAILABLE');
    }

    try {
      return await this.repository.listForTrader({ traderTagHash, limit });
    } catch {
      // Never forward the repository's error: it can name columns, and a
      // database failure message can carry a connection string.
      throw new TraderOrderHistoryServiceError('HISTORY_UNAVAILABLE');
    }
  }
}
