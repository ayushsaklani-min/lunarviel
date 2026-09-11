import { describe, expect, it } from 'vitest';

import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
} from '@lunarveil/crypto';
import type { OrderEnvelopeRepositoryResult } from '@lunarveil/db';

import {
  AuthenticatedOrderSubmissionError,
  AuthenticatedOrderSubmissionServiceV1,
  type AuthenticatedOrderEnvelopeRepository,
} from './authenticatedOrderSubmission.js';
import { InMemorySessionChallengeService } from './sessionChallenge.js';

const nowMs = 1_800_000_000_000n;

async function envelope() {
  const key = await generateMatcherDecryptionKeyV1({
    keyId: 'matcher-a', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 1_000n,
  });
  return sealOrderEnvelopeV1({
    header: {
      clientRequestId: '8d246316-9c6b-4c9f-a7f5-b5d4ae874903',
      marketId: 'NIGHT-USDCX',
      epochId: 'epoch-7',
      commitment: '11'.repeat(32),
      traderTagHash: '22'.repeat(32),
    },
    matcherKey: matcherPublicKeyV1(key),
    plaintext: new TextEncoder().encode('{"side":"BUY","quantityLots":"7"}'),
    nowMs,
  });
}

async function sessionToken() {
  const sessions = new InMemorySessionChallengeService({
    nowMs: () => nowMs,
    challengeLifetimeMs: 100n,
    sessionLifetimeMs: 500n,
    verifier: { async verify() { return true; } },
    newId: () => 'challenge-1',
    random: (length) => new Uint8Array(length).fill(7),
  });
  const challenge = sessions.create({ domain: 'https://app.lunarveil.test', walletIdentity: 'wallet-public-key' });
  return { sessions, token: (await sessions.verify({ challengeId: challenge.id, signature: new Uint8Array([7]) })).token };
}

function repository(): { repository: AuthenticatedOrderEnvelopeRepository; submitted: Array<Uint8Array> } {
  const submitted: Uint8Array[] = [];
  return {
    submitted,
    repository: {
      async submit(input) {
        submitted.push(new Uint8Array(input.clientSignature));
        const result: OrderEnvelopeRepositoryResult = {
          replayed: false,
          record: {
            id: 'order-1',
            clientRequestId: input.envelope.clientRequestId,
            marketId: input.envelope.marketId,
            epochId: input.envelope.epochId,
            commitment: input.envelope.commitment,
            state: 'PENDING_CHAIN',
            createdAtMs: nowMs,
          },
        };
        return result;
      },
    },
  };
}

function service(
  sessions: InMemorySessionChallengeService,
  repositoryPort: AuthenticatedOrderEnvelopeRepository,
  options: { binding?: boolean; signature?: boolean } = {},
) {
  return new AuthenticatedOrderSubmissionServiceV1(
    sessions,
    { async verify() { return options.binding ?? true; } },
    { async verify() { return options.signature ?? true; } },
    repositoryPort,
  );
}

describe('AuthenticatedOrderSubmissionServiceV1', () => {
  it('authenticates and verifies the encrypted transport before durable submission', async () => {
    const { sessions, token } = await sessionToken();
    const repositoryPort = repository();
    const signature = new Uint8Array([7, 8, 9]);
    const result = await service(sessions, repositoryPort.repository).submit({
      bearerToken: token,
      envelope: await envelope(),
      clientSignature: signature,
    });

    expect(result.record.state).toBe('PENDING_CHAIN');
    expect(repositoryPort.submitted).toEqual([new Uint8Array([7, 8, 9])]);
    expect([...signature]).toEqual([7, 8, 9]);
  });

  it('fails closed before persistence for session, binding and signature errors', async () => {
    const { sessions, token } = await sessionToken();
    const repositoryPort = repository();
    const encrypted = await envelope();

    await expect(service(sessions, repositoryPort.repository).submit({
      bearerToken: 'altered', envelope: encrypted, clientSignature: new Uint8Array([7]),
    })).rejects.toMatchObject({ name: AuthenticatedOrderSubmissionError.name, code: 'SESSION_INVALID' });
    await expect(service(sessions, repositoryPort.repository, { binding: false }).submit({
      bearerToken: token, envelope: encrypted, clientSignature: new Uint8Array([7]),
    })).rejects.toMatchObject({ name: AuthenticatedOrderSubmissionError.name, code: 'IDENTITY_MISMATCH' });
    await expect(service(sessions, repositoryPort.repository, { signature: false }).submit({
      bearerToken: token, envelope: encrypted, clientSignature: new Uint8Array([7]),
    })).rejects.toMatchObject({ name: AuthenticatedOrderSubmissionError.name, code: 'INVALID_SIGNATURE' });
    expect(repositoryPort.submitted).toHaveLength(0);
  });
});
