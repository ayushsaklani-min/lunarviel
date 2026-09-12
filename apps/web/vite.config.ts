import { sites } from "@openai/sites-vite-plugin";
import { existsSync, readFileSync } from "node:fs";
import wasm from "vite-plugin-wasm";
import vinext from "vinext";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
// Hosting metadata is optional and local; a clean clone must build without it.
const hostingPath = new URL("./.openai/hosting.json", import.meta.url);
const hostingConfig: { d1?: string; r2?: string } = existsSync(hostingPath)
  ? JSON.parse(readFileSync(hostingPath, "utf8"))
  : {};

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const deploymentPreset = process.env.NITRO_PRESET;

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "lunarveil-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "lunarveil-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      // @lunarveil/crypto's commitment uses the Compact runtime, which ships
      // as WebAssembly. Without this the client bundle cannot load it at all.
      wasm(),
      vinext(),
      ...(existsSync(hostingPath) ? [sites()] : []),
      ...(deploymentPreset === undefined
        ? [cloudflare({
          viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
          config: localBindingConfig,
        })]
        // Vercel reads its Build Output API directory from the repository root,
        // whereas this Vite workspace is nested under apps/web.
        : [nitro(deploymentPreset === "vercel"
          ? { output: { dir: "../../.vercel/output" } }
          : {})]),
    ],
  };
});
