import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { EpochV1, LunarveilApiClientV1, MarketV1 } from "@lunarveil/api-client";

vi.mock("@lunarveil/api-client", async importOriginal => ({
  ...(await importOriginal<typeof import("@lunarveil/api-client")>()),
  buildOrderSigningMessageV1: vi.fn(() => "lunarveil-order-signing-message"),
}));

vi.mock("./sealOrder", () => ({
  buildSealedOrderV1: vi.fn(async () => ({ envelope: { commitment: "ab".repeat(32) }, commitment: "ab".repeat(32) })),
}));

import { OrderTicket } from "./order-ticket";

const market: MarketV1 = {
  id: "market-1",
  marketKey: "NIGHT-USDCX",
  baseAssetId: "night",
  quoteAssetId: "usdcx",
  tickSizeAtomic: "1",
  lotSizeAtomic: "100",
  epochDurationSeconds: 3600,
  maxOrdersPerEpoch: 4,
  minBatchPrivacy: 2,
  matchingRuleVersion: "rules-v1",
  status: "ACTIVE",
};

const epoch: EpochV1 = {
  id: "epoch-1",
  marketId: "market-1",
  sequence: "7",
  state: "OPEN",
  orderCount: 1,
  maxOrders: 4,
  scheduledCloseAtMs: "1800000060000",
  ruleVersion: "rules-v1",
  configHash: "ab".repeat(32),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderTicket(signData: () => Promise<unknown>) {
  const api = {
    getMatcherKey: vi.fn(async () => ({ keyId: "k", algorithm: "X25519-HKDF-SHA256-AES-256-GCM", publicKey: "A".repeat(43), activeFromMs: "0", expiresAtMs: "1900000000000", version: 1 })),
    submitOrder: vi.fn(),
  } as unknown as LunarveilApiClientV1;
  render(
    <OrderTicket
      api={api}
      market={market}
      epoch={epoch}
      session={{ token: "c2Vzc2lvbg", traderTagHash: "cd".repeat(32) }}
      wallet={{ connected: { signData } as never, verifyingKey: "ef".repeat(32) }}
      nowMs={1_800_000_000_000n}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Quantity/u), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText(/Limit price/u), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Encrypt and submit" }));
}

describe("OrderTicket", () => {
  it("tells the user to open Lace from the toolbar while the order signature waits", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderTicket(() => new Promise(() => undefined));
    await waitFor(() => expect(screen.getByRole("button", { name: /Encrypting and signing/u })).toBeTruthy());
    expect(screen.queryByText(/click the Lace icon in your browser toolbar/u)).toBeNull();
    await vi.advanceTimersByTimeAsync(3_500);
    await waitFor(() => expect(screen.getByText(/click the Lace icon in your browser toolbar/u)).toBeTruthy());
  });
});
