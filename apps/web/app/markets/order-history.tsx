"use client";

import { useCallback, useEffect, useState } from "react";

import {
  isLunarveilApiError,
  type LunarveilApiClientV1,
  type TraderOrderV1,
} from "@lunarveil/api-client";

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
 * Everything shown is workflow metadata the server already knows: state,
 * timestamps, the public commitment and, once admitted, the chain
 * transaction. No order contents are fetched, because none are available —
 * they exist only inside the ciphertext.
 *
 * The panel refreshes when the session changes or on request. It does not
 * poll: an order cannot currently advance past `PENDING_CHAIN`, so a ticking
 * request would imply progress that cannot happen.
 */
export function OrderHistory({
  api,
  session,
  reloadToken,
}: {
  api: LunarveilApiClientV1 | undefined;
  session: { readonly token: string } | undefined;
  reloadToken?: number;
}) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  const load = useCallback(() => {
    if (api === undefined || session === undefined) return () => undefined;
    const controller = new AbortController();
    setState({ phase: "loading" });
    void api.listMyOrders({ bearerToken: session.token }, { signal: controller.signal })
      .then(orders => { setState({ phase: "ready", orders }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ phase: "failed", code: failureCode(error) });
      });
    return () => { controller.abort(); };
  }, [api, session]);

  useEffect(() => load(), [load, reloadToken]);

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
                      {order.leafIndex !== undefined && (
                        <div><dt>Leaf</dt><dd>{order.leafIndex}</dd></div>
                      )}
                      {order.acceptedAtMs !== undefined && (
                        <div><dt>Admitted</dt><dd>{formatTimestampV1(order.acceptedAtMs)}</dd></div>
                      )}
                    </dl>

                    {order.state === "PENDING_CHAIN" && (
                      <p className="history-note">
                        This will not advance yet: nothing in this system submits an
                        admission transaction, so the order stays here indefinitely.
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
        Side, price and quantity are not shown because they are not available here —
        they exist only inside the ciphertext the matcher decrypts. What you see is
        the workflow record.
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
