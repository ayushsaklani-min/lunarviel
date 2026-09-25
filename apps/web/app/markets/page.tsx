import type { Metadata } from "next";

import { resolveApiBaseUrlV1, resolveDemoModeV1, resolveMarketContractAddressV1, resolveWalletNetworkV1 } from "../lib/apiConfig";
import { MarketsWorkspace } from "./markets-workspace";

export const metadata: Metadata = {
  title: "Markets — Lunarveil",
  description: "Public market configuration and epoch state, read live from the Lunarveil API.",
};

// The catalog is live data; a cached render would show a stale epoch.
export const dynamic = "force-dynamic";

/**
 * Server component. It resolves the API origin once, on the server, and hands
 * it to the client component as a prop — no bundler-specific client
 * environment mechanism, and one place where a bad origin fails.
 */
export default function MarketsPage() {
  const networkId = resolveWalletNetworkV1(process.env);
  const contractAddress = resolveMarketContractAddressV1(process.env, networkId);
  return (
    <MarketsWorkspace
      apiBaseUrl={resolveApiBaseUrlV1(process.env)}
      networkId={networkId}
      demoMode={resolveDemoModeV1(process.env)}
      {...(contractAddress === undefined ? {} : { contractAddress })}
    />
  );
}
