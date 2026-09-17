import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LunarveilApiClientV1 } from "@lunarveil/api-client";

import { WalletPanel } from "./wallet-panel";

const NETWORK_ID = "undeployed";
const ADDRESS = "4a71380c5c1e5b9d2846a6d5a473645d64697a57dd0374dba5e26b04251dc330";

interface WalletBehaviourV1 {
  readonly address?: string;
  readonly apiVersion?: string;
  readonly signDataResult?: unknown;
  readonly signDataThrows?: Error;
  readonly connectionStatus?: string;
}

function fakeWallet(behaviour: WalletBehaviourV1 = {}) {
  return {
    rdns: "test.midnight.wallet",
    name: "Test Wallet",
    icon: "https://wallet.test/icon.png",
    apiVersion: behaviour.apiVersion ?? "4.0.1",
    async connect(networkId: string) {
      return {
        async getConnectionStatus() {
          return { status: behaviour.connectionStatus ?? "connected", networkId };
        },
        async getConfiguration() { return { networkId }; },
        async getUnshieldedAddress() { return { unshieldedAddress: behaviour.address ?? ADDRESS }; },
        async signData(data: string) {
          if (behaviour.signDataThrows !== undefined) throw behaviour.signDataThrows;
          return behaviour.signDataResult ?? {
            data,
            signature: "ab".repeat(64),
            verifyingKey: "cd".repeat(32),
          };
        },
      };
    },
  };
}

function stubApi(routes: Readonly<Record<string, { status?: number; body: unknown }>>): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) throw new Error("connect ECONNREFUSED");
    return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, async json() { return route.body; } };
  });
  return { bodies };
}

const challenge = {
  id: "challenge-1",
  domain: "localhost",
  walletIdentity: ADDRESS,
  nonce: "bm9uY2UtdmFsdWU",
  issuedAtMs: "1800000000000",
  expiresAtMs: "1800000060000",
};

const session = { token: "c2Vzc2lvbi10b2tlbg", expiresAtMs: "1800000600000" };

function api(): LunarveilApiClientV1 {
  return new LunarveilApiClientV1({ baseUrl: "http://127.0.0.1:3001" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WalletPanel", () => {
  it("converts Lace's Bech32m address to the backend ledger identity before signing", async () => {
    const { bodies } = stubApi({
      "/v1/sessions/challenges": { body: challenge },
      "/v1/sessions/verify": { body: session },
    });
    render(<WalletPanel api={api()} networkId="preview" registry={{ lace: fakeWallet({
      address: "mn_addr_preview1ffcnsrzurede62zx5m26gumyt4jxj7jhm5phfka9uf4sgfgacvcqhh4m92",
    }) }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    await waitFor(() => expect(screen.getByText("Session open")).toBeTruthy());
    expect(bodies[0]).toEqual({ domain: globalThis.location.host, walletIdentity: ADDRESS });
  });
  it("rediscovers Lace injected after mount and connects on the configured network", async () => {
    stubApi({
      "/v1/sessions/challenges": { body: challenge },
      "/v1/sessions/verify": { body: session },
    });
    vi.stubGlobal("midnight", undefined);
    render(<WalletPanel api={api()} networkId="preview" />);
    const provider = fakeWallet();
    const connect = vi.spyOn(provider, "connect");
    vi.stubGlobal("midnight", { lace: provider });
    fireEvent.click(screen.getByRole("button", { name: "Retry wallet detection" }));
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    await waitFor(() => expect(screen.getByText("Session open")).toBeTruthy());
    expect(connect).toHaveBeenCalledWith("preview");
  });

  it("detects late injection automatically", async () => {
    vi.stubGlobal("midnight", undefined);
    render(<WalletPanel api={api()} networkId="preview" />);
    vi.stubGlobal("midnight", { lace: fakeWallet() });
    await waitFor(() => expect(screen.getByRole("button", { name: /Test Wallet/u })).toBeTruthy(), { timeout: 2500 });
  });

  it("contains an extension connection rejection without exposing its raw message", async () => {
    const provider = fakeWallet();
    vi.spyOn(provider, "connect").mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist. private-detail"));
    render(<WalletPanel api={api()} networkId="preview" registry={{ lace: provider }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    await waitFor(() => expect(screen.getByText("WALLET_EXTENSION_UNAVAILABLE")).toBeTruthy());
    expect(screen.queryByText("Session open")).toBeNull();
    expect(document.body.textContent).not.toContain("private-detail");
  });

  it("reports a closed Lace approval window as retryable, observed from Lace on Preview", async () => {
    const provider = fakeWallet();
    const closed = Object.assign(new Error("Remote API with channel 'midnight-authenticator' was shutdown: object can no longer be used."), { name: "RemoteApiShutdownError" });
    vi.spyOn(provider, "connect").mockRejectedValue(closed);
    render(<WalletPanel api={api()} networkId="preview" registry={{ lace: provider }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    await waitFor(() => expect(screen.getByText("WALLET_APPROVAL_CLOSED")).toBeTruthy());
    expect(document.body.textContent).not.toContain("midnight-authenticator");
  });

  it("reports a connector rejection by its public code", async () => {
    const provider = fakeWallet();
    const rejected = Object.assign(new Error("user said no"), { type: "DAppConnectorAPIError", code: "Rejected", reason: "private-detail" });
    vi.spyOn(provider, "connect").mockRejectedValue(rejected);
    render(<WalletPanel api={api()} networkId="preview" registry={{ lace: provider }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    await waitFor(() => expect(screen.getByText("WALLET_REJECTED")).toBeTruthy());
    expect(document.body.textContent).not.toContain("private-detail");
  });

  it("tells the user to open Lace from the toolbar when its approval window does not appear", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const provider = fakeWallet();
      vi.spyOn(provider, "connect").mockImplementation(() => new Promise(() => undefined));
      render(<WalletPanel api={api()} networkId="preview" registry={{ lace: provider }} />);
      fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
      expect(screen.queryByText(/Click the Lace icon in your browser toolbar/u)).toBeNull();
      await vi.advanceTimersByTimeAsync(3_500);
      await waitFor(() => expect(screen.getByText(/Click the Lace icon in your browser toolbar/u)).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the user cancel a wallet request that never resolves", async () => {
    const provider = fakeWallet();
    vi.spyOn(provider, "connect").mockImplementation(() => new Promise(() => undefined));
    render(<WalletPanel api={api()} networkId="preview" registry={{ lace: provider }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Test Wallet/u }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText("Session open")).toBeNull();
    expect(screen.queryByText(/Wallet session failed/u)).toBeNull();
  });

  it("times out a wallet request with a retryable code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const provider = fakeWallet();
      vi.spyOn(provider, "connect").mockImplementation(() => new Promise(() => undefined));
      render(<WalletPanel api={api()} networkId="preview" registry={{ lace: provider }} />);
      fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
      await vi.advanceTimersByTimeAsync(120_500);
      await waitFor(() => expect(screen.getByText("WALLET_APPROVAL_TIMEOUT")).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it("hints the methods it will use right after connecting", async () => {
    stubApi({
      "/v1/sessions/challenges": { body: challenge },
      "/v1/sessions/verify": { body: session },
    });
    const provider = fakeWallet();
    const hintUsage = vi.fn(async () => undefined);
    const connect = provider.connect.bind(provider);
    vi.spyOn(provider, "connect").mockImplementation(async (networkId: string) => ({ ...(await connect(networkId)), hintUsage }));
    render(<WalletPanel api={api()} networkId={NETWORK_ID} registry={{ lace: provider }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test Wallet/u }));
    await waitFor(() => expect(screen.getByText("Session open")).toBeTruthy());
    expect(hintUsage).toHaveBeenCalledWith(["getUnshieldedAddress", "signData"]);
  });

  it("says plainly when no compatible wallet is installed", () => {
    render(<WalletPanel api={api()} networkId={NETWORK_ID} registry={{}} />);
    expect(screen.getByText(/No compatible Midnight wallet detected/u)).toBeTruthy();
  });

  it("ignores a wallet advertising an unsupported connector version", () => {
    render(
      <WalletPanel api={api()} networkId={NETWORK_ID} registry={{ w1: fakeWallet({ apiVersion: "3.2.0" }) }} />,
    );
    expect(screen.getByText(/No compatible Midnight wallet detected/u)).toBeTruthy();
  });

  it("completes the challenge/sign/verify round trip and reports an open session", async () => {
    const { bodies } = stubApi({
      "/v1/sessions/challenges": { body: challenge },
      "/v1/sessions/verify": { body: session },
    });
    const received: unknown[] = [];

    render(
      <WalletPanel
        api={api()}
        networkId={NETWORK_ID}
        registry={{ w1: fakeWallet() }}
        onSession={state => { received.push(state); }}
      />,
    );

    screen.getByRole("button", { name: /Test Wallet/u }).click();

    await waitFor(() => { expect(screen.getByText("Session open")).toBeTruthy(); });
    // The address is shortened, never printed in full.
    expect(screen.queryByText(ADDRESS)).toBeNull();
    expect(received).toHaveLength(1);

    const verifyBody = bodies[1] as Record<string, string>;
    expect(verifyBody.challengeId).toBe("challenge-1");
    expect(verifyBody.verifyingKey).toBe("cd".repeat(32));
    // The exact bytes the wallet reported signing are transported, so the
    // server can verify a wallet-chosen prefix it cannot reconstruct.
    expect(typeof verifyBody.signedData).toBe("string");
  });

  it("never writes the session token to browser storage", async () => {
    const setItem = vi.fn();
    const storage = {
      setItem, getItem: () => null, removeItem: () => undefined,
      clear: () => undefined, key: () => null, length: 0,
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);

    stubApi({
      "/v1/sessions/challenges": { body: challenge },
      "/v1/sessions/verify": { body: session },
    });

    render(<WalletPanel api={api()} networkId={NETWORK_ID} registry={{ w1: fakeWallet() }} />);
    screen.getByRole("button", { name: /Test Wallet/u }).click();
    await waitFor(() => { expect(screen.getByText("Session open")).toBeTruthy(); });

    // A bearer token in storage survives the tab and is readable by any script
    // that ever runs on this origin, so assert nothing was written at all.
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(document.body.textContent).not.toContain(session.token);
  });

  it("reports a declined signature as a code, without opening a session", async () => {
    stubApi({ "/v1/sessions/challenges": { body: challenge } });

    render(
      <WalletPanel
        api={api()}
        networkId={NETWORK_ID}
        registry={{ w1: fakeWallet({ signDataThrows: new Error("user rejected in wallet 0xdead") }) }}
      />,
    );
    screen.getByRole("button", { name: /Test Wallet/u }).click();

    await waitFor(() => { expect(screen.getByText("SIGNING_REFUSED")).toBeTruthy(); });
    expect(screen.queryByText("Session open")).toBeNull();
    expect(document.body.textContent).not.toContain("0xdead");
  });

  it("reports a malformed wallet signature result rather than sending it", async () => {
    const { bodies } = stubApi({ "/v1/sessions/challenges": { body: challenge } });

    render(
      <WalletPanel
        api={api()}
        networkId={NETWORK_ID}
        registry={{ w1: fakeWallet({ signDataResult: { data: "x", signature: "nope", verifyingKey: "nope" } }) }}
      />,
    );
    screen.getByRole("button", { name: /Test Wallet/u }).click();

    await waitFor(() => { expect(screen.getByText("INVALID_SIGNATURE_RESULT")).toBeTruthy(); });
    // Only the challenge request was ever sent.
    expect(bodies).toHaveLength(1);
  });

  it("surfaces a network mismatch from the connector as a code", async () => {
    stubApi({ "/v1/sessions/challenges": { body: challenge } });

    render(
      <WalletPanel
        api={api()}
        networkId={NETWORK_ID}
        registry={{ w1: fakeWallet({ connectionStatus: "disconnected" }) }}
      />,
    );
    screen.getByRole("button", { name: /Test Wallet/u }).click();

    await waitFor(() => { expect(screen.getByText("WALLET_DISCONNECTED")).toBeTruthy(); });
  });

  it("drops the session on disconnect", async () => {
    stubApi({
      "/v1/sessions/challenges": { body: challenge },
      "/v1/sessions/verify": { body: session },
    });
    const received: unknown[] = [];

    render(
      <WalletPanel
        api={api()}
        networkId={NETWORK_ID}
        registry={{ w1: fakeWallet() }}
        onSession={state => { received.push(state); }}
      />,
    );
    screen.getByRole("button", { name: /Test Wallet/u }).click();
    await waitFor(() => { expect(screen.getByText("Session open")).toBeTruthy(); });

    screen.getByRole("button", { name: "Disconnect" }).click();
    await waitFor(() => { expect(screen.queryByText("Session open")).toBeNull(); });
    expect(received[received.length - 1]).toBeUndefined();
  });

  it("states that Lunarveil never sees key material", () => {
    render(<WalletPanel api={api()} networkId={NETWORK_ID} registry={{}} />);
    expect(screen.getByText(/never sees a seed, a\s+private key or a balance/u)).toBeTruthy();
  });
});
