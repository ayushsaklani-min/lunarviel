import {
  type OrderEnvelopeV1,
  validateOrderEnvelopeV1,
} from '@lunarveil/crypto';
import {
  type AuthenticatedOrderEnvelopeSubmissionV1,
  type OrderEnvelopeRepositoryResult,
} from '@lunarveil/db';

import { type InMemorySessionChallengeService } from './sessionChallenge.js';

export interface AuthenticatedOrderEnvelopeRepository {
  submit(input: AuthenticatedOrderEnvelopeSubmissionV1): Promise<OrderEnvelopeRepositoryResult>;
}

/** Binds public envelope ownership metadata to an already-authenticated session. */
export interface TraderSessionBindingVerifier {
  verify(input: {
    readonly walletIdentityHash: string;
    readonly traderTagHash: string;
  }): Promise<boolean>;
}

/**
 * Verifies a canonical signature over an encrypted envelope.
 *
 * Connector `4.0.1` does provide the signing half (`signData`), corrected in
 * ADR-0038; a real implementation lives in `@lunarveil/wallet-auth`. The
 * verifying key and the exact signed bytes are optional because `signData`
 * prepends an unspecified prefix that the server cannot reconstruct, and
 * because a verifier that needs neither must keep working unchanged.
 */
export interface OrderEnvelopeSignatureVerifier {
  verify(input: {
    readonly walletIdentityHash: string;
    readonly envelope: OrderEnvelopeV1;
    readonly signature: Uint8Array;
    readonly verifyingKey?: string | undefined;
    readonly signedData?: Uint8Array | undefined;
  }): Promise<boolean>;
}

export interface AuthenticatedOrderSubmissionInputV1 {
  readonly bearerToken: string;
  readonly envelope: OrderEnvelopeV1;
  readonly clientSignature: Uint8Array;
  readonly verifyingKey?: string | undefined;
  readonly signedData?: Uint8Array | undefined;
  readonly chainAdmission?: {
    readonly txId: string;
    readonly leafIndex?: string;
  };
}

export class AuthenticatedOrderSubmissionError extends Error {
  constructor(readonly code: 'SESSION_INVALID' | 'INVALID_ENVELOPE' | 'IDENTITY_MISMATCH' | 'INVALID_SIGNATURE') {
    super(code);
    this.name = 'AuthenticatedOrderSubmissionError';
  }
}

/**
 * Transport-neutral service boundary for encrypted order admission. It has no
 * raw-order argument, no wallet private key, and no HTTP assumptions.
 */
export class AuthenticatedOrderSubmissionServiceV1 {
  constructor(
    private readonly sessions: Pick<InMemorySessionChallengeService, 'authenticate'>,
    private readonly bindingVerifier: TraderSessionBindingVerifier,
    private readonly signatureVerifier: OrderEnvelopeSignatureVerifier,
    private readonly repository: AuthenticatedOrderEnvelopeRepository,
  ) {}

  async submit(input: AuthenticatedOrderSubmissionInputV1): Promise<OrderEnvelopeRepositoryResult> {
    let session: ReturnType<InMemorySessionChallengeService['authenticate']>;
    try {
      session = this.sessions.authenticate(input.bearerToken);
    } catch {
      throw new AuthenticatedOrderSubmissionError('SESSION_INVALID');
    }
    try {
      validateOrderEnvelopeV1(input.envelope);
    } catch {
      throw new AuthenticatedOrderSubmissionError('INVALID_ENVELOPE');
    }
    if (!(input.clientSignature instanceof Uint8Array) || input.clientSignature.length === 0) {
      throw new AuthenticatedOrderSubmissionError('INVALID_SIGNATURE');
    }

    let identityMatches = false;
    try {
      identityMatches = await this.bindingVerifier.verify({
        walletIdentityHash: session.walletIdentityHash,
        traderTagHash: input.envelope.traderTagHash,
      });
    } catch {
      throw new AuthenticatedOrderSubmissionError('IDENTITY_MISMATCH');
    }
    if (!identityMatches) throw new AuthenticatedOrderSubmissionError('IDENTITY_MISMATCH');

    const signature = new Uint8Array(input.clientSignature);
    try {
      let signatureValid = false;
      try {
        signatureValid = await this.signatureVerifier.verify({
          walletIdentityHash: session.walletIdentityHash,
          envelope: input.envelope,
          signature,
          verifyingKey: input.verifyingKey,
          signedData: input.signedData,
        });
      } catch {
        throw new AuthenticatedOrderSubmissionError('INVALID_SIGNATURE');
      }
      if (!signatureValid) throw new AuthenticatedOrderSubmissionError('INVALID_SIGNATURE');
      const submission: AuthenticatedOrderEnvelopeSubmissionV1 = input.chainAdmission === undefined
        ? { envelope: input.envelope, clientSignature: signature }
        : {
          envelope: input.envelope,
          clientSignature: signature,
          chainAdmission: input.chainAdmission,
        };
      return await this.repository.submit(submission);
    } finally {
      signature.fill(0);
    }
  }
}
