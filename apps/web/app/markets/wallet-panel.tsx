"use client";

import { useCallback, useEffect, useState } from "react";

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

function failureCode(error: unknown): string {
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

  const resolvedRegistry = registry ?? (globalThis as { midnight?: WalletRegistry }).midnight;

  useEffect(() => {
    setWallets(discoverWalletsV1(resolvedRegistry));
  }, [resolvedRegistry]);

  const connect = useCallback(async (walletId: string) => {
    if (api === undefined || resolvedRegistry === undefined) {
      setFailure("WALLET_UNAVAILABLE");
      return;
    }
    setBusyWalletId(walletId);
    setFailure(undefined);
    try {
      const result = await openWalletSessionV1({
        registry: resolvedRegistry,
        walletId,
        networkId,
        domain: globalThis.location?.host ?? "localhost",
        api,
      });
      setState(result);
      onSession?.(result);
    } catch (error) {
      setFailure(failureCode(error));
      setState(undefined);
      onSession?.(undefined);
    } finally {
      setBusyWalletId(undefined);
    }
  }, [api, networkId, onSession, resolvedRegistry]);

  const disconnect = useCallback(() => {
    // Dropping the reference is the whole logout: nothing was persisted.
    setState(undefined);
    setFailure(undefined);
    onSession?.(undefined);
  }, [onSession]);

  return (
    <section className="workspace-panel" aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallet</h2>

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

      {failure !== undefined && (
        <p className="workspace-notice workspace-notice-error">
          <strong>Wallet session failed.</strong>{" "}
          <span>Reported <code>{failure}</code>. No session was opened.</span>
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
