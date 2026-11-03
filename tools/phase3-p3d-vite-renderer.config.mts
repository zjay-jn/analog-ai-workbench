import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { P3D_RUNTIME_SCENARIOS_V1 } from "./phase3-p3d-runtime-contract.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const generatedRoot = resolve(
  repositoryRoot,
  ".local/phase3-p3d/generated-renderer",
);
const outputRoot = resolve(
  repositoryRoot,
  ".local/phase3-p3d/app/dist/renderer",
);

function strictCsp(): Plugin {
  const styleNonce = randomBytes(18).toString("base64");
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${styleNonce}'`,
    "connect-src 'none'",
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
    name: "aaw-p3d-strict-csp",
    transformIndexHtml(html) {
      return html
        .replace("__AAW_CSP__", policy)
        .replace("__AAW_STYLE_NONCE__", styleNonce);
    },
  };
}

function workspaceAlias(): Plugin {
  const replacement = resolve(
    repositoryRoot,
    "tools/phase3-p3d-workspace.tsx",
  );
  return {
    name: "aaw-p3d-workspace-alias",
    enforce: "pre",
    resolveId(source) {
      if (source === "./schematic/SchematicWorkspace") {
        return replacement;
      }
      return null;
    },
  };
}

function workspaceAliasProof(): Plugin {
  return {
    name: "aaw-p3d-workspace-alias-proof",
    generateBundle(_options, bundle) {
      const emittedCode = Object.values(bundle)
        .filter((entry) => entry.type === "chunk")
        .map((entry) => entry.code)
        .join("\n");
      for (const marker of [
        "data-p3d-terminal-state",
        "The renderer-entry exact reviewed identity binding drifted.",
      ]) {
        if (!emittedCode.includes(marker)) {
          throw new Error(`The P3-D test-only workspace alias proof is missing: ${marker}`);
        }
      }
    },
  };
}

mkdirSync(generatedRoot, { recursive: true });
const inputs: Record<string, string> = Object.create(null) as Record<string, string>;
for (const scenario of P3D_RUNTIME_SCENARIOS_V1.filter((entry) => entry.runnable)) {
  const entryPath = resolve(generatedRoot, `${scenario.caseId}.tsx`);
  const htmlPath = resolve(generatedRoot, `${scenario.caseId}.html`);
  writeFileSync(
    entryPath,
    [
      `import { mountP3dRendererV1 } from "/tools/phase3-p3d-renderer-mount.tsx";`,
      `import { p3dRuntimeScenarioByIdV1 } from "/tools/phase3-p3d-runtime-contract.ts";`,
      `mountP3dRendererV1(p3dRuntimeScenarioByIdV1(${JSON.stringify(scenario.caseId)}));`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    htmlPath,
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="__AAW_CSP__" />
    <meta name="aaw-style-nonce" content="__AAW_STYLE_NONCE__" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Analog AI Workbench · P3-D test-only</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${entryPath.slice(repositoryRoot.length + 1).replaceAll("\\", "/")}"></script>
  </body>
</html>
`,
    "utf8",
  );
  inputs[scenario.caseId] = htmlPath;
}

export default defineConfig({
  root: repositoryRoot,
  base: "./",
  plugins: [react(), workspaceAlias(), workspaceAliasProof(), strictCsp()],
  build: {
    emptyOutDir: true,
    outDir: outputRoot,
    rollupOptions: { input: inputs },
    sourcemap: false,
  },
});
