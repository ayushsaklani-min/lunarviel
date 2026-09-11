import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const IDENTITY_MAX_LENGTH = 256;
const DOMAIN_MAX_LENGTH = 255;

export interface WalletChallengeV1 {
  readonly id: string;
  readonly domain: string;
  readonly walletIdentity: string;
  readonly nonce: string;
  readonly issuedAtMs: bigint;
  readonly expiresAtMs: bigint;
}

interface StoredChallenge extends WalletChallengeV1 {
  used: boolean;
}

interface StoredSession {
  readonly tokenHash: Uint8Array;
  readonly walletIdentityHash: string;
  readonly issuedAtMs: bigint;
  readonly expiresAtMs: bigint;
}

export interface VerifiedSessionV1 {
  readonly token: string;
  readonly walletIdentityHash: string;
  readonly expiresAtMs: bigint;
}

export interface WalletSignatureEvidenceV1 {
  readonly domain: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly walletIdentity: string;
  readonly signature: Uint8Array;
  /**
   * The wallet's verifying key, when the connector supplied one. A verifier
   * that binds identity to key needs it: a signature alone proves possession
   * of some key, never of this wallet.
   */
  readonly verifyingKey?: string | undefined;
  /**
   * The exact bytes the wallet reports having signed, which may carry a
   * wallet-chosen prefix ahead of the canonical session message.
   */
  readonly signedData?: Uint8Array | undefined;
}

export interface WalletSignatureVerifier {
  verify(input: WalletSignatureEvidenceV1): Promise<boolean>;
}

export interface SessionChallengeServiceOptions {
  readonly nowMs: () => bigint;
  readonly challengeLifetimeMs: bigint;
  readonly sessionLifetimeMs: bigint;
  readonly verifier: WalletSignatureVerifier;
  readonly newId?: () => string;
  readonly random?: (length: number) => Uint8Array;
}

export class SessionChallengeError extends Error {
  constructor(readonly code: 'INVALID_DOMAIN' | 'INVALID_WALLET_IDENTITY' | 'INVALID_SIGNATURE' | 'CHALLENGE_NOT_FOUND' | 'CHALLENGE_EXPIRED' | 'CHALLENGE_REPLAYED' | 'SESSION_INVALID' | 'SESSION_EXPIRED') {
    super(code);
    this.name = 'SessionChallengeError';
  }
}

function assertLifetime(value: bigint, name: string): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function assertDomain(value: string): void {
  if (!value || value.length > DOMAIN_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionChallengeError('INVALID_DOMAIN');
  }
}

function assertWalletIdentity(value: string): void {
  if (!value || value.length > IDENTITY_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SessionChallengeError('INVALID_WALLET_IDENTITY');
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(value: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

/**
 * The single canonical wallet-identity derivation. Anything binding a trader
 * tag to a session must use this rather than re-deriving it, so a change to the
 * domain separator cannot silently split the two.
 */
export function walletIdentityHashV1(walletIdentity: string): string {
  return walletIdentityHash(walletIdentity);
}

function walletIdentityHash(walletIdentity: string): string {
  return createHash('sha256')
    .update('LUNARVEIL_WALLET_SESSION_IDENTITY_V1\u0000', 'utf8')
    .update(walletIdentity, 'utf8')
    .digest('hex');
}

function publicChallenge(challenge: StoredChallenge): WalletChallengeV1 {
  return {
    id: challenge.id,
    domain: challenge.domain,
    walletIdentity: challenge.walletIdentity,
    nonce: challenge.nonce,
    issuedAtMs: challenge.issuedAtMs,
    expiresAtMs: challenge.expiresAtMs,
  };
}

/**
 * Reference non-custodial session service. Production persistence must retain
 * only the wallet identity hash and session-token hash, never a bearer token.
 */
export class InMemorySessionChallengeService {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly newId: () => string;
  private readonly random: (length: number) => Uint8Array;

  constructor(private readonly options: SessionChallengeServiceOptions) {
    assertLifetime(options.challengeLifetimeMs, 'challengeLifetimeMs');
    assertLifetime(options.sessionLifetimeMs, 'sessionLifetimeMs');
    this.newId = options.newId ?? randomUUID;
    this.random = options.random ?? randomBytes;
  }

  create(input: { readonly domain: string; readonly walletIdentity: string }): WalletChallengeV1 {
    assertDomain(input.domain);
    assertWalletIdentity(input.walletIdentity);
    const issuedAtMs = this.options.nowMs();
    const nonceBytes = this.random(TOKEN_BYTES);
    const nonce = base64Url(nonceBytes);
    nonceBytes.fill(0);
    const challenge: StoredChallenge = {
      id: this.newId(),
      domain: input.domain,
      walletIdentity: input.walletIdentity,
      nonce,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.options.challengeLifetimeMs,
      used: false,
    };
    this.challenges.set(challenge.id, challenge);
    return publicChallenge(challenge);
  }

  async verify(input: {
    readonly challengeId: string;
    readonly signature: Uint8Array;
    readonly verifyingKey?: string | undefined;
    readonly signedData?: Uint8Array | undefined;
  }): Promise<VerifiedSessionV1> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) throw new SessionChallengeError('CHALLENGE_NOT_FOUND');
    const nowMs = this.options.nowMs();
    if (nowMs >= challenge.expiresAtMs) throw new SessionChallengeError('CHALLENGE_EXPIRED');
    if (challenge.used) throw new SessionChallengeError('CHALLENGE_REPLAYED');
    if (!(input.signature instanceof Uint8Array) || input.signature.length === 0) {
      throw new SessionChallengeError('INVALID_SIGNATURE');
    }

    let verified = false;
    try {
      verified = await this.options.verifier.verify({
        domain: challenge.domain,
        challengeId: challenge.id,
        nonce: challenge.nonce,
        walletIdentity: challenge.walletIdentity,
        signature: input.signature,
        verifyingKey: input.verifyingKey,
        signedData: input.signedData,
      });
    } catch {
      throw new SessionChallengeError('INVALID_SIGNATURE');
    }
    if (!verified) throw new SessionChallengeError('INVALID_SIGNATURE');

    challenge.used = true;
    const tokenBytes = this.random(TOKEN_BYTES);
    const token = base64Url(tokenBytes);
    const tokenHash = sha256(token);
    tokenBytes.fill(0);
    const session: StoredSession = {
      tokenHash,
      walletIdentityHash: walletIdentityHash(challenge.walletIdentity),
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + this.options.sessionLifetimeMs,
    };
    this.sessions.set(base64Url(tokenHash), session);
    return {
      token,
      walletIdentityHash: session.walletIdentityHash,
      expiresAtMs: session.expiresAtMs,
    };
  }

  authenticate(token: string): Omit<VerifiedSessionV1, 'token'> {
    if (!token) throw new SessionChallengeError('SESSION_INVALID');
    const tokenHash = sha256(token);
    try {
      const session = this.sessions.get(base64Url(tokenHash));
      if (!session || !timingSafeEqual(session.tokenHash, tokenHash)) {
        throw new SessionChallengeError('SESSION_INVALID');
      }
      if (this.options.nowMs() >= session.expiresAtMs) throw new SessionChallengeError('SESSION_EXPIRED');
      return {
        walletIdentityHash: session.walletIdentityHash,
        expiresAtMs: session.expiresAtMs,
      };
    } finally {
      tokenHash.fill(0);
    }
  }
}
