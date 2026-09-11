import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

/**
 * Requests a session signature from a connected Midnight wallet.
 *
 * ## The capability is real, and was verified in the installed package
 *
 * `@midnight-ntwrk/dapp-connector-api@4.0.1` declares
 * `signData(data: string, options: SignDataOptions): Promise<Signature>` on
 * `WalletConnectedAPI`, with `SignDataOptions = { encoding: 'hex' | 'base64' |
 * 'text'; keyType: 'unshielded' }` and `Signature = { data, signature,
 * verifyingKey }`. An earlier note in this repository recorded that no generic
 * message-signing method existed; that is wrong for the installed version.
 * See ADR-0038.
 *
 * ## What the wallet returns, and why all three parts matter
 *
 * - `signature` and `verifyingKey` are hex strings, matching
 *   `@midnight-ntwrk/ledger-v8`'s `Signature` and `SignatureVerifyingKey`
 *   (both plain `string` aliases), so the server can verify them directly.
 * - `data` is "the data signed". The `signData` documentation states the input
 *   "will be prepended with right prefix" without specifying it, so the exact
 *   signed bytes are not reconstructible by the server. They are returned here
 *   and transported, and the server requires the canonical session message to
 *   be a suffix of them.
 *
 * ## Not yet exercised against a real wallet
 *
 * No Midnight browser wallet was available when this was written, so the
 * prefix behaviour is read from the declarations rather than observed. The
 * shape is verified against the installed types and the server-side
 * verification is tested against genuine ledger keys.
 */

export class WalletSignatureError extends Error {
  constructor(readonly code: 'SIGNING_UNSUPPORTED' | 'SIGNING_REFUSED' | 'INVALID_SIGNATURE_RESULT') {
    super(code);
    this.name = 'WalletSignatureError';
  }
}

export interface WalletSessionSignatureV1 {
  /** Hex signature, as `@midnight-ntwrk/ledger-v8` expects it. */
  readonly signature: string;
  /** Hex verifying key, from which the wallet's address is derivable. */
  readonly verifyingKey: string;
  /**
   * Exactly what the wallet reported signing, prefix included.
   *
   * Signing was requested with `encoding: 'text'`, so this is read as the
   * text that was signed and the bytes are its UTF-8 encoding. A wallet that
   * prepended a binary prefix could not report it through this `string`
   * field, and the server-side suffix check would then reject the result
   * rather than accept an unverifiable signature.
   */
  readonly signedData: string;
}

const HEX_PATTERN = /^[0-9a-fA-F]{2,4096}$/u;

/**
 * The wallet signs the message as text. `text` is the only encoding whose
 * meaning a person can be shown before approving; `hex`/`base64` would ask a
 * user to approve opaque bytes.
 */
export async function signSessionMessageV1(
  wallet: ConnectedAPI,
  message: string,
): Promise<WalletSessionSignatureV1> {
  if (typeof wallet !== 'object' || wallet === null || typeof wallet.signData !== 'function') {
    throw new WalletSignatureError('SIGNING_UNSUPPORTED');
  }
  if (typeof message !== 'string' || message.length === 0 || message.length > 4_096) {
    throw new WalletSignatureError('INVALID_SIGNATURE_RESULT');
  }

  let result: { data?: unknown; signature?: unknown; verifyingKey?: unknown };
  try {
    result = await wallet.signData(message, { encoding: 'text', keyType: 'unshielded' });
  } catch {
    // A user declining is the common case here; never surface the wallet's
    // own error text, which is not ours to render.
    throw new WalletSignatureError('SIGNING_REFUSED');
  }

  if (typeof result !== 'object' || result === null
    || typeof result.signature !== 'string' || !HEX_PATTERN.test(result.signature)
    || typeof result.verifyingKey !== 'string' || !HEX_PATTERN.test(result.verifyingKey)
    || typeof result.data !== 'string' || result.data.length === 0 || result.data.length > 8_192) {
    throw new WalletSignatureError('INVALID_SIGNATURE_RESULT');
  }

  return {
    signature: result.signature.toLowerCase(),
    verifyingKey: result.verifyingKey.toLowerCase(),
    signedData: result.data,
  };
}
