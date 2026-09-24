import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the self-contained browser bundle: one ES module that includes @developer-footprint/core
 * and registers <developer-footprint-badge>. It is what a plain HTML page loads with
 * <script type="module">, with no bundler and no third-party CDN.
 *
 * Core is bundled from source so this build never depends on a prior build of core.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@developer-footprint/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("src/register.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "badge.js",
    },
    outDir: "dist/browser",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    sourcemap: false,
  },
});
