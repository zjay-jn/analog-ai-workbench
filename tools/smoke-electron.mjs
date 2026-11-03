import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "..");
const electronBinary = require("electron");

const child = spawn(electronBinary, [projectRoot, "--aaw-smoke"], {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, AAW_SMOKE_TEST: "1" },
});
const smokeUserDataPath = resolve(
  projectRoot,
  ".local",
  "smoke-user-data",
  `electron-${child.pid}`,
);

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timeout = setTimeout(() => {
  child.kill();
  console.error("Electron smoke test exceeded the 20 second deadline.");
  process.exitCode = 1;
}, 20_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  rmSync(smokeUserDataPath, { recursive: true, force: true });
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("AAW_SMOKE_RESULT:"));
  if (code !== 0 || line === undefined) {
    console.error(
      JSON.stringify({
        ok: false,
        exitCode: code,
        stderr: stderr.slice(0, 1000),
      }),
    );
    process.exitCode = 1;
    return;
  }

  const result = JSON.parse(line.slice("AAW_SMOKE_RESULT:".length));
  const secure =
    result.ok === true &&
    result.rendererState?.state === "ready" &&
    result.rendererState?.hasProcess === false &&
    result.rendererState?.hasRequire === false &&
    result.rendererState?.styleSheetCount >= 1 &&
    result.rendererState?.styled === true &&
    result.rendererState?.apiExactSeven === true &&
    result.rendererState?.focusVisible === true &&
    result.rendererState?.keyboardReachable === true &&
    result.rendererState?.ariaContract === true &&
    result.rendererState?.cspClosed === true &&
    result.rendererState?.syntheticLabelVisible === true &&
    result.rendererState?.fixtureEditor?.mounted === true &&
    result.rendererState?.fixtureEditor?.synthetic === true &&
    result.rendererState?.fixtureEditor?.readOnly === true &&
    result.rendererState?.fixtureEditor?.fileControlsDisabled === true &&
    result.rendererState?.fixtureEditor?.cspNonceApplied === true &&
    result.rendererState?.layout?.hasThreeColumns === true &&
    result.rendererState?.layout?.noHorizontalOverflow === true &&
    result.rendererState?.schematicHost === true &&
    result.rendererState?.layout?.composerVisible === true &&
    result.rendererState?.layout?.pathVisible === true &&
    result.security?.sandbox === true &&
    result.security?.contextIsolation === true &&
    result.security?.nodeIntegration === false &&
    result.security?.webviewTag === false;
  const exactCounters = (value, keys, predicate) =>
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()) &&
    keys.every(key => Number.isSafeInteger(value[key]) && predicate(value[key]));
  const resourceTypes = ["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "object", "xhr", "ping", "cspReport", "media", "webSocket", "other"];
  const observation = result.observation;
  const observationIntegrity =
    observation?.installedBeforeLoad === true &&
    observation?.loadStarted === true &&
    observation?.guardObserversInstalled === true &&
    observation?.cdpEnabled?.Runtime === true &&
    observation?.cdpEnabled?.Log === true &&
    observation?.cdpEnabled?.Audits === true &&
    observation?.cdpFailures === 0 &&
    observation?.cdpMarkerObserved === true &&
    observation?.cspViolations === 0 &&
    observation?.securityLogEntries === 0 &&
    exactCounters(observation?.permittedRequests, ["mainFrame", "script", "stylesheet"], count => count > 0) &&
    exactCounters(observation?.guardEvents, ["navigation", "webview", "download", "createdWindow", "rendererGone"], count => count === 0);
  const productionBoundary =
    result.runtimeSecurity?.sandbox === true &&
    result.runtimeSecurity?.contextIsolation === true &&
    result.runtimeSecurity?.nodeIntegration === false &&
    result.runtimeSecurity?.webviewTag === false &&
    exactCounters(result.registrySizes, ["agent", "rag", "toolBroker", "fixture"], count => count === 0) &&
    result.productionRequestDenied === true &&
    observationIntegrity &&
    exactCounters(result.resourceRequests, resourceTypes, count => count === 0);

  console.log(JSON.stringify({ ...result, observationIntegrity, secure, productionBoundary, processExited: true }));
  if (!secure || !productionBoundary) process.exitCode = 1;
});
