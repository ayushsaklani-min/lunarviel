import { describe, expect, it } from 'vitest';

import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

import { WalletSignatureError, signSessionMessageV1 } from './walletSessionSignature.js';

const MESSAGE = 'lunarveil-session-v1\ndomain=app.lunarveil.test\nchallenge=c1\nnonce=n1\nwallet=w1';

const SIGNATURE = 'ab'.repeat(64);
const VERIFYING_KEY = 'cd'.repeat(32);

interface SignCallV1 { readonly data: string; readonly options: unknown }

function wallet(
  result: unknown,
  calls: SignCallV1[] = [],
): ConnectedAPI {
  return {
    async signData(data: string, options: unknown) {
      calls.push({ data, options });
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ConnectedAPI;
}

describe('signSessionMessageV1', () => {
  it('requests a text-encoded unshielded signature and normalizes the result', async () => {
    const calls: SignCallV1[] = [];
    const signed = await signSessionMessageV1(
      wallet({ data: MESSAGE, signature: SIGNATURE.toUpperCase(), verifyingKey: VERIFYING_KEY.toUpperCase() }, calls),
      MESSAGE,
    );

    expect(signed).toEqual({ signature: SIGNATURE, verifyingKey: VERIFYING_KEY, signedData: MESSAGE });
    // `text` is the only encoding whose meaning a person can read before approving.
    expect(calls[0]).toEqual({ data: MESSAGE, options: { encoding: 'text', keyType: 'unshielded' } });
  });

  it('keeps a wallet-supplied prefix in the reported signed data', async () => {
    const prefixed = `Midnight Signed Message:\n${MESSAGE}`;
    const signed = await signSessionMessageV1(
      wallet({ data: prefixed, signature: SIGNATURE, verifyingKey: VERIFYING_KEY }),
      MESSAGE,
    );
    expect(signed.signedData).toBe(prefixed);
  });

  it('reports a declined signature without echoing the wallet error', async () => {
    const declined = await signSessionMessageV1(
      wallet(new Error('user rejected in Lace: account 0x1234')),
      MESSAGE,
    ).catch((error: unknown) => error);

    expect(declined).toBeInstanceOf(WalletSignatureError);
    expect((declined as WalletSignatureError).code).toBe('SIGNING_REFUSED');
    expect(String(declined)).not.toContain('0x1234');
  });

  it('rejects a wallet that does not implement signData', async () => {
    await expect(signSessionMessageV1({} as ConnectedAPI, MESSAGE))
      .rejects.toThrow(new WalletSignatureError('SIGNING_UNSUPPORTED'));
  });

  it('rejects a malformed signature result rather than forwarding it', async () => {
    for (const result of [
      null,
      { data: MESSAGE, signature: 'not-hex', verifyingKey: VERIFYING_KEY },
      { data: MESSAGE, signature: SIGNATURE, verifyingKey: 'zz' },
      { data: '', signature: SIGNATURE, verifyingKey: VERIFYING_KEY },
      { signature: SIGNATURE, verifyingKey: VERIFYING_KEY },
    ]) {
      await expect(signSessionMessageV1(wallet(result), MESSAGE))
        .rejects.toThrow(new WalletSignatureError('INVALID_SIGNATURE_RESULT'));
    }
  });

  it('rejects an empty or oversized message before asking the wallet', async () => {
    const calls: SignCallV1[] = [];
    await expect(signSessionMessageV1(wallet({}, calls), ''))
      .rejects.toThrow(new WalletSignatureError('INVALID_SIGNATURE_RESULT'));
    await expect(signSessionMessageV1(wallet({}, calls), 'a'.repeat(4_097)))
      .rejects.toThrow(new WalletSignatureError('INVALID_SIGNATURE_RESULT'));
    expect(calls).toEqual([]);
  });
});
