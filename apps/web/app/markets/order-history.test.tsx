import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LunarveilApiClientV1 } from "@lunarveil/api-client";

import { OrderHistory } from "./order-history";

const SESSION = { token: "c2Vzc2lvbi10b2tlbg" };

function api(): LunarveilApiClientV1 {
  return new LunarveilApiClientV1({ baseUrl: "http://127.0.0.1:3001" });
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "order-1",
    clientRequestId: "4b0f3a1e-2c5d-4f8a-9b7e-1d2c3f4a5b6c",
    marketId: "market-1",
    epochId: "epoch-1",
    commitment: "ab".repeat(32),
    state: "PENDING_CHAIN",
    createdAtMs: "1800000000000",
    ...overrides,
  };
}

function stub(payload: unknown, init: { status?: number } = {}): { requests: { url: string; headers: unknown }[] } {
  const requests: { url: string; headers: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, request: RequestInit) => {
    requests.push({ url, headers: request.headers });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      async json() { return payload; },
    };
  });
  return { requests };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrderHistory", () => {
  it("asks for orders with the session token and nothing else", async () => {
    const { requests } = stub({ orders: [order()] });
    render(<OrderHistory api={api()} session={SESSION} />);

    await waitFor(() => { expect(screen.getByText("Awaiting chain admission")).toBeTruthy(); });
    // No trader identifier is sent: the server derives whose orders these are.
    expect(requests[0]?.url).toBe("http://127.0.0.1:3001/v1/orders");
    expect(JSON.stringify(requests[0]?.headers)).toContain("Bearer");
  });

  it("says plainly that a pending order will not advance", async () => {
    stub({ orders: [order()] });
    render(<OrderHistory api={api()} session={SESSION} />);

    await waitFor(() => {
      expect(screen.getByText(/nothing in this system submits an\s+admission transaction/u)).toBeTruthy();
    });
  });

  it("shows admission evidence once an order is accepted", async () => {
    stub({
      orders: [order({
        state: "ACCEPTED",
        acceptedAtMs: "1800000060000",
        chainAdmissionTxId: "d8c46ec045fffdbdf85c517263d5f78b0b92350e4910e97ed784431f5fb08414",
        leafIndex: "3",
      })],
    });
    render(<OrderHistory api={api()} session={SESSION} />);

    await waitFor(() => { expect(screen.getByText("Admitted on chain")).toBeTruthy(); });
    expect(screen.getByText("Admission tx")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // The pending caveat is gone once the order actually advanced.
    expect(screen.queryByText(/stays here indefinitely/u)).toBeNull();
  });

  it("groups orders by epoch", async () => {
    stub({
      orders: [
        order({ orderId: "order-1", epochId: "epoch-2" }),
        order({ orderId: "order-2", epochId: "epoch-1" }),
        order({ orderId: "order-3", epochId: "epoch-2" }),
      ],
    });
    render(<OrderHistory api={api()} session={SESSION} />);

    await waitFor(() => { expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2); });
  });

  it("never displays order contents, because it never receives any", async () => {
    stub({ orders: [order()] });
    render(<OrderHistory api={api()} session={SESSION} />);

    await waitFor(() => { expect(screen.getByText("Awaiting chain admission")).toBeTruthy(); });
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("BUY");
    expect(text).not.toContain("SELL");
    expect(screen.getByText(/exist only inside the ciphertext/u)).toBeTruthy();
  });

  it("distinguishes an empty history from a failure", async () => {
    stub({ orders: [] });
    render(<OrderHistory api={api()} session={SESSION} />);
    await waitFor(() => { expect(screen.getByText("No orders yet.")).toBeTruthy(); });
    expect(screen.queryByText("Order history unavailable.")).toBeNull();
  });

  it("reports a sanitized code and lists nothing when the API fails", async () => {
    stub({ error: "SERVICE_UNAVAILABLE", code: "HISTORY_UNAVAILABLE" }, { status: 503 });
    render(<OrderHistory api={api()} session={SESSION} />);

    await waitFor(() => { expect(screen.getByText("Order history unavailable.")).toBeTruthy(); });
    expect(screen.getByText("SERVICE_UNAVAILABLE · HISTORY_UNAVAILABLE")).toBeTruthy();
  });

  it("asks for nothing without a session", () => {
    const { requests } = stub({ orders: [] });
    render(<OrderHistory api={api()} session={undefined} />);

    expect(screen.getByText(/Connect a wallet to see the orders/u)).toBeTruthy();
    expect(requests).toEqual([]);
  });
});
