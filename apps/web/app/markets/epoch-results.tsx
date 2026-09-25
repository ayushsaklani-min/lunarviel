"use client";

import type { EpochResultV1 } from "@lunarveil/api-client";

import { formatAtomicV1 } from "./marketFormat";
import { formatTimestampV1, shortenHashV1 } from "./orderLifecycle";

/**
 * Recent batch outcomes for one market: clearing price, volume and counts.
 *
 * These are the batch-level facts a frequent batch auction publishes. No
 * individual order appears here — who traded, which side and at what limit
 * stay encrypted.
 */
export function EpochResults({
  results,
  failure,
}: {
  results: readonly EpochResultV1[] | undefined;
  failure: string | undefined;
}) {
  return (
    <section className="workspace-panel" aria-labelledby="results-title">
      <h2 id="results-title">Recent batches</h2>

      {failure !== undefined && (
        <p className="workspace-notice workspace-notice-error">
          <strong>Results unavailable.</strong> <span>The API returned <code>{failure}</code>.</span>
        </p>
      )}

      {failure === undefined && results === undefined && (
        <p className="workspace-placeholder" role="status">Loading results…</p>
      )}

      {results !== undefined && results.length === 0 && (
        <p className="workspace-placeholder">
          No batch has cleared yet. Results appear here when an epoch closes and its solution is verified.
        </p>
      )}

      {results !== undefined && results.length > 0 && (
        <div className="results-table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th scope="col">Epoch</th>
                <th scope="col">Closed</th>
                <th scope="col">Orders</th>
                <th scope="col">Matched</th>
                <th scope="col">Clearing price</th>
                <th scope="col">Volume</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody>
              {results.map(result => (
                <tr key={result.epochId} data-state={result.state}>
                  <td>#{result.sequence}</td>
                  <td>{formatTimestampV1(result.closedAtMs)}</td>
                  <td>{result.orderCount}</td>
                  <td>{result.matchedOrderCount}</td>
                  <td>{result.clearingPriceTicks === undefined ? "—" : formatAtomicV1(result.clearingPriceTicks)}</td>
                  <td>{formatAtomicV1(result.totalVolumeLots)}</td>
                  <td>
                    <VerificationCell result={result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function VerificationCell({ result }: { result: EpochResultV1 }) {
  if (result.state === "INVALIDATED") {
    return <span className="results-badge results-badge-bad">Invalidated — nothing settled</span>;
  }
  if (result.orderCount === 0) return <span className="results-badge">Empty batch</span>;
  return (
    <span className="results-verification">
      <span className={`results-badge ${result.simulated ? "results-badge-sim" : "results-badge-good"}`}>
        {result.simulated ? "Re-verified (simulated proof)" : "Proof verified"}
      </span>
      {result.rejectedSolutionCount > 0 && (
        <span className="results-badge results-badge-bad" title="A forged solution was submitted and refused before settlement.">
          {result.rejectedSolutionCount} forged solution{result.rejectedSolutionCount === 1 ? "" : "s"} rejected
        </span>
      )}
      {result.proofReference !== undefined && (
        <code className="results-ref" title={result.proofReference}>{shortenHashV1(result.proofReference)}</code>
      )}
    </span>
  );
}
