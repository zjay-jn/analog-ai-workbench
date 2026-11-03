import { resolve } from "node:path";
import { defineConfig } from "vite";

const repositoryRoot = resolve(import.meta.dirname, "..");
export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: resolve(repositoryRoot, ".local/phase4-p4d/app/dist/main"),
    rollupOptions: { external: ["electron"], output: { entryFileNames: "index.js", format: "cjs" } },
    sourcemap: false,
    ssr: resolve(repositoryRoot, "tools/phase4-p4d-test-main.ts"),
    target: "node24",
  },
  ssr: { external: ["electron"], noExternal: true, target: "node" },
});
