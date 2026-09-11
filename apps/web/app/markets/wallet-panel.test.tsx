import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LunarveilApiClientV1 } from "@lunarveil/api-client";

import { WalletPanel } from "./wallet-panel";

const NETWORK_ID = "undeployed";
const ADDRESS = "4a71380c5c1e5b9d2846a6d5a473645d64697a57dd0374dba5e26b04251dc330";

interface WalletBehaviourV1 {
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
        async getUnshieldedAddress() { return { unshieldedAddress: ADDRESS }; },
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
