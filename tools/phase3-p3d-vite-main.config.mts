import { resolve } from "node:path";
import { defineConfig } from "vite";

const repositoryRoot = resolve(import.meta.dirname, "..");

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: resolve(repositoryRoot, ".local/phase3-p3d/app/dist/main"),
    rollupOptions: {
      external: ["electron"],
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        entryFileNames: "index.js",
        format: "cjs",
      },
    },
    sourcemap: false,
    ssr: resolve(repositoryRoot, "tools/phase3-p3d-test-main.ts"),
    target: "node24",
  },
  ssr: {
    external: ["electron"],
    noExternal: true,
    target: "node",
  },
});
