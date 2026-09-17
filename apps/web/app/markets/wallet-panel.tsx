"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LunarveilApiClientV1, SessionV1 } from "@lunarveil/api-client";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import { isLunarveilApiError } from "@lunarveil/api-client";
import { WalletConnectorError, type WalletDescriptor, type WalletRegistry } from "@lunarveil/midnight";
import { WalletSignatureError } from "@lunarveil/midnight";

import { discoverWalletsV1, openWalletSessionV1, shortenIdentityV1 } from "./walletSession";

export interface WalletSessionStateV1 {
  readonly walletIdentity: string;
  readonly session: SessionV1;
  readonly connected: ConnectedAPI;
  readonly verifyingKey: string;
}

/** After this long without an answer, Lace most likely did not open its window. */
export const WALLET_SLOW_HINT_MS = 3_000;
/** A wallet request left unanswered this long is abandoned so the user can retry. */
export const WALLET_APPROVAL_TIMEOUT_MS = 120_000;

class WalletApprovalTimeoutError extends Error {
  constructor() { super("WALLET_APPROVAL_TIMEOUT"); this.name = "WalletApprovalTimeoutError"; }
}

function failureCode(error: unknown): string {
  if (error instanceof WalletApprovalTimeoutError) return "WALLET_APPROVAL_TIMEOUT";
  // Recognize the extension transport failure without displaying arbitrary
  // extension messages (which may contain private information).
  if (error instanceof Error && /Receiving end does not exist|Extension context invalidated/u.test(error.message)) {
    return "WALLET_EXTENSION_UNAVAILABLE";
  }
  // Lace throws this when its approval window closes before the user answers
  // (observed on Preview). The request cannot complete; retrying reopens it.
  if (error instanceof Error && (error.name === "RemoteApiShutdownError" || /was shutdown: object can no longer be used/u.test(error.message))) {
    return "WALLET_APPROVAL_CLOSED";
  }
  const connectorCode = (error as { type?: unknown; code?: unknown } | null)?.type === "DAppConnectorAPIError"
    ? (error as { code?: unknown }).code
    : undefined;
  if (connectorCode === "Rejected" || connectorCode === "PermissionRejected") return "WALLET_REJECTED";
  if (connectorCode === "Disconnected") return "WALLET_DISCONNECTED";
  if (error instanceof WalletConnectorError) return error.code;
  if (error instanceof WalletSignatureError) return error.code;
  if (isLunarveilApiError(error)) {
    return error.serverCode === undefined ? error.code : `${error.code} · ${error.serverCode}`;
  }
  return "UNEXPECTED_FAILURE";
}

/**
 * Wallet connection and session establishment.
 *
 * The session token lives in this component's state for the lifetime of the
 * page and nowhere else: not `localStorage`, not a cookie, not a URL. A
 * reload deliberately requires signing again, which is the correct trade for a
 * bearer credential in a browser.
 */
export function WalletPanel({
  api,
  networkId,
  registry,
  onSession,
}: {
  api: LunarveilApiClientV1 | undefined;
  networkId: string;
  registry?: WalletRegistry | undefined;
  onSession?: (state: WalletSessionStateV1 | undefined) => void;
}) {
  const [wallets, setWallets] = useState<readonly WalletDescriptor[]>([]);
  const [busyWalletId, setBusyWalletId] = useState<string | undefined>(undefined);
  const [state, setState] = useState<WalletSessionStateV1 | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [slowWallet, setSlowWallet] = useState(false);
  // Each click starts a numbered attempt; a cancelled or timed-out attempt's
  // late result is ignored rather than opening a session behind the user's back.
  const attempt = useRef(0);

  const discover = useCallback(() => {
    const current = registry ?? (globalThis as { midnight?: WalletRegistry }).midnight;
    setWallets(discoverWalletsV1(current));
  }, [registry]);

  useEffect(() => {
    discover();
    // Extensions may inject after hydration, or when the user unlocks Lace.
    const timer = setInterval(discover, 1_000);
    globalThis.addEventListener("focus", discover);
    return () => {
      clearInterval(timer);
      globalThis.removeEventListener("focus", discover);
    };
  }, [discover]);

  useEffect(() => {
    if (busyWalletId === undefined) {
      setSlowWallet(false);
      return;
    }
    const timer = setTimeout(() => { setSlowWallet(true); }, WALLET_SLOW_HINT_MS);
    return () => { clearTimeout(timer); };
  }, [busyWalletId]);

  const connect = useCallback(async (walletId: string) => {
    const resolvedRegistry = registry ?? (globalThis as { midnight?: WalletRegistry }).midnight;
    if (api === undefined || resolvedRegistry === undefined) {
      setFailure("WALLET_UNAVAILABLE");
      return;
    }
    const current = ++attempt.current;
    setBusyWalletId(walletId);
    setFailure(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        openWalletSessionV1({
          registry: resolvedRegistry,
          walletId,
          networkId,
          domain: globalThis.location?.host ?? "localhost",
          api,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { reject(new WalletApprovalTimeoutError()); }, WALLET_APPROVAL_TIMEOUT_MS);
        }),
      ]);
      if (current !== attempt.current) return;
      setState(result);
      onSession?.(result);
    } catch (error) {
      if (current !== attempt.current) return;
      setFailure(failureCode(error));
      setState(undefined);
      onSession?.(undefined);
    } finally {
      clearTimeout(timer);
      if (current === attempt.current) setBusyWalletId(undefined);
    }
  }, [api, networkId, onSession, registry]);

  const cancel = useCallback(() => {
    attempt.current += 1;
    setBusyWalletId(undefined);
    setFailure(undefined);
  }, []);

  const disconnect = useCallback(() => {
    // Dropping the reference is the whole logout: nothing was persisted.
    setState(undefined);
    setFailure(undefined);
    onSession?.(undefined);
  }, [onSession]);

  return (
    <section className="workspace-panel" aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallet</h2>
      <p className="workspace-placeholder">Wallet network: <strong>{networkId}</strong>. Select this network in Midnight Lace.</p>

      {state !== undefined ? (
        <div className="wallet-connected">
          <p>
            <span className="wallet-connected-label">Session open</span>
            <code>{shortenIdentityV1(state.walletIdentity)}</code>
          </p>
          <button className="workspace-refresh" type="button" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      ) : wallets.length === 0 ? (
        <p className="workspace-placeholder">
          No compatible Midnight wallet detected. Lunarveil requires DApp Connector
          API <code>4.0.1</code>.
          {" "}Open and unlock the Midnight-enabled Lace extension, then retry detection.
        </p>
      ) : (
        <ul className="wallet-list">
          {wallets.map(wallet => (
            <li key={wallet.id}>
              <button
                className="wallet-option"
                type="button"
                disabled={busyWalletId !== undefined}
                onClick={() => { void connect(wallet.id); }}
              >
                {/* Wallet-supplied name rendered as a text node, never as markup. */}
                <span className="wallet-name">{wallet.name}</span>
                <span className="wallet-rdns">{wallet.rdns}</span>
                {wallet.duplicateRdns && (
                  <span className="wallet-warning">Duplicate identifier — verify this is the wallet you expect</span>
                )}
                {busyWalletId === wallet.id && <span className="wallet-busy">Awaiting approval…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {busyWalletId !== undefined && (
        <div className="wallet-waiting" role="status">
          <p>
            Waiting for Lace. Approve the request in the Lace window
            {slowWallet && <strong> — Lace didn't open a window? Click the Lace icon in your browser toolbar to see and approve the pending request.</strong>}
          </p>
          <button className="workspace-refresh" type="button" onClick={cancel}>Cancel request</button>
        </div>
      )}

      {state === undefined && busyWalletId === undefined && <button className="workspace-refresh" type="button" onClick={discover}>Retry wallet detection</button>}

      {failure !== undefined && (
        <p className="workspace-notice workspace-notice-error">
          <strong>Wallet session failed.</strong>{" "}
          <span>Reported <code>{failure}</code>. No session was opened.</span>
          {failure === "WALLET_EXTENSION_UNAVAILABLE" && <span> Open Lace, unlock it, and reload this tab. If Lace was updated, restart the browser.</span>}
          {failure === "NETWORK_MISMATCH" && <span> Select {networkId} in Lace and reconnect.</span>}
          {failure === "WALLET_APPROVAL_CLOSED" && <span> The Lace approval window closed before it was answered. Unlock Lace, click the wallet again and keep the popup open until you approve.</span>}
          {failure === "WALLET_REJECTED" && <span> The request was declined in Lace. Click the wallet again to retry.</span>}
          {failure === "WALLET_DISCONNECTED" && <span> Lace lost the connection. Unlock Lace, check it is on {networkId}, and click the wallet again.</span>}
          {failure === "WALLET_APPROVAL_TIMEOUT" && <span> Lace did not answer in time. Open Lace from the browser toolbar, unlock it, then click the wallet again.</span>}
        </p>
      )}

      <p className="wallet-note">
        Signing proves you control this address. Lunarveil never sees a seed, a
        private key or a balance, and the session token is held in memory only —
        reloading this page requires signing again.
      </p>
    </section>
  );
}
