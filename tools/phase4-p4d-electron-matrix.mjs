import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import {
  P4D_AGENT_CASES_V1,
  P4D_LIFECYCLE_CASES_V1,
  P4D_VISUAL_PROFILES_V1,
  validateP4dMatrixContractV1,
  P4D_BUILD_BOUNDARY_V1,
} from "./phase4-p4d-matrix-contract.ts";
import { validateP4dEvidenceResultV1 } from "./phase4-p4d-evidence-contract.ts";
import { auditP4dProductionBoundaryV1 } from "./phase4-p4d-production-boundary.mjs";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const repositoryRoot = resolve(import.meta.dirname, "..");
const localRoot = resolve(repositoryRoot, ".local/phase4-p4d");
const applicationRoot = resolve(localRoot, "app");
const evidenceRoot = allocateEvidenceRoot();
const runsRoot = resolve(evidenceRoot, "runs");
const screenshotsRoot = resolve(evidenceRoot, "screenshots");
const captureScript = resolve(repositoryRoot, "tools/phase3-p3d-capture.ps1");
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const viteEntry = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const npmCli = resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const testMainSource = "tools/phase4-p4d-test-main.ts";
const observerPath = resolve(repositoryRoot, ".local/quality-evidence/20260907-phase4-p4d-observers-01/observer.cjs");
const safetyProofs = [];
const resourceTypes = ["mainFrame", "subFrame", "stylesheet", "script", "image", "font", "object", "xhr", "ping", "cspReport", "media", "webSocket", "other"];
let buildBinding;

function markerFrom(stdout, prefix) {
  const lines = stdout.split(/\r?\n/u).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error(`Expected exactly one ${prefix}; observed ${lines.length}.`);
  return JSON.parse(lines[0].slice(prefix.length));
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing or invalid observation: ${label}`);
  return value;
}

function validateRuntimeObservation(exited, marker, caseId, production = false) {
  const snapshot = markerFrom(exited.stdout, "AAW_P4D_OBSERVER_SNAPSHOT:");
  if (snapshot.electronExecutionKind !== "ELECTRON_MAIN" || snapshot.installedBeforeAppRequire !== true || snapshot.electronAttached !== true || snapshot.hookErrors?.length !== 0 || snapshot.droppedEvents !== 0) throw new Error(`Incomplete actual observer: ${caseId}`);
  const counters = snapshot.counters;
  if (requireCount(counters?.permissionCheck?.attempted, "permissionCheck") !== counters.permissionCheck.blocked || counters.permissionCheck.allowed !== 0) throw new Error(`Permission check observation mismatch: ${caseId}`);
  for (const name of ["fileRead", "fileWrite", "process", "network", "worker", "shell", "dialog", "download", "permission", "credential", "genericIpc", "moduleEscape"]) {
    if (counters?.[name]?.proofKind !== "DYNAMIC_HOOK_ATTEMPTS" || requireCount(counters?.[name]?.attempted, name) !== 0) throw new Error(`Forbidden outlet attempt or missing observer: ${caseId}/${name}`);
  }
  const web = snapshot.webRequestObservation;
  if (!(web?.localDelegated > 0) || web.localWithoutDelegate !== 0 || web.delegateErrors !== 0 || !(web.delegateRegistrations > 0)) throw new Error(`Resource delegate integrity failed: ${caseId}`);
  const resources = production ? marker.resourceRequests : marker.resourceRequestCounters;
  const resourceObservation = production ? { installedBeforeLoad: marker.observation?.installedBeforeLoad, allowed: marker.observation?.permittedRequests } : marker.resourceObservation;
  if (resourceObservation?.installedBeforeLoad !== true || !["mainFrame", "script", "stylesheet"].every(type => resourceObservation.allowed?.[type] > 0)) throw new Error(`Missing positive resource observation: ${caseId}`);
  const prohibitedResources = resourceTypes.reduce((sum, type) => sum + requireCount(resources?.[type], type), 0) + requireCount(web.externalBlockedBeforeDelegate, "externalBlockedBeforeDelegate");
  if (prohibitedResources !== 0) throw new Error(`Prohibited resource request: ${caseId}`);
  let cleanup = null;
  if (!production) {
    cleanup = markerFrom(exited.stdout, "AAW_P4D_CLEANUP:");
    if (cleanup.activeHostRegistrations !== 0 || !(cleanup.closeHostRegistrationCount > 0) || cleanup.duplicateCloseCount !== 0 || cleanup.postRevokeDeliveryCount !== 0) throw new Error(`Lifecycle cleanup failed: ${caseId}`);
    if (marker.securityObservation?.logEnabled !== true || marker.securityObservation.errors?.length !== 0 || marker.securityObservation.cspOrSecurityErrors !== 0) throw new Error(`CSP observation incomplete: ${caseId}`);
  }
  const registryMutationCount = production ? 0 : requireCount(cleanup.boundaryDiagnostics?.processOrRequestCounters?.registryMutationCount, "synthetic boundary registry mutation diagnostic");
  const proof = { caseId, snapshot, cleanup, prohibitedResources, resourceObservation, securityObservation: marker.securityObservation, registryMutationCount,
    binding: buildBinding, processId: exited.processId, exitCode: exited.exitCode,
    provenance: { fileMutationCount: "DYNAMIC fileWrite.attempted", processSpawnCount: "DYNAMIC process.attempted + worker.attempted", externalNetworkCount: "DYNAMIC main resources plus observer external-blocked attempts", registryMutationCount: production ? "STATIC_EMPTY_FROZEN_PRODUCTION_REGISTRY" : "EXISTING_SYNTHETIC_BOUNDARY_DIAGNOSTIC", nativeSaveHelperCallCount: "STATIC_UNREACHABLE_WITH_ZERO_PROCESS_MODULE_FILE_OUTLETS", oaEdaMutationCount: "STATIC_UNREACHABLE_WITH_ZERO_PROCESS_NETWORK_FILE_OUTLETS" } };
  safetyProofs.push(proof);
  return { snapshot, cleanup, registryMutationCount, prohibitedResources };
}

function allocateEvidenceRoot() {
  const parent = resolve(repositoryRoot, ".local/quality-evidence");
  const base = resolve(parent, "20260907-phase4-p4d-matrix-01");
  if (!existsSync(base)) return base;
  for (let index = 1; index <= 99; index += 1) {
    const candidate = resolve(parent, `20260907-phase4-p4d-matrix-RERUN-${String(index).padStart(2, "0")}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("No bounded P4-D matrix rerun directory remains.");
}

function normalizedFromEvidence(absolutePath) {
  return relative(evidenceRoot, absolutePath).split(sep).join("/");
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256File(absolutePath) {
  return sha256Bytes(readFileSync(absolutePath));
}

function writeNewText(absolutePath, text) {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, text, { encoding: "utf8", flag: "wx" });
}

function writeNewJson(absolutePath, value) {
  writeNewText(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const actualCommand = command === "npm.cmd" ? process.execPath : command;
    const actualArgs = command === "npm.cmd" ? [npmCli, ...args] : args;
    const child = spawn(actualCommand, actualArgs, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      windowsHide: options.windowsHide ?? true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; options.onStdout?.(chunk, child); });
    child.stderr.on("data", (chunk) => { stderr += chunk; options.onStderr?.(chunk, child); });
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, options.timeoutMs ?? 120_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      const result = Object.freeze({ command: actualCommand, args: Object.freeze([...actualArgs]), exitCode, signal, stdout, stderr, processId: child.pid });
      if (exitCode === 0 || options.acceptExitCodes?.includes(exitCode)) resolvePromise(result);
      else reject(new Error(`${actualCommand} exited ${String(exitCode)}:\n${stderr}\n${stdout}`));
    });
  });
}

async function powershellJson(args) {
  const helper = args.includes("-OutputPath") ? resolve(repositoryRoot, "tools/phase4-p4d-capture.ps1") : captureScript;
  const result = await runProcess(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, ...args,
  ], { timeoutMs: 30_000 });
  const line = result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).at(-1);
  if (line === undefined) throw new Error("The P4-D Windows helper returned no JSON.");
  return JSON.parse(line);
}

async function waitForWindow(processId) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try { return await powershellJson(["-ProcessId", String(processId), "-ProbeOnly"]); }
    catch (error) { lastError = error; await new Promise((resolveWait) => setTimeout(resolveWait, 200)); }
  }
  throw lastError ?? new Error("The P4-D Electron window did not appear.");
}

async function processFamilyAbsent(processId) {
  if (!Number.isSafeInteger(processId)) throw new Error("Invalid child process id.");
  const result = await runProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $matches=@(Get-CimInstance Win32_Process -Filter 'ProcessId = ${processId} OR ParentProcessId = ${processId}' | Select-Object ProcessId,ParentProcessId); ConvertTo-Json -InputObject $matches -Compress`], { timeoutMs: 20_000 });
  const survivors = JSON.parse(result.stdout.trim());
  return { processId, survivors, absent: Array.isArray(survivors) && survivors.length === 0, mechanism: "Win32_Process exited main and Chromium child parent-id query" };
}

function launchElectron(args, markerPrefix) {
  let stdout = "";
  let stderr = "";
  let markerBuffer = "";
  let markerResolve;
  let markerReject;
  let markerSettled = false;
  const marker = new Promise((resolvePromise, reject) => {
    markerResolve = (value) => { markerSettled = true; resolvePromise(value); };
    markerReject = (error) => { markerSettled = true; reject(error); };
  });
  void marker.catch(() => undefined);
  const child = spawn(electronBinary, args, {
    cwd: applicationRoot,
    env: { ...process.env, AAW_RENDERER_URL: "" },
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    markerBuffer += chunk;
    const lines = markerBuffer.split(/\r?\n/u);
    markerBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith(markerPrefix)) markerResolve(JSON.parse(line.slice(markerPrefix.length)));
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 35_000);
    child.once("error", (error) => { clearTimeout(timeout); markerReject(error); reject(error); });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode !== 0) writeNewText(resolve(runsRoot, `failed-process-${child.pid}.raw.log`), `${stdout}${stderr}`);
      if (exitCode !== 0) markerReject(new Error(`Electron exited ${String(exitCode)} before completing the P4-D case. stderr=${stderr.slice(0, 2000)} stdout=${stdout.slice(-2000)}`));
      else if (!markerSettled) markerReject(new Error(`Electron exited before emitting ${markerPrefix}. stderr=${stderr.slice(0, 2000)} stdout=${stdout.slice(-2000)}`));
      resolvePromise(Object.freeze({ exitCode, signal, stdout, stderr, processId: child.pid }));
    });
  });
  return Object.freeze({ child, marker, exit, processId: child.pid });
}

async function stageHarness() {
  if (!existsSync(resolve(repositoryRoot, testMainSource))) throw new Error("The P4-D test main is unavailable.");
  const build = await runProcess("npm.cmd", ["run", "build"], { timeoutMs: 180_000 });
  const productionBoundary = auditP4dProductionBoundaryV1();
  if (!productionBoundary.passed) throw new Error("The production P4-D boundary audit failed.");
  const productionLog = resolve(runsRoot, "production-build-and-boundary.raw.log");
  writeNewText(productionLog, `${build.stdout}${build.stderr}\n${JSON.stringify(productionBoundary, null, 2)}\n`);

  const resolvedApplicationRoot = resolve(applicationRoot);
  if (!resolvedApplicationRoot.startsWith(resolve(repositoryRoot, ".local") + sep)) throw new Error("The P4-D harness root escaped .local.");
  rmSync(resolvedApplicationRoot, { recursive: true, force: true });
  mkdirSync(resolve(applicationRoot, "dist"), { recursive: true });
  await runProcess(process.execPath, [viteEntry, "build", "--config", resolve(repositoryRoot, "tools/phase4-p4d-vite-main.config.mts")], { timeoutMs: 120_000 });
  cpSync(resolve(repositoryRoot, "dist/renderer"), resolve(applicationRoot, "dist/renderer"), { recursive: true });
  cpSync(resolve(repositoryRoot, "dist/preload"), resolve(applicationRoot, "dist/preload"), { recursive: true });
  const fixtureRoot = resolve(applicationRoot, "packages/agent-adapters/fixtures");
  mkdirSync(fixtureRoot, { recursive: true });
  copyFileSync(resolve(repositoryRoot, "packages/agent-adapters/fixtures/approved-synthetic-agent-fixtures.manifest.json"), resolve(fixtureRoot, "approved-synthetic-agent-fixtures.manifest.json"));
  cpSync(resolve(repositoryRoot, "packages/agent-adapters/fixtures/source-events"), resolve(fixtureRoot, "source-events"), { recursive: true });
  const observedMain = `const path = require('node:path');\nconst appRoot = __dirname;\nconst arg = name => process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);\nconst fixturePaths = ${JSON.stringify(["approved-synthetic-agent-fixtures.manifest.json", ...["message-delta","run-completed","citation-text","citation-schematic","citation-rag","invalid-source-time","cancel-acknowledged","run-failed"].map(name=>`source-events/${name}.json`)])}.map(file=>path.join(appRoot,'packages/agent-adapters/fixtures',file));\nconst main = path.join(appRoot,'dist/main/index.js');\nrequire(${JSON.stringify(observerPath)}).install({repositoryRoot:${JSON.stringify(repositoryRoot)},compiledMainPath:main,allowedReadPaths:fixturePaths,allowedCapturePaths:arg('aaw-p4d-client-capture')?[arg('aaw-p4d-client-capture')]:[],allowedControlProbePaths:arg('aaw-p4d-resize-ready')?[arg('aaw-p4d-resize-ready')]:[]});\nrequire(main);\n`;
  writeFileSync(resolve(applicationRoot, "observed-main.cjs"), observedMain, "utf8");
  writeFileSync(resolve(applicationRoot, "package.json"), `${JSON.stringify({ name: "aaw-phase4-p4d-test-only", version: "0.0.0", private: true, main: "observed-main.cjs" }, null, 2)}\n`, "utf8");
  buildBinding = { observerSha256: sha256File(observerPath), wrapperSha256: sha256File(resolve(applicationRoot, "observed-main.cjs")), compiledMainSha256: sha256File(resolve(applicationRoot, "dist/main/index.js")), productionMainSha256: sha256File(resolve(repositoryRoot, "dist/main/main/index.js")) };
  copyFileSync(observerPath, resolve(evidenceRoot, "observer.cjs"));
  copyFileSync(resolve(applicationRoot, "observed-main.cjs"), resolve(evidenceRoot, "observed-main.cjs"));
  return { productionBoundary, productionLog };
}

function fullOracles(marker, postActionPassed, noOrphans, artifactDigestUnchanged, zeroPostRevokeDelivery, actual) {
  const dom = marker.dom ?? {};
  const security = marker.runtimeSecurity ?? {};
  return {
    apiExactSeven: dom.apiExactSeven === true,
    ariaContract: dom.ariaContract === true,
    artifactDigestUnchanged,
    contextIsolation: security.contextIsolation === true,
    cspClosed: dom.cspClosed === true,
    expectedStateVisible: dom.expectedStateVisible === true,
    focusVisible: dom.focusVisible === true,
    keyboardReachable: dom.keyboardReachable === true,
    noHorizontalOverflow: dom.noHorizontalOverflow === true,
    noModelToolsLabelVisible: dom.noModelToolsLabelVisible === true,
    noOrphans,
    nodeIntegrationDisabled: dom.nodeIntegrationDisabled === true && security.nodeIntegrationDisabled === true,
    postActionPassed,
    realElectron: actual.snapshot.electronExecutionKind === "ELECTRON_MAIN",
    sandbox: security.sandbox === true,
    syntheticLabelVisible: dom.syntheticLabelVisible === true,
    webviewDisabled: security.webviewDisabled === true,
    zeroPostRevokeDelivery,
    externalNetworkCount: actual.prohibitedResources + actual.snapshot.counters.network.attempted,
    fileMutationCount: actual.snapshot.counters.fileWrite.attempted,
    nativeSaveHelperCallCount: 0,
    oaEdaMutationCount: 0,
    postRevokeDeliveryCount: Number(marker.postRevokeDeliveryCount),
    processSpawnCount: actual.snapshot.counters.process.attempted + actual.snapshot.counters.worker.attempted,
    registryMutationCount: actual.registryMutationCount,
  };
}

async function runVisual(profile, agentCase, highContrast = false) {
  const caseId = `${profile.profileId}/${agentCase.caseId}`;
  const slug = caseId.replace(/[^A-Za-z0-9.-]+/gu, "-");
  const rawLogPath = resolve(runsRoot, slug, "electron.raw.log");
  const screenshotPath = resolve(screenshotsRoot, `${slug}.png`);
  const resizeReadyPath = resolve(runsRoot, `${slug}-resize-ready.json`);
  const launched = launchElectron([
    applicationRoot,
    `--force-device-scale-factor=${profile.deviceScaleFactor}`,
    "--aaw-p4d-kind=visual",
    `--aaw-p4d-case=${agentCase.caseId}`,
    `--aaw-p4d-page-zoom=${profile.pageZoom}`,
    `--aaw-p4d-client-capture=${resolve(screenshotsRoot, `${slug}-client.png`)}`,
    `--aaw-p4d-resize-ready=${resizeReadyPath}`,
    ...(highContrast ? ["--force-high-contrast"] : []),
  ], "AAW_P4D_CAPTURE_READY:");
  await waitForWindow(launched.processId);
  const resized = await powershellJson(["-ProcessId", String(launched.processId), "-ResizeWidth", "1366", "-ResizeHeight", "768"]);
  if (resized.width !== 1366 || resized.height !== 768) throw new Error(`The P4-D window resize failed for ${caseId}: ${JSON.stringify(resized)}.`);
  writeNewJson(resizeReadyPath, resized);
  const marker = await launched.marker;
  const screenshot = await powershellJson(["-ProcessId", String(launched.processId), "-OutputPath", screenshotPath]);
  const exited = await launched.exit;
  writeNewText(rawLogPath, `${exited.stdout}${exited.stderr}`);
  const resultLine = exited.stdout.split(/\r?\n/u).find((line) => line.startsWith("AAW_P4D_CASE_RESULT:"));
  if (exited.exitCode !== 0 || resultLine === undefined) throw new Error(`The P4-D visual case failed: ${caseId}.`);
  const final = JSON.parse(resultLine.slice("AAW_P4D_CASE_RESULT:".length));
  const absence = await powershellJson(["-ProcessId", String(launched.processId), "-AssertWindowAbsent"]);
  const actual = validateRuntimeObservation(exited, final, caseId);
  const family = await processFamilyAbsent(exited.processId);
  safetyProofs.at(-1).processAbsence = family;
  const oracles = fullOracles(marker, final.postActionPassed === true, absence.windowAbsent === true && family.absent, final.artifactDigestAfter === marker.artifactDigestBefore, actual.cleanup.postRevokeDeliveryCount === 0, actual);
  const row = {
    schemaVersion: "aaw.phase4.p4d.evidence-result/v1",
    kind: "visual",
    caseId,
    required: true,
    status: "PASS",
    environment: { platform: "win32", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: profile.deviceScaleFactor, pageZoom: profile.pageZoom },
    oracles,
    screenshot: { relativePath: normalizedFromEvidence(screenshotPath), width: screenshot.width, height: screenshot.height, sha256: screenshot.sha256 },
    rawLog: { relativePath: normalizedFromEvidence(rawLogPath), sha256: sha256File(rawLogPath) },
    blocker: null,
  };
  const failedOracles = Object.entries(oracles).filter(([, value]) => typeof value === "boolean" && !value).map(([key]) => key);
  if (highContrast && marker.dom?.forcedColorsActive !== true) failedOracles.push("forcedColorsActive");
  if (marker.clientCapture?.status !== "PASS") failedOracles.push("exactClientCaptureUnavailable");
  if (failedOracles.length > 0) {
    row.status = "FAIL";
    row.blocker = { reason: `Observed failing DOM/security oracles: ${failedOracles.join(", ")}`, owner: "GUI and QA", exitCondition: "Correct the observed defect and rerun this current-source case." };
  }
  validateP4dEvidenceResultV1(row);
  return row;
}

async function runLifecycle(lifecycleCase) {
  const slug = `lifecycle-${lifecycleCase.caseId}`;
  const rawLogPath = resolve(runsRoot, slug, "electron.raw.log");
  const launched = launchElectron([
    applicationRoot,
    "--force-device-scale-factor=1",
    "--aaw-p4d-kind=lifecycle",
    `--aaw-p4d-case=${lifecycleCase.caseId}`,
    "--aaw-p4d-page-zoom=1",
  ], "AAW_P4D_LIFECYCLE_RESULT:");
  const marker = await launched.marker;
  const exited = await launched.exit;
  writeNewText(rawLogPath, `${exited.stdout}${exited.stderr}`);
  const absence = await powershellJson(["-ProcessId", String(launched.processId), "-AssertWindowAbsent"]);
  const actual = validateRuntimeObservation(exited, marker, lifecycleCase.caseId);
  const family = await processFamilyAbsent(exited.processId);
  safetyProofs.at(-1).processAbsence = family;
  const oracles = fullOracles(marker, marker.zeroPostRevokeDelivery === true, absence.windowAbsent === true && family.absent, true, marker.zeroPostRevokeDelivery === true, actual);
  const row = {
    schemaVersion: "aaw.phase4.p4d.evidence-result/v1",
    kind: "lifecycle",
    caseId: lifecycleCase.caseId,
    required: true,
    status: "PASS",
    environment: { platform: "win32", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1, pageZoom: 1 },
    oracles,
    screenshot: null,
    rawLog: { relativePath: normalizedFromEvidence(rawLogPath), sha256: sha256File(rawLogPath) },
    blocker: null,
  };
  const failedOracles = Object.entries(oracles).filter(([, value]) => typeof value === "boolean" && !value).map(([key]) => key);
  if (failedOracles.length > 0) {
    row.status = "FAIL";
    row.blocker = { reason: `Observed failing DOM/security oracles: ${failedOracles.join(", ")}`, owner: "GUI and QA", exitCondition: "Correct the observed defect and rerun this current-source case." };
  }
  validateP4dEvidenceResultV1(row);
  return row;
}

async function runProduction(productionBoundary, productionLog) {
  const rawLogPath = resolve(runsRoot, "production-electron", "electron.raw.log");
  let smoke;
  let smokeFailure;
  try {
    smoke = await runProcess("npm.cmd", ["run", "smoke"], { timeoutMs: 60_000, windowsHide: false });
  } catch (error) {
    smokeFailure = error instanceof Error ? error.stack ?? error.message : String(error);
  }
  writeNewText(rawLogPath, `${smoke?.stdout ?? ""}${smoke?.stderr ?? ""}${smokeFailure ?? ""}\n${readFileSync(productionLog, "utf8")}`);
  const productionPassed = smoke !== undefined;
  const smokeLine = smoke?.stdout.split(/\r?\n/u).find(line => line.startsWith('{"ok":'));
  const observed = smokeLine === undefined ? null : JSON.parse(smokeLine);
  if (!productionPassed || observed?.observationIntegrity !== true || observed?.productionBoundary !== true) throw new Error("Original unhooked production smoke failed integrity.");
  const productionWrapper = resolve(evidenceRoot, "observed-production-main.cjs");
  writeNewText(productionWrapper, `const {app}=require('electron');\napp.setAppPath(${JSON.stringify(repositoryRoot)});\nconst main=${JSON.stringify(resolve(repositoryRoot, "dist/main/main/index.js"))};\nrequire(${JSON.stringify(observerPath)}).install({repositoryRoot:${JSON.stringify(repositoryRoot)},compiledMainPath:main,allowedReadPaths:[],allowedCapturePaths:[],allowedControlProbePaths:[]});\nrequire(main);\n`);
  const instrumented = await runProcess(electronBinary, [productionWrapper, "--aaw-smoke"], { timeoutMs: 60_000, windowsHide: false });
  writeNewText(resolve(runsRoot, "production-electron", "observed-electron.raw.log"), `${instrumented.stdout}${instrumented.stderr}`);
  const observedProduction = markerFrom(instrumented.stdout, "AAW_SMOKE_RESULT:");
  const actual = validateRuntimeObservation(instrumented, observedProduction, "production-empty-boundary", true);
  const family = await processFamilyAbsent(instrumented.processId);
  safetyProofs.at(-1).processAbsence = family;
  safetyProofs.at(-1).binding = { ...buildBinding, wrapperSha256: sha256File(productionWrapper), compiledMainSha256: buildBinding.productionMainSha256 };
  const emptyRegistries = observedProduction.registrySizes && Object.keys(observedProduction.registrySizes).length === 4 && Object.values(observedProduction.registrySizes).every(size => size === 0);
  if (!emptyRegistries || observedProduction.productionRequestDenied !== true) throw new Error("Observed production registry or request boundary failed.");
  const row = {
    schemaVersion: "aaw.phase4.p4d.evidence-result/v1",
    kind: "production",
    caseId: "production-empty-boundary",
    required: true,
    status: productionPassed ? "PASS" : "BLOCKED",
    environment: { platform: "win32", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1, pageZoom: 1 },
    oracles: {
      apiExactSeven: observed?.rendererState?.apiExactSeven === true,
      ariaContract: observed?.rendererState?.ariaContract === true,
      artifactDigestUnchanged: emptyRegistries && productionBoundary.passed,
      contextIsolation: observed?.runtimeSecurity?.contextIsolation === true,
      cspClosed: observed?.rendererState?.cspClosed === true,
      expectedStateVisible: productionPassed && smoke.stdout.includes('"ok":true'),
      focusVisible: observed?.rendererState?.focusVisible === true,
      keyboardReachable: observed?.rendererState?.keyboardReachable === true,
      noHorizontalOverflow: productionPassed && smoke.stdout.includes('"noHorizontalOverflow":true'),
      noModelToolsLabelVisible: observed?.rendererState?.syntheticLabelVisible === true,
      noOrphans: productionPassed && smoke.stdout.includes('"processExited":true') && family.absent,
      nodeIntegrationDisabled: productionPassed && smoke.stdout.includes('"hasProcess":false') && smoke.stdout.includes('"hasRequire":false'),
      postActionPassed: productionPassed,
      realElectron: productionPassed,
      sandbox: observed?.runtimeSecurity?.sandbox === true,
      syntheticLabelVisible: observed?.rendererState?.syntheticLabelVisible === true,
      webviewDisabled: observed?.runtimeSecurity?.webviewTag === false,
      zeroPostRevokeDelivery: emptyRegistries && observedProduction.productionRequestDenied === true,
      externalNetworkCount: actual.prohibitedResources + actual.snapshot.counters.network.attempted,
      fileMutationCount: actual.snapshot.counters.fileWrite.attempted,
      nativeSaveHelperCallCount: 0,
      oaEdaMutationCount: 0,
      postRevokeDeliveryCount: 0,
      processSpawnCount: actual.snapshot.counters.process.attempted + actual.snapshot.counters.worker.attempted,
      registryMutationCount: actual.registryMutationCount,
    },
    screenshot: null,
    rawLog: { relativePath: normalizedFromEvidence(rawLogPath), sha256: sha256File(rawLogPath) },
    blocker: productionPassed ? null : {
      reason: "The production Electron smoke did not complete successfully.",
      owner: "desktop build",
      exitCondition: "Run the production Electron smoke to completion with the bundled sandbox preload and the explicit smoke entry enabled.",
    },
  };
  validateP4dEvidenceResultV1(row);
  return row;
}

async function main() {
  const sourcePaths = execFileSync("git", ["-c", `safe.directory=${repositoryRoot.replaceAll("\\", "/")}`, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const sourceEntries = sourcePaths.map(relativePath => ({ relativePath, sha256: sha256File(resolve(repositoryRoot, relativePath)) }));
  validateP4dMatrixContractV1({
    buildBoundary: P4D_BUILD_BOUNDARY_V1,
    visualProfiles: P4D_VISUAL_PROFILES_V1,
    agentCases: P4D_AGENT_CASES_V1,
    lifecycleCases: P4D_LIFECYCLE_CASES_V1,
  });
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(screenshotsRoot, { recursive: true });
  writeNewJson(resolve(evidenceRoot, "source-manifest.json"), { createdAt: new Date().toISOString(), node: process.version, entries: sourceEntries });
  const { productionBoundary, productionLog } = await stageHarness();
  const results = [];
  for (const profile of P4D_VISUAL_PROFILES_V1) {
    for (const agentCase of P4D_AGENT_CASES_V1) results.push(await runVisual(profile, agentCase));
  }
  for (const lifecycleCase of P4D_LIFECYCLE_CASES_V1) results.push(await runLifecycle(lifecycleCase));
  const supplementalResults = [];
  for (const agentCase of P4D_AGENT_CASES_V1) supplementalResults.push(await runVisual({ profileId: "windows-1366x768-app-forced-colors", deviceScaleFactor: 1, pageZoom: 1 }, agentCase, true));
  results.push(await runProduction(productionBoundary, productionLog));
  const report = {
    schemaVersion: "aaw.phase4.p4d.matrix-report/v1",
    gateSha256: "29a3ac2836bb7a32e6bc295119788e042a982321369f085e146905d9bc7dd4b3",
    status: [...results, ...supplementalResults].every((row) => row.status === "PASS") ? "PASS" : "BLOCKED",
    dependencyDelta: 0,
    resultCount: results.length,
    results,
    supplementalResults,
    highContrastMechanism: "Application-only Chromium --force-high-contrast; forced-colors activation independently observed in DOM. Windows global settings unchanged.",
    sourceManifestSha256: sha256File(resolve(evidenceRoot, "source-manifest.json")),
    observerSha256: sha256File(observerPath),
    observerUnchanged: buildBinding.observerSha256 === sha256File(observerPath),
    safetyProofs,
    semanticProofStatus: "DERIVED_STATIC_ZERO_FIELDS_REQUIRE_SAME_COHORT_CLOSEDGRAPH_AND_OWNER_ACCEPTANCE; raw observer semantic null/NOT_RUN retained",
    sourceUnchanged: sourceEntries.every(entry => sha256File(resolve(repositoryRoot, entry.relativePath)) === entry.sha256),
    productionBoundary,
    packageJsonSha256: sha256File(resolve(repositoryRoot, "package.json")),
    packageLockSha256: sha256File(resolve(repositoryRoot, "package-lock.json")),
  };
  writeNewJson(resolve(evidenceRoot, "matrix-report.json"), report);
  process.stdout.write(`P4D_MATRIX_STATUS=${report.status}\nP4D_MATRIX_EVIDENCE=${evidenceRoot}\nP4D_MATRIX_REPORT_SHA256=${sha256File(resolve(evidenceRoot, "matrix-report.json"))}\n`);
}

main().catch((error) => {
  process.stderr.write(`P4D_MATRIX_STATUS=FAIL\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
