import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "..");
const viteEntry = resolve(projectRoot, "node_modules/vite/bin/vite.js");
const electronBinary = require("electron");
const rendererUrl = "http://127.0.0.1:5173/";
const smokeMode = process.argv.includes("--smoke");

let viteProcess;
let electronProcess;
let smokeUserDataPath;
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (electronProcess !== undefined && electronProcess.exitCode === null) {
    electronProcess.kill();
  }
  if (viteProcess !== undefined && viteProcess.exitCode === null) {
    viteProcess.kill();
  }
  setTimeout(() => process.exit(exitCode), 100).unref();
}

async function waitForRenderer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl, { redirect: "error" });
      if (response.ok) return;
    } catch {
      // The fixed loopback development server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("The renderer development server did not become ready.");
}

viteProcess = spawn(
  process.execPath,
  [viteEntry, "--config", "apps/desktop/vite.config.mts"],
  { cwd: projectRoot, stdio: "inherit" },
);

viteProcess.on("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});

try {
  await waitForRenderer();
  electronProcess = spawn(
    electronBinary,
    smokeMode ? [projectRoot, "--aaw-smoke"] : [projectRoot],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, AAW_RENDERER_URL: rendererUrl },
    },
  );
  if (smokeMode && electronProcess.pid !== undefined) {
    smokeUserDataPath = resolve(
      projectRoot,
      ".local",
      "smoke-user-data",
      `electron-${electronProcess.pid}`,
    );
  }
  electronProcess.on("exit", (code) => {
    if (smokeUserDataPath !== undefined) {
      rmSync(smokeUserDataPath, { recursive: true, force: true });
    }
    stop(code ?? 0);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Development startup failed.");
  stop(1);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
