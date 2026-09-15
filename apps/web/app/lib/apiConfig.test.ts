import { describe, expect, it } from "vitest";

import { ApiConfigError, DEFAULT_API_BASE_URL_V1, resolveApiBaseUrlV1, resolveWalletNetworkV1 } from "./apiConfig";

describe("resolveWalletNetworkV1", () => {
  it("uses undeployed only for local development", () => {
    expect(resolveWalletNetworkV1({})).toBe("undeployed");
    expect(() => resolveWalletNetworkV1({ LUNARVEIL_API_BASE_URL: "https://api.example.com" }))
      .toThrow("INVALID_CHAIN_NETWORK");
  });
  it("passes an explicitly configured network and rejects unknown networks", () => {
    expect(resolveWalletNetworkV1({ LUNARVEIL_CHAIN_NETWORK: "preview" })).toBe("preview");
    expect(() => resolveWalletNetworkV1({ LUNARVEIL_CHAIN_NETWORK: "testnet-02" }))
      .toThrow("INVALID_CHAIN_NETWORK");
  });
});

describe("resolveApiBaseUrlV1", () => {
  it("defaults to a loopback development API", () => {
    expect(resolveApiBaseUrlV1({})).toBe(DEFAULT_API_BASE_URL_V1);
    expect(resolveApiBaseUrlV1({ LUNARVEIL_API_BASE_URL: "  " })).toBe(DEFAULT_API_BASE_URL_V1);
  });

  it("accepts https anywhere and strips a trailing slash", () => {
    expect(resolveApiBaseUrlV1({ LUNARVEIL_API_BASE_URL: "https://api.lunarveil.test/" }))
      .toBe("https://api.lunarveil.test");
  });

  it("accepts plaintext http only on loopback", () => {
    expect(resolveApiBaseUrlV1({ LUNARVEIL_API_BASE_URL: "http://localhost:3001" }))
      .toBe("http://localhost:3001");
    // A deployed browser must never be pointed at a plaintext remote origin:
    // this is the transport that will carry order ciphertext in a later slice.
    expect(() => resolveApiBaseUrlV1({ LUNARVEIL_API_BASE_URL: "http://api.lunarveil.test" }))
      .toThrow(new ApiConfigError("INVALID_API_BASE_URL"));
  });

  it("rejects credentials, queries, fragments and unsupported schemes", () => {
    for (const value of [
      "https://user:secret@api.lunarveil.test",
      "https://api.lunarveil.test?token=abc",
      "https://api.lunarveil.test#fragment",
      "ws://api.lunarveil.test",
      "definitely not a url",
    ]) {
      expect(() => resolveApiBaseUrlV1({ LUNARVEIL_API_BASE_URL: value }))
        .toThrow(new ApiConfigError("INVALID_API_BASE_URL"));
    }
  });
});
