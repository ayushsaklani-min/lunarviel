"use client";

import { useCallback, useEffect, useState } from "react";

import {
  isLunarveilApiError,
  type EpochResultV1,
  type LunarveilApiClientV1,
  type TraderOrderV1,
} from "@lunarveil/api-client";

import { formatAtomicV1 } from "./marketFormat";
import { ownerOrderSummaryV1, type OwnerOrderSummaryV1 } from "./ownerSecretVault";

import {
  ORDER_LIFECYCLE_PATH_V1,
  formatTimestampV1,
  groupOrdersByEpochV1,
  isTerminalOrderStateV1,
  orderLifecycleStepLabelV1,
  orderLifecycleStepV1,
  orderProgressToneV1,
  orderStateLabelV1,
  shortenHashV1,
} from "./orderLifecycle";

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly orders: readonly TraderOrderV1[] }
  | { readonly phase: "failed"; readonly code: string };

function failureCode(error: unknown): string {
  if (isLunarveilApiError(error)) {
    return error.serverCode === undefined ? error.code : `${error.code} · ${error.serverCode}`;
  }
  return "UNEXPECTED_FAILURE";
}

/**
 * The trader's own order lifecycle.
 *
 * State, timestamps, the public commitment and, once admitted, the chain
 * transaction come from the server. Side, size and limit come only from this
 * browser's encrypted vault — the server does not have them in plaintext —
 * so they appear only for orders placed from this browser.
 *
 * While any order can still advance, the list refreshes quietly every few
 * seconds; once every order has reached an end, it stops.
 */
const POLL_MS = 4_000;

export function OrderHistory({
  api,
  session,
  reloadToken,
  networkId,
  contractAddress,
  results,
}: {
  api: LunarveilApiClientV1 | undefined;
  session: { readonly token: string } | undefined;
  reloadToken?: number;
  networkId?: string;
  /** Public market contract address, for explorer links. */
  contractAddress?: string;
  /** Public batch outcomes by epoch id, to show the clearing price next to a fill. */
  results?: ReadonlyMap<string, EpochResultV1>;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [summaries, setSummaries] = useState<ReadonlyMap<string, OwnerOrderSummaryV1>>(new Map());

  const load = useCallback((quiet = false) => {
    if (api === undefined || session === undefined) return () => undefined;
    const controller = new AbortController();
    if (!quiet) setState({ phase: "loading" });
    void api.listMyOrders({ bearerToken: session.token }, { signal: controller.signal })
      .then(orders => { setState({ phase: "ready", orders }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted || quiet) return;
        setState({ phase: "failed", code: failureCode(error) });
      });
    return () => { controller.abort(); };
  }, [api, session]);

  useEffect(() => load(), [load, reloadToken]);

  const orders = state.phase === "ready" ? state.orders : undefined;
  const advancing = orders?.some(order => !isTerminalOrderStateV1(order.state)) ?? false;

  useEffect(() => {
    if (!advancing) return;
    let cancel: () => void = () => undefined;
    const timer = setInterval(() => { cancel(); cancel = load(true); }, POLL_MS);
    return () => { clearInterval(timer); cancel(); };
  }, [advancing, load]);

  useEffect(() => {
    if (orders === undefined) return;
    let active = true;
    void Promise.all(orders.map(async order => [order.commitment, await ownerOrderSummaryV1(order.commitment).catch(() => undefined)] as const))
      .then(entries => {
        if (!active) return;
        setSummaries(new Map(entries.filter((entry): entry is readonly [string, OwnerOrderSummaryV1] => entry[1] !== undefined)));
      });
    return () => { active = false; };
  }, [orders]);

  if (session === undefined) {
    return (
      <section className="workspace-panel" aria-labelledby="history-title">
        <h2 id="history-title">Your orders</h2>
        <p className="workspace-placeholder">
          Connect a wallet to see the orders placed from this address.
        </p>
      </section>
    );
  }

  return (
    <section className="workspace-panel" aria-labelledby="history-title">
      <header className="history-header">
        <h2 id="history-title">Your orders</h2>
        {advancing && <span className="history-live-badge" role="status">Live</span>}
        <button className="workspace-refresh" type="button" onClick={() => load()}>Refresh</button>
      </header>

      {state.phase === "loading" && (
        <p className="workspace-placeholder" role="status">Loading your orders…</p>
      )}

      {state.phase === "failed" && (
        <p className="workspace-notice workspace-notice-error">
          <strong>Order history unavailable.</strong>{" "}
          <span>The API returned <code>{state.code}</code>. No orders are shown rather than a partial list.</span>
        </p>
      )}

      {state.phase === "ready" && state.orders.length === 0 && (
        <p className="workspace-notice workspace-notice-info">
          <strong>No orders yet.</strong>{" "}
          <span>Orders placed from this wallet will appear here.</span>
        </p>
      )}

      {state.phase === "ready" && state.orders.length > 0 && (
        <div className="history-groups">
          {groupOrdersByEpochV1(state.orders).map(group => (
            <div key={group.epochId} className="history-group">
              <h3>Epoch <code>{shortenHashV1(group.epochId)}</code></h3>
              <ul className="history-list">
                {group.orders.map(order => (
                  <li key={order.orderId} className={`history-item history-${orderProgressToneV1(order.state)}`}>
                    <div className="history-row">
                      <span className="history-state">{orderStateLabelV1(order.state)}</span>
                      <span className="history-time">{formatTimestampV1(order.createdAtMs)}</span>
                    </div>

                    <OrderOutcome order={order} summary={summaries.get(order.commitment)} result={results?.get(order.epochId)} />

                    <LifecycleTrack state={order.state} />

                    <dl className="history-facts">
                      <div>
                        <dt>Commitment</dt>
                        <dd><code>{shortenHashV1(order.commitment)}</code></dd>
                      </div>
                      {order.chainAdmissionTxId !== undefined && (
                        <div>
                          <dt>Admission tx</dt>
                          <dd><code>{shortenHashV1(order.chainAdmissionTxId)}</code></dd>
                        </div>
                      )}
                      {order.admissionSubmittedTxId !== undefined && (
                        <div>
                          <dt>On-chain tx</dt>
                          <dd><code className="history-txid">{order.admissionSubmittedTxId}</code></dd>
                        </div>
                      )}
                      {order.leafIndex !== undefined && (
                        <div><dt>Leaf</dt><dd>{order.leafIndex}</dd></div>
                      )}
                      {order.acceptedAtMs !== undefined && (
                        <div><dt>Admitted</dt><dd>{formatTimestampV1(order.acceptedAtMs)}</dd></div>
                      )}
                    </dl>

                    {order.state === "PENDING_CHAIN" && order.admissionSubmittedTxId === undefined && (
                      <p className="history-note">
                        Encrypted and stored — waiting for the admission worker to prove and
                        submit its commitment on chain. This refreshes automatically.
                      </p>
                    )}

                    {order.admissionSubmittedTxId !== undefined && networkId === "preview"
                      && contractAddress !== undefined && (
                      <p className="history-note">
                        Commitment admitted on Midnight Preview.{" "}
                        <a
                          href={`https://preview.midnightexplorer.com/contracts/0x${contractAddress}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View contract on Midnight explorer
                        </a>
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="wallet-note">
        The server holds side, price and quantity only inside the ciphertext the
        matcher decrypts. The order details shown above come from this browser&apos;s
        encrypted vault, and only for orders placed here.
      </p>
    </section>
  );
}

function LifecycleTrack({ state }: { state: TraderOrderV1["state"] }) {
  const step = orderLifecycleStepV1(state);
  if (step === undefined) {
    return (
      <p className="history-track history-track-ended">
        Left the lifecycle at <strong>{orderStateLabelV1(state)}</strong>.
      </p>
    );
  }
  return (
    <ol className="history-track" aria-label="Order lifecycle">
      {ORDER_LIFECYCLE_PATH_V1.map((phase, index) => (
        <li
          key={phase}
          className={index <= step ? "history-step history-step-done" : "history-step"}
          aria-current={index === step ? "step" : undefined}
        >
          <span>{orderLifecycleStepLabelV1(phase)}</span>
        </li>
      ))}
      {isTerminalOrderStateV1(state) && <li className="history-step history-step-final"><span>Complete</span></li>}
    </ol>
  );
}

/** "Buy 10 @ 101 → filled at 100". Only the owner's own browser can say the first half. */
function OrderOutcome({
  order,
  summary,
  result,
}: {
  order: TraderOrderV1;
  summary: OwnerOrderSummaryV1 | undefined;
  result: EpochResultV1 | undefined;
}) {
  if (summary === undefined && result === undefined) return null;
  const traded = order.state === "FILLED" || order.state === "PARTIALLY_FILLED";
  return (
    <p className="history-outcome">
      {summary !== undefined && (
        <span className={`history-side history-side-${summary.side.toLowerCase()}`}>
          {summary.side === "BUY" ? "Buy" : "Sell"} {formatAtomicV1(summary.quantityLots)} @ {formatAtomicV1(summary.limitPriceTicks)}
        </span>
      )}
      {traded && result?.clearingPriceTicks !== undefined && (
        <span className="history-clearing">
          {order.state === "FILLED" ? "filled" : "partially filled"} at clearing price {formatAtomicV1(result.clearingPriceTicks)}
        </span>
      )}
      {order.state === "EXPIRED" && result !== undefined && (
        <span className="history-clearing">
          {result.clearingPriceTicks === undefined ? "no trade this batch" : `not reached — batch cleared at ${formatAtomicV1(result.clearingPriceTicks)}`}
        </span>
      )}
    </p>
  );
}
