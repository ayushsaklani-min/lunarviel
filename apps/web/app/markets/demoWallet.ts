import type { WalletRegistry } from "@lunarveil/midnight";

/**
 * A development-only stand-in for a Midnight browser wallet.
 *
 * It implements just the DApp Connector `4.0.1` surface Lunarveil uses —
 * `connect`, connection status, configuration, the unshielded address and
 * `signData` — with a real `@midnight-ntwrk/ledger-v8` signing key. The server
 * therefore verifies genuine ledger signatures and derives the identity from
 * the verifying key exactly as it would for a real wallet; only the extension
 * UI is missing.
 *
 * The key holds no assets and is kept in this browser's `localStorage` so a
 * reload keeps the same demo identity (and its order history). It is offered
 * only when the page runs against the simulated chain. Never use it for
 * anything of value.
 */
export const DEMO_WALLET_ID = "lunarveil-demo-wallet";
const STORAGE_KEY = "lunarveil-demo-wallet-signing-key-v1";

const ICON = "data:image/svg+xml;base64," + btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#1b1f3b"/><circle cx="20" cy="12" r="9" fill="#e8e6f5"/></svg>',
);

type Ledger = typeof import("@midnight-ntwrk/ledger-v8");

let memoryKey: string | undefined;

function storedKey(ledger: Ledger): string {
  try {
    const existing = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (existing !== null && existing !== undefined && /^[0-9a-f]{2,256}$/u.test(existing)) return existing;
  } catch { /* Storage can be unavailable; fall back to memory. */ }
  const created = memoryKey ?? ledger.sampleSigningKey();
  memoryKey = created;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, created); } catch { /* memory only */ }
  return created;
}

/** Forgets the demo key, so the next connection is a brand-new trader. */
export function resetDemoWalletV1(): void {
  memoryKey = undefined;
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); } catch { /* nothing stored */ }
}

function demoInitialApi() {
  return {
    name: "Lunarveil demo wallet",
    icon: ICON,
    rdns: "dev.lunarveil.demo-wallet",
    apiVersion: "4.0.1",
    async connect(networkId: string) {
      // Loaded on demand: the ledger is WebAssembly and must not load during SSR.
      const ledger = await import("@midnight-ntwrk/ledger-v8");
      const signingKey = storedKey(ledger);
      const verifyingKey = ledger.signatureVerifyingKey(signingKey);
      const address = ledger.addressFromKey(verifyingKey);
      return {
        async getConnectionStatus() { return { status: "connected" as const, networkId }; },
        async getConfiguration() { return { networkId }; },
        async getUnshieldedAddress() { return { unshieldedAddress: address }; },
        async signData(data: string, options: { encoding: string; keyType: string }) {
          if (options.encoding !== "text" || options.keyType !== "unshielded") throw new Error("UNSUPPORTED_SIGN_OPTIONS");
          // No prefix: the demo wallet signs exactly the requested text.
          const signature = ledger.signData(signingKey, new TextEncoder().encode(data));
          return { data, signature, verifyingKey };
        },
      };
    },
  };
}

/** The page's wallet registry with the demo wallet added next to any real ones. */
export function withDemoWalletV1(registry: WalletRegistry | undefined): WalletRegistry {
  return { ...(registry ?? {}), [DEMO_WALLET_ID]: demoInitialApi() } as unknown as WalletRegistry;
}
