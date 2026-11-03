import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

function strictCsp(command: "build" | "serve"): Plugin {
  const styleNonce = randomBytes(18).toString("base64");
  const connectSource =
    command === "serve"
      ? "connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173"
      : "connect-src 'none'";
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${styleNonce}'`,
    connectSource,
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join("; ");

  return {
    name: "aaw-strict-csp",
    transformIndexHtml(html) {
      return html
        .replace("__AAW_CSP__", policy)
        .replace("__AAW_STYLE_NONCE__", styleNonce);
    },
  };
}

// The .mts extension keeps Vite's config loader in an explicit ESM mode.
export default defineConfig(({ command }) => ({
  root: import.meta.dirname,
  base: "./",
  plugins: [react(), strictCsp(command)],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(import.meta.dirname, "../../dist/renderer"),
    emptyOutDir: true,
    sourcemap: false,
  },
}));
