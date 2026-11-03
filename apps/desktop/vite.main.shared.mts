import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import {
  MAIN_BUILD_PROFILES_V1,
  type MainBuildProfileV1,
} from "./src/main/build-profile.js";

export function createMainViteConfig(
  profile: MainBuildProfileV1,
): UserConfig {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const entry = resolve(repositoryRoot, MAIN_BUILD_PROFILES_V1[profile].entry);

  return defineConfig({
    define: {
      __AAW_MAIN_DEVELOPMENT__: JSON.stringify(profile === "development"),
    },
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: resolve(import.meta.dirname, "../../dist/main/main"),
      rollupOptions: {
        external: ["electron"],
        output: {
          chunkFileNames: "chunks/[name]-[hash].js",
          entryFileNames: "index.js",
          format: "cjs",
        },
      },
      sourcemap: false,
      ssr: entry,
      target: "node24",
    },
    ssr: {
      external: ["electron"],
      noExternal: true,
      target: "node",
    },
  });
}
