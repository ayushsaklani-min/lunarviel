import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { MarketsWorkspace } from "./markets-workspace";

const API_BASE_URL = "http://127.0.0.1:3001";

const market = {
  id: "market-1",
  marketKey: "NIGHT-USDCX",
  baseAssetId: "night",
  quoteAssetId: "usdcx",
  tickSizeAtomic: "1",
  lotSizeAtomic: "100000",
  epochDurationSeconds: 60,
  maxOrdersPerEpoch: 4,
  minBatchPrivacy: 2,
  matchingRuleVersion: "rules-v1",
  status: "ACTIVE",
};

const epoch = {
  id: "epoch-1",
  marketId: "market-1",
  sequence: "7",
  state: "OPEN",
  orderCount: 3,
  maxOrders: 4,
  scheduledCloseAtMs: "9000000000000",
  ruleVersion: "rules-v1",
  configHash: "ab".repeat(32),
};

const status = {
  state: "DEGRADED",
  components: [
    { name: "DATABASE", state: "READY" },
    { name: "CHAIN_SOURCE", state: "DEGRADED" },
  ],
};

type RouteMap = Readonly<Record<string, { status?: number; body: unknown }>>;

function stubFetch(routes: RouteMap): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      async json() { return route.body; },
    };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarketsWorkspace", () => {
  it("renders live markets and their public configuration", async () => {
    stubFetch({
      "/v1/markets": { body: { markets: [market] } },
      "/v1/system/status": { body: status },
    });

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);

    expect(screen.getByText(/^Loading markets…/)).toBeTruthy();
    await waitFor(() => { expect(screen.getByText("NIGHT / USDCX")).toBeTruthy(); });
    expect(screen.getByText("Accepting orders")).toBeTruthy();
    // Atomic integers are grouped, never rounded.
    expect(screen.getByText("100,000")).toBeTruthy();
  });

  it("shows the epoch for a selected market", async () => {
    stubFetch({
      "/v1/markets": { body: { markets: [market] } },
      "/v1/system/status": { body: status },
      "/v1/markets/market-1/epoch": { body: epoch },
    });

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);
    const card = await screen.findByRole("button", { name: /NIGHT \/ USDCX/u });
    card.click();

    await waitFor(() => { expect(screen.getByText("Collecting orders")).toBeTruthy(); });
    expect(screen.getByText(/3 of 4 orders admitted/u)).toBeTruthy();
    expect(screen.getByText("#7")).toBeTruthy();
  });

  it("reports a sanitized code and shows no catalog when the API fails", async () => {
    stubFetch({
      "/v1/markets": { status: 503, body: { error: "SERVICE_UNAVAILABLE", code: "DATABASE_UNAVAILABLE" } },
      "/v1/system/status": { body: status },
    });

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);

    await waitFor(() => { expect(screen.getByText("Markets unavailable.")).toBeTruthy(); });
    expect(screen.getByText("SERVICE_UNAVAILABLE · DATABASE_UNAVAILABLE")).toBeTruthy();
    // Failing closed: nothing invented to fill the page.
    expect(screen.queryByText("NIGHT / USDCX")).toBeNull();
  });

  it("never renders a raw transport error message", async () => {
    // Every route throws, so the client's NETWORK_FAILURE path is exercised.
    stubFetch({});

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);

    await waitFor(() => { expect(screen.getAllByText("NETWORK_FAILURE").length).toBeGreaterThan(0); });
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
    expect(document.body.textContent).not.toContain("127.0.0.1:3001");
  });

  it("keeps the catalog usable when only dependency status fails", async () => {
    stubFetch({ "/v1/markets": { body: { markets: [market] } } });

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);

    await waitFor(() => { expect(screen.getByText("NIGHT / USDCX")).toBeTruthy(); });
    expect(screen.getByText(/Dependency status unavailable/u)).toBeTruthy();
  });

  it("distinguishes an empty catalog from a failure", async () => {
    stubFetch({
      "/v1/markets": { body: { markets: [] } },
      "/v1/system/status": { body: status },
    });

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);

    await waitFor(() => { expect(screen.getByText("No markets configured.")).toBeTruthy(); });
    expect(screen.queryByText("Markets unavailable.")).toBeNull();
  });

  it("states plainly that the chain admission lifecycle cannot complete yet", async () => {
    stubFetch({
      "/v1/markets": { body: { markets: [market] } },
      "/v1/system/status": { body: status },
    });

    render(<MarketsWorkspace apiBaseUrl={API_BASE_URL} />);

    await waitFor(() => { expect(screen.getByText("NIGHT / USDCX")).toBeTruthy(); });
    // The UI must not imply a working order lifecycle that does not exist.
    expect(screen.getByText(/nothing submits an admission transaction/u)).toBeTruthy();
    expect(screen.getByText("PENDING_CHAIN")).toBeTruthy();
  });

  it("fails closed on a misconfigured API origin without attempting a request", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, async json() { return { markets: [] }; } };
    });

    render(<MarketsWorkspace apiBaseUrl="ftp://api.example.test" />);

    await waitFor(() => { expect(screen.getAllByText("INVALID_API_BASE_URL").length).toBeGreaterThan(0); });
    expect(calls).toEqual([]);
  });
});
