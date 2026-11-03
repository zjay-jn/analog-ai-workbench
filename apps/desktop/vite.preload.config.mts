import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: resolve(import.meta.dirname, "../../dist/preload"),
    rollupOptions: {
      external: ["electron"],
      output: {
        entryFileNames: "preload/index.js",
        format: "cjs",
      },
    },
    sourcemap: false,
    ssr: resolve(import.meta.dirname, "src/preload/index.ts"),
    target: "node24",
  },
  ssr: {
    external: ["electron"],
    noExternal: true,
    target: "node",
  },
});
