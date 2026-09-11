import react from "@vitejs/plugin-react";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Component tests only. This is deliberately separate from `vite.config.ts`,
 * which loads the Cloudflare/vinext plugins needed to build and serve the
 * worker — none of which should run to render a component in jsdom.
 */
export default defineConfig({
  // Vitest resolves its own Vite copy, so the plugin's Vite types differ from
  // the app's by identity only. The cast keeps this file inside `tsc --noEmit`
  // instead of excluding it from the project.
  plugins: [react()] as ViteUserConfig["plugins"],
  // The app's tsconfig uses `jsx: "preserve"` for the framework build, which
  // would otherwise leave the classic runtime here.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
