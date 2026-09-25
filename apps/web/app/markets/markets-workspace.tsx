"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  LunarveilApiClientV1,
  isLunarveilApiError,
  type EpochResultV1,
  type EpochV1,
  type MarketV1,
  type SystemStatusV1,
} from "@lunarveil/api-client";

import { EpochResults } from "./epoch-results";
import { OrderHistory } from "./order-history";
import { OrderTicket } from "./order-ticket";
import { WalletPanel, type WalletSessionStateV1 } from "./wallet-panel";
import {
  epochCapacityPercentV1,
  epochStateLabelV1,
  formatAtomicV1,
  formatEpochCountdownV1,
  marketAvailabilityV1,
  marketPairLabelV1,
  marketStatusLabelV1,
} from "./marketFormat";

type LoadState<T> =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly value: T }
  | { readonly phase: "failed"; readonly code: string };

/**
 * Turns any thrown value into a stable machine code.
 *
 * A rendered error is never an exception message: the API client already
 * strips server bodies, and this keeps an unexpected local throw from putting
 * arbitrary text on screen.
 */
function failureCode(error: unknown): string {
  if (isLunarveilApiError(error)) {
    return error.serverCode === undefined ? error.code : `${error.code} · ${error.serverCode}`;
  }
  return "UNEXPECTED_FAILURE";
}

const API_TIMEOUT_MS = 90_000;

function Notice({ tone, children }: { tone: "info" | "warn" | "error"; children: React.ReactNode }) {
  return <p className={`workspace-notice workspace-notice-${tone}`}>{children}</p>;
}

/** Epoch state and batch results refresh on this cadence while a market is selected. */
const LIVE_REFRESH_MS = 5_000;

export function MarketsWorkspace({
  apiBaseUrl,
  networkId = "undeployed",
  contractAddress,
  demoMode = false,
}: {
  apiBaseUrl: string;
  networkId?: string;
  /** Public market contract address, used only for explorer links. */
  contractAddress?: string;
  /** The API runs against the development-only simulated chain. */
  demoMode?: boolean;
}) {
  const client = useMemo(() => {
    try {
      // A free-tier Render API sleeps when idle and needs ~50 s to wake. The
      // client's 10 s default would report TIMEOUT for every first visit.
      return new LunarveilApiClientV1({ baseUrl: apiBaseUrl, timeoutMs: API_TIMEOUT_MS });
    } catch {
      return undefined;
    }
  }, [apiBaseUrl]);

  const [markets, setMarkets] = useState<LoadState<readonly MarketV1[]>>({ phase: "loading" });
  const [status, setStatus] = useState<LoadState<SystemStatusV1>>({ phase: "loading" });
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [epoch, setEpoch] = useState<LoadState<EpochV1> | undefined>(undefined);
  const [nowMs, setNowMs] = useState<bigint>(() => BigInt(Date.now()));
  const [wallet, setWallet] = useState<WalletSessionStateV1 | undefined>(undefined);
  // Bumped after a successful submission so the history reloads immediately.
  const [ordersVersion, setOrdersVersion] = useState(0);
  const [results, setResults] = useState<readonly EpochResultV1[] | undefined>(undefined);
  const [resultsFailure, setResultsFailure] = useState<string | undefined>(undefined);

  const loadCatalog = useCallback(() => {
    if (client === undefined) {
      setMarkets({ phase: "failed", code: "INVALID_API_BASE_URL" });
      setStatus({ phase: "failed", code: "INVALID_API_BASE_URL" });
      return () => undefined;
    }
    const controller = new AbortController();
    setMarkets({ phase: "loading" });
    setStatus({ phase: "loading" });

    void client.listMarkets({ signal: controller.signal })
      .then(value => { setMarkets({ phase: "ready", value }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMarkets({ phase: "failed", code: failureCode(error) });
      });

    // Dependency status is informational: its failure must not blank the page.
    void client.getSystemStatus({ signal: controller.signal })
      .then(value => { setStatus({ phase: "ready", value }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({ phase: "failed", code: failureCode(error) });
      });

    return () => { controller.abort(); };
  }, [client]);

  useEffect(() => loadCatalog(), [loadCatalog]);

  // A single market is the common case; select it so the page is usable at once.
  useEffect(() => {
    if (selectedId === undefined && markets.phase === "ready" && markets.value.length === 1) {
      setSelectedId(markets.value[0]!.id);
    }
  }, [markets, selectedId]);

  useEffect(() => {
    if (client === undefined || selectedId === undefined) return;
    let controller = new AbortController();
    setEpoch({ phase: "loading" });
    setResults(undefined);
    setResultsFailure(undefined);

    const refresh = (quiet: boolean) => {
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void client.getMarketEpoch(selectedId, { signal })
        .then(value => { setEpoch({ phase: "ready", value }); })
        .catch((error: unknown) => {
          if (signal.aborted || quiet) return;
          setEpoch({ phase: "failed", code: failureCode(error) });
        });
      void client.listEpochResults(selectedId, { limit: 10 }, { signal })
        .then(value => { setResults(value); setResultsFailure(undefined); })
        .catch((error: unknown) => {
          if (signal.aborted || quiet) return;
          setResultsFailure(failureCode(error));
        });
    };

    refresh(false);
    // Epochs close and roll on a schedule; keep the view current without a reload.
    const timer = setInterval(() => { refresh(true); }, LIVE_REFRESH_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [client, selectedId]);

  const resultsByEpoch = useMemo(
    () => new Map((results ?? []).map(result => [result.epochId, result])),
    [results],
  );

  useEffect(() => {
    const timer = setInterval(() => { setNowMs(BigInt(Date.now())); }, 1_000);
    return () => { clearInterval(timer); };
  }, []);

  const selected = markets.phase === "ready"
    ? markets.value.find(market => market.id === selectedId)
    : undefined;

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div>
          <span className="workspace-chapter">Workspace / 01</span>
          <h1>Markets</h1>
          <p className="workspace-lede">
            Public market configuration and epoch state, read live from the Lunarveil API.
            Nothing on this page is private: no order, balance or key material is requested.
          </p>
        </div>
        <button className="workspace-refresh" type="button" onClick={() => loadCatalog()}>
          Refresh
        </button>
      </header>

      {demoMode && (
        <div className="demo-banner" role="note">
          <strong>Prototype demo · simulated chain.</strong>{" "}
          Orders are really encrypted in your browser, really signed and really matched by the
          deterministic batch auction. What is simulated is the Midnight chain: admission, the
          frozen order-set root, the zero-knowledge proof (replaced by an independent
          re-verification of the solution) and settlement. Nothing here moves real assets.
        </div>
      )}

      <StatusStrip status={status} />

      <WalletPanel api={client} networkId={networkId} onSession={setWallet} demoMode={demoMode} />

      <section className="workspace-panel" aria-labelledby="markets-title">
        <h2 id="markets-title">Available markets</h2>

        {markets.phase === "loading" && (
          <p className="workspace-placeholder" role="status">Loading markets… The backend may need up to a minute to wake up.</p>
        )}

        {markets.phase === "failed" && (
          <Notice tone="error">
            <strong>Markets unavailable.</strong>{" "}
            <span>The API returned <code>{markets.code}</code>. Check that the backend is running and allows this site's origin, then press Refresh. A sleeping free-tier backend may take a moment to respond.</span>
          </Notice>
        )}

        {markets.phase === "ready" && markets.value.length === 0 && (
          <Notice tone="info">
            <strong>No markets configured.</strong>{" "}
            <span>The API is reachable and its catalog is empty.</span>
          </Notice>
        )}

        {markets.phase === "ready" && markets.value.length > 0 && (
          <ul className="market-list">
            {markets.value.map(market => (
              <li key={market.id}>
                <button
                  type="button"
                  className={`market-card${market.id === selectedId ? " market-card-selected" : ""}`}
                  aria-pressed={market.id === selectedId}
                  onClick={() => { setSelectedId(market.id); }}
                >
                  <span className="market-pair">{marketPairLabelV1(market)}</span>
                  <span className="market-key">{market.marketKey}</span>
                  <span className={`market-status market-status-${marketAvailabilityV1(market).toLowerCase()}`}>
                    {marketStatusLabelV1(market)}
                  </span>
                  <dl className="market-facts">
                    <div><dt>Tick</dt><dd>{formatAtomicV1(market.tickSizeAtomic)}</dd></div>
                    <div><dt>Lot</dt><dd>{formatAtomicV1(market.lotSizeAtomic)}</dd></div>
                    <div><dt>Epoch</dt><dd>{market.epochDurationSeconds}s</dd></div>
                    <div><dt>Min batch</dt><dd>{market.minBatchPrivacy}</dd></div>
                    <div><dt>Rule</dt><dd>{market.matchingRuleVersion}</dd></div>
                  </dl>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected !== undefined && (
        <section className="workspace-panel" aria-labelledby="epoch-title">
          <h2 id="epoch-title">Current epoch · {marketPairLabelV1(selected)}</h2>
          <EpochPanel epoch={epoch} nowMs={nowMs} />
        </section>
      )}

      {selected !== undefined && (
        <OrderTicket
          api={client}
          market={selected}
          epoch={epoch?.phase === "ready" ? epoch.value : undefined}
          session={wallet?.session}
          wallet={wallet === undefined
            ? undefined
            : { connected: wallet.connected, verifyingKey: wallet.verifyingKey }}
          nowMs={nowMs}
          demoMode={demoMode}
          onSubmitted={() => { setOrdersVersion(version => version + 1); }}
        />
      )}

      <OrderHistory
        api={client}
        session={wallet?.session}
        reloadToken={ordersVersion}
        networkId={networkId}
        results={resultsByEpoch}
        {...(contractAddress === undefined || demoMode ? {} : { contractAddress })}
      />

      {selected !== undefined && <EpochResults results={results} failure={resultsFailure} />}

      <footer className="workspace-footnote">
        {demoMode ? (
          <p>
            <strong>What this demo does and does not claim.</strong> Encryption, wallet
            signatures, commitments and batch matching are the real code paths. Chain
            admission, the close root, the fair-clearing proof and settlement are
            simulated by a development-only worker, and every artifact it invents is
            labelled <code>simulated:</code>. The matcher can decrypt submitted orders —
            V1 hides them from the public chain and other traders, not from the matcher.
          </p>
        ) : (
          <p>
            <strong>What this page does not yet claim.</strong> Settlement is a later
            slice. An order submitted here is encrypted, signed and stored; an
            operator-run admission worker then submits its public commitment to the
            Midnight Preview contract and records the finalized transaction. Epoch state shown here is the
            database workflow record, not the chain. The matcher can decrypt submitted
            orders — V1 hides them from the public chain and other traders, not from
            the matcher.
          </p>
        )}
      </footer>
    </main>
  );
}

function StatusStrip({ status }: { status: LoadState<SystemStatusV1> }) {
  if (status.phase === "loading") {
    return <p className="workspace-status workspace-status-loading" role="status">Checking dependencies…</p>;
  }
  if (status.phase === "failed") {
    return (
      <p className="workspace-status workspace-status-unavailable">
        Dependency status unavailable (<code>{status.code}</code>).
      </p>
    );
  }
  return (
    <div className={`workspace-status workspace-status-${status.value.state.toLowerCase()}`}>
      <span className="workspace-status-headline">System {status.value.state}</span>
      <ul>
        {status.value.components.map(component => (
          <li key={component.name}>
            <span>{component.name}</span>
            <em>{component.state}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EpochPanel({ epoch, nowMs }: { epoch: LoadState<EpochV1> | undefined; nowMs: bigint }) {
  if (epoch === undefined || epoch.phase === "loading") {
    return <p className="workspace-placeholder" role="status">Loading epoch…</p>;
  }
  if (epoch.phase === "failed") {
    return (
      <Notice tone="warn">
        <strong>No epoch to show.</strong>{" "}
        <span>The API returned <code>{epoch.code}</code>. A market with no open epoch is a normal state.</span>
      </Notice>
    );
  }

  const value = epoch.value;
  const percent = epochCapacityPercentV1(value);
  return (
    <div className="epoch-panel">
      <dl className="epoch-facts">
        <div><dt>Sequence</dt><dd>#{value.sequence}</dd></div>
        <div><dt>State</dt><dd>{epochStateLabelV1(value)}</dd></div>
        <div><dt>Closes in</dt><dd>{formatEpochCountdownV1(nowMs, value.scheduledCloseAtMs)}</dd></div>
        <div><dt>Rule</dt><dd>{value.ruleVersion}</dd></div>
      </dl>
      <div className="epoch-capacity">
        <div className="epoch-capacity-bar">
          <span style={{ width: `${percent}%` }} />
        </div>
        <p>
          {value.orderCount} of {value.maxOrders} orders admitted
          <span className="epoch-privacy-note">
            {" "}— order contents stay encrypted; only the count is public.
          </span>
        </p>
      </div>
      <p className="epoch-config-hash">
        Frozen config hash <code>{value.configHash}</code>
      </p>
    </div>
  );
}
