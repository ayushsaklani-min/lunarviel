import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LunarveilApiClientV1,
  buildOrderSigningMessageV1,
  buildSessionSigningMessageV1,
  type LunarveilApiError,
  type OrderEnvelopeWireV1,
} from '@lunarveil/api-client';
import {
  generateMatcherDecryptionKeyV1,
  matcherPublicKeyV1,
  sealOrderEnvelopeV1,
  withOpenedOrderEnvelopeV1,
} from '@lunarveil/crypto';
import { AuthenticatedOrderSubmissionServiceV1, InMemorySessionChallengeService } from '@lunarveil/matcher';
import {
  HmacTraderSessionBindingVerifierV1,
  LedgerOrderEnvelopeSignatureVerifierV1,
  LedgerWalletSignatureVerifierV1,
} from '@lunarveil/wallet-auth';
import {
  addressFromKey,
  sampleSigningKey,
  signData,
  signatureVerifyingKey,
  verifySignature,
} from '@midnight-ntwrk/ledger-v8';

import type { LunarveilApiDependencies } from './lunarveilApi.js';
import type { LunarveilRuntimeConfigV1 } from './runtimeConfig.js';
import { startLunarveilApiV1, type StartedLunarveilApiV1 } from './server.js';

/**
 * The order-submission slice end to end, with nothing about the security path
 * faked.
 *
 * Real Fastify listener on a real port, real browser client over real HTTP,
 * real wallet signatures from real ledger keys, real HMAC trader tags, and a
 * real Web Crypto envelope that this test decrypts at the end to prove the
 * plaintext survived the round trip. Only the repository is in-memory; the
 * PostgreSQL path is covered by `apps/api-server`'s own integration suite.
 */

const nowMs = 1_800_000_000_000n;
const TRADER_TAG_KEY = new Uint8Array(32).fill(11);
const ledger = { verifySignature, addressFromKey };

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function wallet() {
  const signingKey = sampleSigningKey();
  const verifyingKey = signatureVerifyingKey(signingKey);
  return { signingKey, verifyingKey, identity: addressFromKey(verifyingKey) };
}

interface HarnessV1 {
  readonly client: LunarveilApiClientV1;
  readonly submitted: { envelope: OrderEnvelopeWireV1; clientSignature: Uint8Array }[];
}

let started: StartedLunarveilApiV1 | undefined;

afterEach(async () => {
  await started?.app.close();
  started = undefined;
});

async function harness(matcherPublicKey: Awaited<ReturnType<typeof matcherPublicKeyV1>>): Promise<HarnessV1> {
  const submitted: HarnessV1['submitted'] = [];
  const traderTags = new HmacTraderSessionBindingVerifierV1(TRADER_TAG_KEY);
  const sessions = new InMemorySessionChallengeService({
    nowMs: () => nowMs,
    challengeLifetimeMs: 60_000n,
    sessionLifetimeMs: 600_000n,
    verifier: new LedgerWalletSignatureVerifierV1(ledger),
  });

  const dependencies = {
    nowMs: () => nowMs,
    matcherKeys: { activePublicKey: () => matcherPublicKey },
    sessions,
    traderTags,
    orders: new AuthenticatedOrderSubmissionServiceV1(
      sessions,
      traderTags,
      new LedgerOrderEnvelopeSignatureVerifierV1(ledger),
      {
        async submit(input) {
          submitted.push({
            envelope: input.envelope as unknown as OrderEnvelopeWireV1,
            clientSignature: new Uint8Array(input.clientSignature),
          });
          return {
            replayed: false,
            record: {
              id: `order-${submitted.length}`,
              clientRequestId: input.envelope.clientRequestId,
              state: 'PENDING_CHAIN',
              createdAtMs: nowMs,
            },
          } as never;
        },
      },
    ),
    markets: { async listMarkets() { return []; }, async currentEpoch() { return undefined; } },
    systemStatus: {
      async read() { return { state: 'READY' as const, components: [{ name: 'DATABASE' as const, state: 'READY' as const }] }; },
    },
  } as unknown as LunarveilApiDependencies;

  const config: LunarveilRuntimeConfigV1 = {
    environment: 'development', host: '127.0.0.1', port: 0,
    bodyLimitBytes: 64 * 1024, allowedOrigins: [], trustProxy: false,
  };
  started = await startLunarveilApiV1(dependencies, config);
  return { client: new LunarveilApiClientV1({ baseUrl: started.address }), submitted };
}

async function openSession(client: LunarveilApiClientV1, user: ReturnType<typeof wallet>) {
  const challenge = await client.createSessionChallenge({
    domain: 'app.lunarveil.test',
    walletIdentity: user.identity,
  });
  const message = buildSessionSigningMessageV1({
    domain: challenge.domain,
    challengeId: challenge.id,
    nonce: challenge.nonce,
    walletIdentity: challenge.walletIdentity,
  });
  return client.verifySessionChallenge({
    challengeId: challenge.id,
    signature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
    verifyingKey: user.verifyingKey,
    signedData: base64Url(new TextEncoder().encode(message)),
  });
}

describe('encrypted order submission, end to end over real HTTP', () => {
  it('accepts a sealed, wallet-signed order and preserves the plaintext', async () => {
    const matcherKey = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-order-contract', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 600_000n,
    });
    const { client, submitted } = await harness(matcherPublicKeyV1(matcherKey));
    const user = wallet();

    const session = await openSession(client, user);
    // The tag is issued by the server; a client cannot compute its own.
    expect(session.traderTagHash).toMatch(/^[0-9a-f]{64}$/u);

    const plaintext = new TextEncoder().encode('{"side":"BUY","quantityLots":"7","limitPriceTicks":"101"}');
    const sealed = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: randomUUID(),
        marketId: 'market-1',
        epochId: 'epoch-1',
        commitment: randomUUID().replaceAll('-', '').repeat(2),
        traderTagHash: session.traderTagHash as string,
      },
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext,
      nowMs,
    });

    const message = buildOrderSigningMessageV1(sealed as unknown as OrderEnvelopeWireV1);
    const result = await client.submitOrder({
      bearerToken: session.token,
      envelope: sealed as unknown as OrderEnvelopeWireV1,
      clientSignature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
      verifyingKey: user.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    });

    expect(result.state).toBe('PENDING_CHAIN');
    expect(result.replayed).toBe(false);

    // What crossed the wire was ciphertext, and it decrypts to the order.
    const stored = submitted[0];
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored?.envelope)).not.toContain('BUY');
    // Scoped access: the plaintext is zeroed as soon as the callback returns.
    const side = await withOpenedOrderEnvelopeV1(
      stored?.envelope as never,
      matcherKey,
      plain => JSON.parse(new TextDecoder().decode(plain)) as { side: string },
    );
    expect(side.side).toBe('BUY');
  });

  it("refuses an order carrying another trader's tag", async () => {
    const matcherKey = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-order-contract', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 600_000n,
    });
    const { client, submitted } = await harness(matcherPublicKeyV1(matcherKey));
    const user = wallet();
    const session = await openSession(client, user);

    const sealed = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: randomUUID(),
        marketId: 'market-1',
        epochId: 'epoch-1',
        commitment: randomUUID().replaceAll('-', '').repeat(2),
        // A tag that is well-formed but is not this session's.
        traderTagHash: 'ab'.repeat(32),
      },
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: new TextEncoder().encode('{"side":"SELL"}'),
      nowMs,
    });
    const message = buildOrderSigningMessageV1(sealed as unknown as OrderEnvelopeWireV1);

    const error = await client.submitOrder({
      bearerToken: session.token,
      envelope: sealed as unknown as OrderEnvelopeWireV1,
      clientSignature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
      verifyingKey: user.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    }).catch((thrown: unknown) => thrown);

    expect((error as LunarveilApiError).serverCode).toBe('IDENTITY_MISMATCH');
    expect(submitted).toHaveLength(0);
  });

  it("refuses an order signed by a wallet other than the session's", async () => {
    const matcherKey = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-order-contract', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 600_000n,
    });
    const { client, submitted } = await harness(matcherPublicKeyV1(matcherKey));
    const user = wallet();
    const attacker = wallet();
    const session = await openSession(client, user);

    const sealed = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: randomUUID(),
        marketId: 'market-1',
        epochId: 'epoch-1',
        commitment: randomUUID().replaceAll('-', '').repeat(2),
        traderTagHash: session.traderTagHash as string,
      },
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: new TextEncoder().encode('{"side":"BUY"}'),
      nowMs,
    });
    const message = buildOrderSigningMessageV1(sealed as unknown as OrderEnvelopeWireV1);

    const error = await client.submitOrder({
      bearerToken: session.token,
      envelope: sealed as unknown as OrderEnvelopeWireV1,
      clientSignature: base64Url(hexToBytes(signData(attacker.signingKey, new TextEncoder().encode(message)))),
      verifyingKey: attacker.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    }).catch((thrown: unknown) => thrown);

    expect((error as LunarveilApiError).serverCode).toBe('INVALID_SIGNATURE');
    expect(submitted).toHaveLength(0);
  });

  it('refuses an order with no session at all', async () => {
    const matcherKey = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-order-contract', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 600_000n,
    });
    const { client, submitted } = await harness(matcherPublicKeyV1(matcherKey));
    const user = wallet();

    const sealed = await sealOrderEnvelopeV1({
      header: {
        clientRequestId: randomUUID(),
        marketId: 'market-1',
        epochId: 'epoch-1',
        commitment: randomUUID().replaceAll('-', '').repeat(2),
        traderTagHash: 'cd'.repeat(32),
      },
      matcherKey: matcherPublicKeyV1(matcherKey),
      plaintext: new TextEncoder().encode('{"side":"BUY"}'),
      nowMs,
    });
    const message = buildOrderSigningMessageV1(sealed as unknown as OrderEnvelopeWireV1);

    const error = await client.submitOrder({
      bearerToken: 'bm90LWEtcmVhbC10b2tlbg',
      envelope: sealed as unknown as OrderEnvelopeWireV1,
      clientSignature: base64Url(hexToBytes(signData(user.signingKey, new TextEncoder().encode(message)))),
      verifyingKey: user.verifyingKey,
      signedData: base64Url(new TextEncoder().encode(message)),
    }).catch((thrown: unknown) => thrown);

    expect((error as LunarveilApiError).code).toBe('REQUEST_REJECTED');
    expect(submitted).toHaveLength(0);
  });

  it('publishes the matcher key an envelope must be sealed to', async () => {
    const matcherKey = await generateMatcherDecryptionKeyV1({
      keyId: 'matcher-order-contract', activeFromMs: nowMs - 1n, expiresAtMs: nowMs + 600_000n,
    });
    const { client } = await harness(matcherPublicKeyV1(matcherKey));

    const published = await client.getMatcherKey();
    expect(published.keyId).toBe('matcher-order-contract');
    expect(published.algorithm).toBe('X25519-HKDF-SHA256-AES-256-GCM');
    // Public key metadata only: nothing private is ever published here.
    expect(JSON.stringify(published)).not.toContain('privateKey');
  });
});
