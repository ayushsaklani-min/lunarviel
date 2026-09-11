import { describe, expect, it } from 'vitest';

import {
  InMemorySessionChallengeService,
  SessionChallengeError,
  type WalletSignatureVerifier,
} from './sessionChallenge.js';

let clock = 1_800_000_000_000n;

const verifier: WalletSignatureVerifier = {
  async verify({ signature }) {
    return signature.length === 1 && signature[0] === 7;
  },
};

function service() {
  let id = 0;
  return new InMemorySessionChallengeService({
    nowMs: () => clock,
    challengeLifetimeMs: 100n,
    sessionLifetimeMs: 500n,
    verifier,
    newId: () => `challenge-${++id}`,
    random: (length) => new Uint8Array(length).fill(9),
  });
}

async function expectSessionError(
  action: () => unknown | Promise<unknown>,
  code: SessionChallengeError['code'],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionChallengeError);
    if (!(error instanceof SessionChallengeError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe('InMemorySessionChallengeService', () => {
  it('issues a one-time challenge and stores only a hashed session token', async () => {
    clock = 1_800_000_000_000n;
    const sessions = service();
    const challenge = sessions.create({ domain: 'https://app.lunarveil.test', walletIdentity: 'wallet-public-key' });
    const verified = await sessions.verify({ challengeId: challenge.id, signature: new Uint8Array([7]) });

    expect(verified.token).not.toBe('');
    expect(verified.walletIdentityHash).toHaveLength(64);
    expect(sessions.authenticate(verified.token).walletIdentityHash).toBe(verified.walletIdentityHash);
    await expectSessionError(
      () => sessions.verify({ challengeId: challenge.id, signature: new Uint8Array([7]) }),
      'CHALLENGE_REPLAYED',
    );
  });

  it('fails closed for invalid signatures and expired challenges', async () => {
    clock = 1_800_000_000_000n;
    const sessions = service();
    const invalid = sessions.create({ domain: 'https://app.lunarveil.test', walletIdentity: 'wallet-public-key' });
    await expectSessionError(
      () => sessions.verify({ challengeId: invalid.id, signature: new Uint8Array([3]) }),
      'INVALID_SIGNATURE',
    );

    const expired = sessions.create({ domain: 'https://app.lunarveil.test', walletIdentity: 'wallet-public-key' });
    clock += 100n;
    await expectSessionError(
      () => sessions.verify({ challengeId: expired.id, signature: new Uint8Array([7]) }),
      'CHALLENGE_EXPIRED',
    );
  });

  it('rejects expired or altered bearer tokens', async () => {
    clock = 1_800_000_000_000n;
    const sessions = service();
    const challenge = sessions.create({ domain: 'https://app.lunarveil.test', walletIdentity: 'wallet-public-key' });
    const verified = await sessions.verify({ challengeId: challenge.id, signature: new Uint8Array([7]) });

    await expectSessionError(() => sessions.authenticate(`${verified.token}x`), 'SESSION_INVALID');
    clock += 500n;
    await expectSessionError(() => sessions.authenticate(verified.token), 'SESSION_EXPIRED');
  });
});
