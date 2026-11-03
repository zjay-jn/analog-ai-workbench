import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import {
  P3D_BUILD_BOUNDARY_V1,
  P3D_DELIVERY_SCENARIOS_V1,
  P3D_PAGE_ZOOM_CASE_IDS_V1,
  P3D_VISUAL_PROFILES_V1,
} from "./phase3-p3d-matrix-contract.ts";
import { validateP3dEvidenceResultV1 } from "./phase3-p3d-evidence-contract.ts";
import { auditP3dProductionBoundaryV1 } from "./phase3-p3d-production-boundary.mjs";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const repositoryRoot = resolve(import.meta.dirname, "..");
const localBuildRoot = resolve(repositoryRoot, ".local/phase3-p3d");
const harnessAppRoot = resolve(localBuildRoot, "app");
const evidenceRoot = resolve(repositoryRoot, P3D_BUILD_BOUNDARY_V1.outputRoot);
const runsRoot = resolve(evidenceRoot, "runs");
const screenshotsRoot = resolve(evidenceRoot, "screenshots");
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const captureScript = resolve(
  repositoryRoot,
  "tools/phase3-p3d-capture.ps1",
);
const viteEntry = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const npmCli = resolve(
  dirname(process.execPath),
  "node_modules/npm/bin/npm-cli.js",
);
const liveElectronRoots = new Set();

const runFamilies = Object.freeze({
  production: "P3D-WIN-PROD-100",
  dsf100: "P3D-WIN-DEV-100",
  dsf125: "P3D-WIN-DEV-125",
  dsf150: "P3D-WIN-DEV-150",
  zoom200: "P3D-WIN-DEV-ZOOM200",
  highContrast: "P3D-WIN-DEV-HC",
  race: "P3D-WIN-RACE",
});
const raceCaseIds = Object.freeze([
  "navigation",
  "reload",
  "revision-quarantine",
  "revision-revoke",
  "revision-switch",
  "unmount",
  "window-close",
]);
const requiredCaseIdsByProfile = Object.freeze({
  "windows-1366x768-dsf-100": new Set([
    "two-tabs-ready-current",
    "selection-and-net-current",
    "inspector-and-hierarchy-current",
    "blackbox-unavailable-current",
    "synthetic-overlay-current",
    "loading-delayed-resolve",
    "unverified-no-delivery",
    "historical-typed-delivery",
  ]),
  "windows-1366x768-dsf-125": new Set([
    "two-tabs-ready-current",
    "selection-and-net-current",
    "inspector-and-hierarchy-current",
  ]),
  "windows-1366x768-dsf-150": new Set([
    "two-tabs-ready-current",
    "selection-and-net-current",
    "inspector-and-hierarchy-current",
  ]),
  "windows-1366x768-page-zoom-200": new Set([
    ...P3D_PAGE_ZOOM_CASE_IDS_V1,
  ]),
  "windows-1366x768-high-contrast": new Set([
    "unicode-high-contrast-current",
  ]),
});

function isRequiredSummaryCase(profileId, caseId) {
  return requiredCaseIdsByProfile[profileId]?.has(caseId) === true;
}

function normalizedRelative(absolutePath) {
  return relative(evidenceRoot, absolutePath).split(sep).join("/");
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256File(absolutePath) {
  return sha256Bytes(readFileSync(absolutePath));
}

function assertInside(parent, candidate, label) {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  const inside = relative(resolvedParent, resolvedCandidate);
  if (inside.startsWith("..") || inside === "" || resolve(inside) === inside) {
    throw new Error(`${label} escaped its fixed parent.`);
  }
  return resolvedCandidate;
}

function writeNewJson(absolutePath, value) {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function writeNewText(absolutePath, value) {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, value, { encoding: "utf8", flag: "wx" });
}

function allocateRunId(prefix) {
  const first = `${prefix}-01`;
  if (!existsSync(resolve(runsRoot, first))) return first;
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${prefix}-RERUN-${String(index).padStart(2, "0")}`;
    if (!existsSync(resolve(runsRoot, candidate))) return candidate;
  }
  throw new Error(`No bounded rerun id remains for ${prefix}.`);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const spawnCommand = command === "npm.cmd" ? process.execPath : command;
    const spawnArgs = command === "npm.cmd" ? [npmCli, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      windowsHide: spawnCommand === electronBinary ? false : true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (spawnCommand === electronBinary && child.pid !== undefined) {
      liveElectronRoots.add(child.pid);
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk, child);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk, child);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (spawnCommand === electronBinary && child.pid !== undefined) {
        liveElectronRoots.delete(child.pid);
      }
      const result = Object.freeze({
        command: spawnCommand,
        args: Object.freeze([...spawnArgs]),
        exitCode: code,
        signal,
        stdout,
        stderr,
        processId: child.pid,
      });
      if (options.acceptExitCodes?.includes(code) || code === 0) {
        resolvePromise(result);
      } else {
        reject(
          new Error(
            `${basename(spawnCommand)} ${spawnArgs.join(" ")} exited ${String(code)}: ${stderr.slice(0, 800)}`,
          ),
        );
      }
    });
    if (options.timeoutMs !== undefined) {
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, options.timeoutMs).unref();
    }
    options.onSpawn?.(child);
  });
}

async function powershellJson(args, options = {}) {
  const result = await runProcess(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      captureScript,
      ...args,
    ],
    options,
  );
  const line = result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) throw new Error("The P3-D Windows helper returned no JSON.");
  return JSON.parse(line);
}

async function processTreeOrBlocked(processId) {
  try {
    const value = await powershellJson([
      "-ProcessId",
      String(processId),
      "-ProcessTree",
    ]);
    return Object.freeze({ ...value, observationAvailable: true });
  } catch {
    return Object.freeze({
      schemaVersion: "aaw.phase3-p3d.process-tree/v1",
      observationAvailable: false,
      processes: Object.freeze([]),
      blocker: "The locked Windows session denied process-tree observation.",
    });
  }
}

async function accessibilitySnapshotOrBlocked(processId) {
  try {
    const value = await powershellJson([
      "-ProcessId",
      String(processId),
      "-AccessibilitySnapshot",
    ]);
    return Object.freeze({ ...value, observationAvailable: true });
  } catch {
    return Object.freeze({
      schemaVersion: "aaw.phase3-p3d.accessibility-snapshot/v1",
      observationAvailable: false,
      interactiveDesktop: false,
      elementCount: 0,
      truncated: false,
      focusableElementCount: 0,
      visibleHorizontalBoundsWithinWindow: false,
      horizontalOverflowCount: 0,
      documentCount: 0,
      documentHorizontalBoundsWithinWindow: false,
      controlTypeCounts: Object.freeze({}),
      textFragments: Object.freeze([]),
    });
  }
}

async function waitForWindow(processId, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await powershellJson([
        "-ProcessId",
        String(processId),
        "-ProbeOnly",
      ]);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw lastError ?? new Error("The P3-D Electron window did not appear.");
}

function fixedProductFiles() {
  const roots = [
    "apps/desktop/src",
    "packages/document-contract/src",
    "packages/schematic-workbench/src",
    "packages/schematic-workbench/fixtures",
  ].map((entry) => resolve(repositoryRoot, entry));
  const files = [
    resolve(repositoryRoot, "package.json"),
    resolve(repositoryRoot, "package-lock.json"),
  ];
  const pending = [...roots];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files.sort();
}

function productSnapshot() {
  return Object.freeze(
    fixedProductFiles().map((file) =>
      Object.freeze({
        file: relative(repositoryRoot, file).split(sep).join("/"),
        sha256: sha256File(file),
      }),
    ),
  );
}

async function buildProduction() {
  const commands = [];
  for (const args of [
    ["run", "build:main"],
    ["run", "build:preload"],
    ["run", "build:renderer"],
  ]) {
    commands.push(
      await runProcess("npm.cmd", args, { timeoutMs: 120_000 }),
    );
  }
  return commands;
}

async function buildAndStageHarness() {
  const exactAppRoot = assertInside(localBuildRoot, harnessAppRoot, "P3-D app root");
  if (existsSync(exactAppRoot)) rmSync(exactAppRoot, { recursive: true, force: true });
  mkdirSync(exactAppRoot, { recursive: true });
  const rendererBuild = await runProcess(
    process.execPath,
    [
      viteEntry,
      "build",
      "--config",
      "tools/phase3-p3d-vite-renderer.config.mts",
    ],
    { timeoutMs: 120_000 },
  );
  const mainBuild = await runProcess(
    process.execPath,
    [viteEntry, "build", "--config", "tools/phase3-p3d-vite-main.config.mts"],
    { timeoutMs: 120_000 },
  );
  const stagedPreload = resolve(exactAppRoot, "dist/preload");
  cpSync(resolve(repositoryRoot, "dist/preload"), stagedPreload, {
    recursive: true,
    errorOnExist: true,
  });
  const stagedFixtures = resolve(exactAppRoot, "fixtures");
  mkdirSync(stagedFixtures, { recursive: true });
  copyFileSync(
    resolve(
      repositoryRoot,
      "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json",
    ),
    resolve(stagedFixtures, "approved-synthetic-fixtures.manifest.json"),
  );
  for (const fixture of [
    "flat-basic",
    "repeated-hierarchy",
    "same-label-different-net",
    "blackbox-child",
    "explicit-port-mapping",
    "empty-minimum",
    "max-boundary",
    "unicode-labels",
  ]) {
    copyFileSync(
      resolve(
        repositoryRoot,
        `packages/schematic-workbench/fixtures/${fixture}.json`,
      ),
      resolve(stagedFixtures, `${fixture}.json`),
    );
  }
  writeFileSync(
    resolve(exactAppRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "aaw-phase3-p3d-test-only",
        version: "0.0.0-test-only",
        private: true,
        main: "dist/main/index.js",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return Object.freeze({ rendererBuild, mainBuild });
}

function parseMarkerLine(line) {
  const index = line.indexOf(":");
  if (index <= 0) return null;
  const marker = line.slice(0, index);
  if (!marker.startsWith("AAW_P3D_")) return null;
  try {
    return Object.freeze({ marker, value: JSON.parse(line.slice(index + 1)) });
  } catch {
    return null;
  }
}

function profileForCapture(marker) {
  const scale = marker.environment.deviceScaleFactor;
  if (marker.pageZoom === 2) {
    return scale === 1 && marker.environment.forcedColorsActive === false
      ? "windows-1366x768-page-zoom-200"
      : null;
  }
  if (
    marker.caseId === "unicode-high-contrast-current" &&
    marker.environment.forcedColorsActive === true &&
    scale === 1
  ) {
    return "windows-1366x768-high-contrast";
  }
  if (marker.environment.forcedColorsActive === true) return null;
  if (scale === 1) return "windows-1366x768-dsf-100";
  if (scale === 1.25) return "windows-1366x768-dsf-125";
  if (scale === 1.5) return "windows-1366x768-dsf-150";
  return null;
}

function runFamilyForProfile(profileId) {
  if (profileId === "windows-1366x768-dsf-100") return runFamilies.dsf100;
  if (profileId === "windows-1366x768-dsf-125") return runFamilies.dsf125;
  if (profileId === "windows-1366x768-dsf-150") return runFamilies.dsf150;
  if (profileId === "windows-1366x768-page-zoom-200") return runFamilies.zoom200;
  if (profileId === "windows-1366x768-high-contrast") return runFamilies.highContrast;
  throw new Error("The P3-D visual profile is not closed.");
}

function evidenceOracles(marker, expected) {
  const dom = marker.dom;
  const counters = marker.counters;
  const expectedOverlay = expected.banners.includes("SYNTHETIC OVERLAY · NO AGENT");
  const noGeometryExpected = expected.geometryAllowed === false;
  const focusContractPassed =
    noGeometryExpected ||
    (expected.caseId === "inspector-and-hierarchy-current" ||
    expected.caseId === "selection-and-net-current"
      ? dom.focusContractPassed === true
      : dom.canvasKeyboardReachable === true);
  return Object.freeze({
    typedResolvePath: counters.resolve.attempts >= 1,
    exactRevisionBinding:
      expected.fixtureId === null ||
      marker.identity.artifactRef.artifactId ===
        `synthetic.circuit-ir.${expected.fixtureId}`,
    persistentBannerVisible: dom.persistentBannerVisible === true,
    overlayBannerVisible: dom.overlayBannerVisible === true,
    geometryAllowed: expected.geometryAllowed,
    noHorizontalOverflow: dom.noHorizontalOverflow === true,
    focusContract: focusContractPassed,
    ariaContract: dom.ariaContract === true,
    artifactDigestUnchanged:
      marker.hashes.registryBefore === marker.hashes.registryAfter,
    registryMutationCount: counters.registryMutationCount,
    productDocumentFileMutationCount: counters.productDocumentFileMutationCount,
    nativeSaveHelperCallCount: counters.nativeSaveHelperCallCount,
    oaEdaMutationCount: counters.oaEdaMutationCount,
    externalNetworkRequestCount: counters.requests.externalNetwork,
    processSpawnCount: counters.processSpawnCount,
    __pass:
      dom.terminalStateMatches === true &&
      dom.runtimeReady === true &&
      dom.persistentBannerVisible === true &&
      dom.overlayBannerVisible === expectedOverlay &&
      dom.geometryVisible === expected.geometryAllowed &&
      dom.freshness === expected.freshness &&
      dom.noHorizontalOverflow === true &&
      dom.ariaContract === true &&
      focusContractPassed &&
      dom.apiExact === true &&
      dom.hasProcess === false &&
      dom.hasRequire === false &&
      dom.cspClosed === true &&
      marker.security.sandbox === true &&
      marker.security.contextIsolation === true &&
      marker.security.nodeIntegration === true &&
      marker.security.webviewTag === true &&
      marker.hashes.registryBefore === marker.hashes.registryAfter &&
      counters.registryMutationCount === 0 &&
      counters.requests.externalNetwork === 0,
  });
}

function closedOracles(oracles) {
  const { __pass: _pass, ...closed } = oracles;
  return Object.freeze(closed);
}

function evidenceResult({
  phase,
  caseId,
  status,
  environment,
  oracles,
  screenshot,
  rawLog,
  blocker,
}) {
  const value = Object.freeze({
    schemaVersion: "aaw.phase3-p3d.evidence-result/v1",
    phase,
    caseId,
    required: true,
    status,
    environment: Object.freeze(environment),
    oracles: closedOracles(oracles),
    screenshot: screenshot === null ? null : Object.freeze(screenshot),
    rawLog: rawLog === null ? null : Object.freeze(rawLog),
    blocker: blocker === null ? null : Object.freeze(blocker),
  });
  validateP3dEvidenceResultV1(value);
  return value;
}

async function runExactProduction(runId, productionBoundary) {
  const runRoot = resolve(runsRoot, runId);
  mkdirSync(runRoot, { recursive: true });
  const stdoutChunks = [];
  const stderrChunks = [];
  const userDataPath = assertInside(
    localBuildRoot,
    resolve(localBuildRoot, `prod-user-data-${runId}`),
    "P3-D production user-data root",
  );
  if (existsSync(userDataPath)) {
    rmSync(userDataPath, { recursive: true, force: true });
  }
  let primary;
  const primaryExit = runProcess(
    electronBinary,
    [
      repositoryRoot,
      "--force-renderer-accessibility",
      `--user-data-dir=${userDataPath}`,
    ],
    {
      timeoutMs: 60_000,
      acceptExitCodes: [0, 1, null],
      onSpawn(child) {
        primary = child;
      },
      onStdout(chunk) {
        stdoutChunks.push(chunk);
      },
      onStderr(chunk) {
        stderrChunks.push(chunk);
      },
    },
  );
  while (primary === undefined) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  let initialWindowProbe;
  try {
    initialWindowProbe = await waitForWindow(primary.pid);
  } catch {
    const treeBeforeClose = await processTreeOrBlocked(primary.pid);
    if (primary.exitCode === null) primary.kill();
    const primaryResult = await primaryExit;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const treeAfterExit = await processTreeOrBlocked(primary.pid);
    const screenshot = Object.freeze({
      schemaVersion: "aaw.phase3-p3d.external-screenshot/v1",
      captureMethod: "not-run-locked-desktop",
      interactiveDesktop: false,
      width: 0,
      height: 0,
      sha256: null,
      outputPath: null,
    });
    const raw = {
      schemaVersion: "aaw.phase3-p3d.production-runtime/v1",
      primary: primaryResult,
      second: null,
      screenshot,
      treeBeforeClose,
      treeAfterExit,
      productionBoundary,
      windowAvailability: "blocked-no-visible-window",
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
    writeNewJson(resolve(runRoot, "production-runtime.json"), raw);
    return Object.freeze({
      screenshot,
      noOrphans:
        treeAfterExit.observationAvailable === true &&
        treeAfterExit.processes.length === 0,
      raw,
      runRoot,
    });
  }
  await powershellJson([
    "-ProcessId",
    String(primary.pid),
    "-ResizeWidth",
    "1366",
    "-ResizeHeight",
    "768",
  ]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  const accessibility = await accessibilitySnapshotOrBlocked(primary.pid);
  const screenshotPath = resolve(screenshotsRoot, `${runId}--production-empty.png`);
  const screenshotProbe = initialWindowProbe;
  const screenshot = screenshotProbe.interactiveDesktop === true
    ? await powershellJson([
        "-ProcessId",
        String(primary.pid),
        "-OutputPath",
        screenshotPath,
      ])
    : Object.freeze({
        schemaVersion: "aaw.phase3-p3d.external-screenshot/v1",
        captureMethod: "not-run-locked-desktop",
        interactiveDesktop: false,
        width: 0,
        height: 0,
        sha256: null,
        outputPath: null,
      });
  const treeBeforeClose = await processTreeOrBlocked(primary.pid);
  const second = await runProcess(
    electronBinary,
    [
      repositoryRoot,
      "--force-renderer-accessibility",
      `--user-data-dir=${userDataPath}`,
    ],
    { timeoutMs: 15_000, acceptExitCodes: [0, 1] },
  );
  await powershellJson([
    "-ProcessId",
    String(primary.pid),
    "-CloseWindow",
  ]);
  const primaryResult = await primaryExit;
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  const treeAfterExit = await processTreeOrBlocked(primary.pid);
  const noOrphans =
    treeAfterExit.observationAvailable === true &&
    treeAfterExit.processes.length === 0;
  const raw = {
    schemaVersion: "aaw.phase3-p3d.production-runtime/v1",
    primary: primaryResult,
    second,
    screenshot,
    treeBeforeClose,
    treeAfterExit,
    productionBoundary,
    accessibility,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
  writeNewJson(resolve(runRoot, "production-runtime.json"), raw);
  return Object.freeze({ screenshot, accessibility, noOrphans, raw, runRoot });
}

async function runTestMatrix(runIds) {
  const fullLogPath = resolve(
    runsRoot,
    runIds[runFamilies.race],
    "electron-runtime.jsonl",
  );
  mkdirSync(dirname(fullLogPath), { recursive: true });
  const fullLog = [];
  const captures = [];
  const races = [];
  const raceCaptures = [];
  const notRun = [];
  let testChild;
  let secondLaunched = false;
  let secondResult = null;
  let secondPromise = null;
  let carry = "";
  let captureQueue = Promise.resolve();
  const testRun = runProcess(
    electronBinary,
    [harnessAppRoot, "--force-renderer-accessibility"],
    {
    timeoutMs: 300_000,
    acceptExitCodes: [0, 1],
    onSpawn(child) {
      testChild = child;
    },
    onStdout(chunk) {
      carry += chunk;
      const lines = carry.split(/\r?\n/u);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        fullLog.push(line);
        const parsed = parseMarkerLine(line);
        if (parsed === null) continue;
        if (parsed.marker === "AAW_P3D_CAPTURE_READY") {
          if (!secondLaunched) {
            secondLaunched = true;
            secondPromise = runProcess(
              electronBinary,
              [harnessAppRoot, "--force-renderer-accessibility"],
              {
                timeoutMs: 15_000,
                acceptExitCodes: [0, 1],
              },
            );
          }
          captureQueue = captureQueue.then(async () => {
            await powershellJson([
              "-ProcessId",
              String(parsed.value.processId),
              "-ResizeWidth",
              "1366",
              "-ResizeHeight",
              "768",
            ]);
            const profileId = profileForCapture(parsed.value);
            const family =
              profileId === null ? runFamilies.race : runFamilyForProfile(profileId);
            const filename = `${runIds[family]}--${profileId ?? "actual-unmatched"}--zoom-${parsed.value.pageZoom}--${parsed.value.caseId}.png`;
            const outputPath = resolve(screenshotsRoot, filename);
            const screenshotProbe = await powershellJson([
              "-ProcessId",
              String(parsed.value.processId),
              "-ProbeOnly",
            ]);
            const screenshot = screenshotProbe.interactiveDesktop === true
              ? await powershellJson([
                  "-ProcessId",
                  String(parsed.value.processId),
                  "-OutputPath",
                  outputPath,
                ])
              : Object.freeze({
                  schemaVersion: "aaw.phase3-p3d.external-screenshot/v1",
                  captureMethod: "not-run-locked-desktop",
                  interactiveDesktop: false,
                  width: 0,
                  height: 0,
                  sha256: null,
                  outputPath: null,
                });
            captures.push(
              Object.freeze({
                marker: parsed.value,
                profileId,
                screenshot,
                outputPath,
              }),
            );
          });
        } else if (parsed.marker === "AAW_P3D_RACE_CAPTURE_READY") {
          captureQueue = captureQueue.then(async () => {
            if (parsed.value.windowAbsentExpected === true) {
              const externalObservation = await powershellJson([
                "-ProcessId",
                String(parsed.value.processId),
                "-AssertWindowAbsent",
              ]);
              raceCaptures.push(
                Object.freeze({
                  marker: parsed.value,
                  screenshot: null,
                  outputPath: null,
                  externalObservation,
                }),
              );
              return;
            }
            await powershellJson([
              "-ProcessId",
              String(parsed.value.processId),
              "-ResizeWidth",
              "1366",
              "-ResizeHeight",
              "768",
            ]);
            const outputPath = resolve(
              screenshotsRoot,
              `${runIds[runFamilies.race]}--windows-lifecycle--${parsed.value.caseId}.png`,
            );
            const screenshot = await powershellJson([
              "-ProcessId",
              String(parsed.value.processId),
              "-OutputPath",
              outputPath,
            ]);
            const externalObservation = await accessibilitySnapshotOrBlocked(
              parsed.value.processId,
            );
            raceCaptures.push(
              Object.freeze({
                marker: parsed.value,
                screenshot,
                outputPath,
                externalObservation,
              }),
            );
          });
        } else if (parsed.marker === "AAW_P3D_RACE_RESULT") {
          races.push(parsed.value);
        } else if (parsed.marker === "AAW_P3D_CASE_NOT_RUN") {
          notRun.push(parsed.value);
        }
      }
    },
    },
  );
  while (testChild === undefined) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const processTree = await processTreeOrBlocked(testChild.pid);
  const result = await testRun;
  await captureQueue;
  if (secondPromise !== null) secondResult = await secondPromise;
  if (carry.length > 0) fullLog.push(carry);
  writeNewText(fullLogPath, `${fullLog.join("\n")}\n`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  const afterTree = await processTreeOrBlocked(testChild.pid);
  return Object.freeze({
    result,
    captures: Object.freeze(captures),
    races: Object.freeze(races),
    raceCaptures: Object.freeze(raceCaptures),
    notRun: Object.freeze(notRun),
    secondResult,
    processTree,
    afterTree,
    noOrphans:
      afterTree.observationAvailable === true &&
      afterTree.processes.length === 0,
    fullLogPath,
  });
}

function writeCaptureEvidence(capture, runIds) {
  if (capture.profileId === null) return null;
  const expected = P3D_DELIVERY_SCENARIOS_V1.find(
    (entry) => entry.caseId === capture.marker.caseId,
  );
  if (expected === undefined) throw new Error("The captured P3-D case is uncontracted.");
  const family = runFamilyForProfile(capture.profileId);
  const runId = runIds[family];
  const caseRoot = resolve(
    runsRoot,
    runId,
    capture.profileId,
    capture.marker.caseId,
  );
  const rawPath = resolve(caseRoot, "raw.log");
  writeNewText(rawPath, `${JSON.stringify(capture.marker)}\n`);
  const oracles = evidenceOracles(capture.marker, expected);
  const screenshotValid =
    capture.screenshot.interactiveDesktop === true &&
    capture.screenshot.width === 1366 &&
    capture.screenshot.height === 768;
  const status = oracles.__pass
    ? screenshotValid
      ? "PASS"
      : "BLOCKED"
    : "FAIL";
  const environment = {
    platform: "win32",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: capture.marker.environment.deviceScaleFactor,
    pageZoom: capture.marker.pageZoom,
    forcedColorsActive: capture.marker.environment.forcedColorsActive,
  };
  const result = evidenceResult({
    phase: "exit",
    caseId: `${capture.profileId}/${capture.marker.caseId}`,
    status,
    environment,
    oracles,
    screenshot: screenshotValid
      ? {
          relativePath: normalizedRelative(capture.outputPath),
          width: capture.screenshot.width,
          height: capture.screenshot.height,
          sha256: capture.screenshot.sha256,
        }
      : null,
    rawLog: {
      relativePath: normalizedRelative(rawPath),
      sha256: sha256File(rawPath),
    },
    blocker:
      status === "PASS"
        ? null
        : {
            reason: oracles.__pass
              ? "The Electron DOM/security oracle passed, but the locked Windows desktop prevented an approved external application capture."
              : "The real Electron DOM/security oracle failed.",
            owner: oracles.__pass ? "windows-qa-owner" : "desktop-security-owner",
            exitCondition: oracles.__pass
              ? "Unlock the interactive Windows desktop and rerun the exact profile with the application in the foreground."
              : "Fix and rerun the exact profile until every closed DOM/security oracle passes.",
          },
  });
  writeNewJson(resolve(caseRoot, "evidence-result.json"), result);
  return Object.freeze({ runId, status, profileId: capture.profileId });
}

function zeroOracles() {
  return Object.freeze({
    typedResolvePath: false,
    exactRevisionBinding: false,
    persistentBannerVisible: false,
    overlayBannerVisible: false,
    geometryAllowed: false,
    noHorizontalOverflow: false,
    focusContract: false,
    ariaContract: false,
    artifactDigestUnchanged: false,
    registryMutationCount: 0,
    productDocumentFileMutationCount: 0,
    nativeSaveHelperCallCount: 0,
    oaEdaMutationCount: 0,
    externalNetworkRequestCount: 0,
    processSpawnCount: 0,
    __pass: false,
  });
}

function writeProductionEvidence(
  productionRuntime,
  productionBoundary,
  runId,
  actualEnvironment,
) {
  const caseRoot = resolve(
    runsRoot,
    runId,
    "windows-1366x768-dsf-100",
    "error-production-empty-registry",
  );
  const rawSource = resolve(productionRuntime.runRoot, "production-runtime.json");
  const screenshotPath = productionRuntime.screenshot.outputPath;
  const screenshotValid =
    productionRuntime.screenshot.interactiveDesktop === true &&
    productionRuntime.screenshot.width === 1366 &&
    productionRuntime.screenshot.height === 768;
  const accessibility = productionRuntime.accessibility;
  const accessibleText = Array.isArray(accessibility?.textFragments)
    ? accessibility.textFragments.join("\n")
    : "";
  const accessibilityValid =
    accessibility?.schemaVersion ===
      "aaw.phase3-p3d.accessibility-snapshot/v1" &&
    accessibility.observationAvailable === true &&
    accessibility.interactiveDesktop === true &&
    accessibility.truncated === false &&
    accessibility.documentCount === 1 &&
    accessibility.documentHorizontalBoundsWithinWindow === true &&
    Number.isSafeInteger(accessibility.focusableElementCount) &&
    accessibility.focusableElementCount > 0 &&
    accessibleText.includes("SYNTHETIC REVIEWED FIXTURE") &&
    accessibleText.includes("READ-ONLY") &&
    accessibleText.includes("EDA DISCONNECTED") &&
    accessibleText.includes("CAPABILITY_DENIED") &&
    accessibleText.includes("原理图内容未显示") &&
    !accessibleText.includes("Synthetic reviewed schematic canvas");
  const normalEnvironment =
    actualEnvironment.deviceScaleFactor === 1 &&
    actualEnvironment.forcedColorsActive === false;
  const pass =
    normalEnvironment &&
    screenshotValid &&
    accessibilityValid &&
    productionBoundary.passed === true &&
    productionRuntime.noOrphans === true;
  const result = evidenceResult({
    phase: pass ? "exit" : "work",
    caseId:
      "windows-1366x768-dsf-100/error-production-empty-registry",
    status: pass ? "PASS" : normalEnvironment ? "BLOCKED" : "NOT_RUN",
    environment: {
      platform: "win32",
      physicalWidth: 1366,
      physicalHeight: 768,
      deviceScaleFactor: actualEnvironment.deviceScaleFactor,
      pageZoom: 1,
      forcedColorsActive: actualEnvironment.forcedColorsActive,
    },
    oracles: {
      ...zeroOracles(),
      typedResolvePath: accessibilityValid,
      exactRevisionBinding: productionBoundary.passed,
      persistentBannerVisible: accessibilityValid,
      geometryAllowed: false,
      noHorizontalOverflow:
        accessibility?.documentCount === 1 &&
        accessibility?.documentHorizontalBoundsWithinWindow === true,
      focusContract:
        Number.isSafeInteger(accessibility?.focusableElementCount) &&
        accessibility.focusableElementCount > 0,
      ariaContract: accessibilityValid,
      artifactDigestUnchanged: productionBoundary.passed,
      processSpawnCount: 0,
    },
    screenshot: screenshotValid
      ? {
          relativePath: normalizedRelative(screenshotPath),
          width: productionRuntime.screenshot.width,
          height: productionRuntime.screenshot.height,
          sha256: productionRuntime.screenshot.sha256,
        }
      : null,
    rawLog: {
      relativePath: normalizedRelative(rawSource),
      sha256: sha256File(rawSource),
    },
    blocker: pass
      ? null
      : {
          reason: normalEnvironment
            ? "The exact production window did not satisfy the external Windows accessibility, screenshot, or process oracle."
            : "The exact production evidence requires native Windows 100% scale without forced colors.",
          owner: normalEnvironment ? "desktop-security-owner" : "windows-qa-owner",
          exitCondition: normalEnvironment
            ? "Fix and rerun until the external production observer, screenshot, boundary and no-orphan checks all pass."
            : "Rerun the exact production profile at native Windows 100% scale without forced colors.",
        },
  });
  writeNewJson(resolve(caseRoot, "evidence-result.json"), result);
  return result.status;
}

function writeRaceEvidence(
  races,
  raceCaptures,
  runId,
  actualEnvironment,
) {
  const statuses = [];
  const normalEnvironment =
    actualEnvironment.deviceScaleFactor === 1 &&
    actualEnvironment.forcedColorsActive === false;
  for (const race of races) {
    const caseRoot = resolve(runsRoot, runId, "windows-lifecycle", race.caseId);
    const capture = raceCaptures.find(
      (candidate) => candidate.marker.caseId === race.caseId,
    );
    const lifecyclePassed =
      race.zeroRendererCommit === true &&
      (race.caseId === "unmount" || race.successfulResponses === 0);
    const windowCloseObserved =
      race.caseId === "window-close" &&
      capture?.externalObservation?.schemaVersion ===
        "aaw.phase3-p3d.window-absence/v1" &&
      capture.externalObservation.observationAvailable === true &&
      capture.externalObservation.windowAbsent === true;
    const accessibleText = Array.isArray(
      capture?.externalObservation?.textFragments,
    )
      ? capture.externalObservation.textFragments.join("\n")
      : "";
    const visibleRaceObserved =
      race.caseId !== "window-close" &&
      capture?.screenshot?.interactiveDesktop === true &&
      capture.screenshot.width === 1366 &&
      capture.screenshot.height === 768 &&
      capture.externalObservation?.schemaVersion ===
        "aaw.phase3-p3d.accessibility-snapshot/v1" &&
      capture.externalObservation.observationAvailable === true &&
      capture.externalObservation.truncated === false &&
      capture.externalObservation.documentCount === 1 &&
      capture.externalObservation.documentHorizontalBoundsWithinWindow === true &&
      Number.isSafeInteger(capture.externalObservation.focusableElementCount) &&
      capture.externalObservation.focusableElementCount > 0 &&
      accessibleText.includes("SYNTHETIC REVIEWED FIXTURE") &&
      accessibleText.includes("READ-ONLY") &&
      accessibleText.includes("EDA DISCONNECTED");
    const externallyObserved = windowCloseObserved || visibleRaceObserved;
    const pass = normalEnvironment && lifecyclePassed && externallyObserved;
    const status = pass ? "PASS" : normalEnvironment ? "BLOCKED" : "NOT_RUN";
    const rawPath = resolve(caseRoot, "raw.log");
    writeNewJson(rawPath, {
      schemaVersion: "aaw.phase3-p3d.lifecycle-raw/v1",
      race,
      externalObservation: capture?.externalObservation ?? null,
    });
    const result = evidenceResult({
      phase: pass ? "exit" : "work",
      caseId: `windows-lifecycle/${race.caseId}`,
      status,
      environment: {
        platform: "win32",
        physicalWidth: 1366,
        physicalHeight: 768,
        deviceScaleFactor: actualEnvironment.deviceScaleFactor,
        pageZoom: 1,
        forcedColorsActive: actualEnvironment.forcedColorsActive,
      },
      oracles: {
        ...zeroOracles(),
        typedResolvePath: true,
        exactRevisionBinding: true,
        persistentBannerVisible: visibleRaceObserved,
        geometryAllowed: false,
        noHorizontalOverflow:
          capture?.externalObservation?.documentCount === 1 &&
          capture?.externalObservation?.documentHorizontalBoundsWithinWindow ===
            true,
        focusContract:
          Number.isSafeInteger(
            capture?.externalObservation?.focusableElementCount,
          ) && capture.externalObservation.focusableElementCount > 0,
        ariaContract: visibleRaceObserved,
        artifactDigestUnchanged: lifecyclePassed,
      },
      screenshot:
        race.caseId !== "window-close" && visibleRaceObserved
          ? {
              relativePath: normalizedRelative(capture.outputPath),
              width: capture.screenshot.width,
              height: capture.screenshot.height,
              sha256: capture.screenshot.sha256,
            }
          : null,
      rawLog: {
        relativePath: normalizedRelative(rawPath),
        sha256: sha256File(rawPath),
      },
      blocker: pass
        ? null
        : {
            reason: normalEnvironment
              ? lifecyclePassed
                ? "The lifecycle zero-delivery oracle passed without the required bound external window observation."
                : "The lifecycle race did not prove zero renderer commit."
              : "Lifecycle evidence requires native Windows 100% scale without forced colors.",
            owner: lifecyclePassed ? "windows-qa-owner" : "desktop-security-owner",
            exitCondition: normalEnvironment
              ? "Rerun until the lifecycle result and external window observation are both bound and passing."
              : "Rerun the lifecycle profile at native Windows 100% scale without forced colors.",
          },
    });
    writeNewJson(resolve(caseRoot, "evidence-result.json"), result);
    statuses.push(status);
  }
  return statuses;
}

function writeUnavailableProfiles(
  capturedKeys,
  runIds,
  actualEnvironment,
  perRunStatuses,
) {
  for (const profile of P3D_VISUAL_PROFILES_V1) {
    for (const scenario of P3D_DELIVERY_SCENARIOS_V1) {
      const key = `${profile.profileId}/${scenario.caseId}`;
      if (capturedKeys.has(key)) continue;
      const family = runFamilyForProfile(profile.profileId);
      const runId = runIds[family];
      const caseRoot = resolve(runsRoot, runId, profile.profileId, scenario.caseId);
      const rawPath = resolve(caseRoot, "raw.log");
      const reason = profile.forcedColorsActive
        ? "The native Windows forced-colors environment was not active for this run."
        : profile.deviceScaleFactor !== actualEnvironment.deviceScaleFactor
          ? "The native Windows device scale factor did not match this profile; emulation is not accepted."
          : profile.pageZoom !== actualEnvironment.pageZoom
            ? "This fixed page-zoom profile was not reached in the current native run."
            : "The required real Electron case did not produce a capture marker.";
      writeNewText(rawPath, `${JSON.stringify({ status: "NOT_RUN", reason })}\n`);
      const result = evidenceResult({
        phase: "work",
        caseId: key,
        status: "NOT_RUN",
        environment: {
          platform: "win32",
          physicalWidth: 1366,
          physicalHeight: 768,
          deviceScaleFactor: actualEnvironment.deviceScaleFactor,
          pageZoom: actualEnvironment.pageZoom,
          forcedColorsActive: actualEnvironment.forcedColorsActive,
        },
        oracles: zeroOracles(),
        screenshot: null,
        rawLog: {
          relativePath: normalizedRelative(rawPath),
          sha256: sha256File(rawPath),
        },
        blocker: {
          reason,
          owner: "windows-qa-owner",
          exitCondition:
            "Rerun on the exact native Windows scale/forced-colors/page-zoom profile.",
        },
      });
      writeNewJson(resolve(caseRoot, "evidence-result.json"), result);
      if (isRequiredSummaryCase(profile.profileId, scenario.caseId)) {
        const statuses = perRunStatuses.get(runId) ?? [];
        statuses.push("NOT_RUN");
        perRunStatuses.set(runId, statuses);
      }
    }
  }
}

function writeRunSummaries(runIds, perRunStatuses, common) {
  for (const [family, runId] of Object.entries(runIds)) {
    const statuses = perRunStatuses.get(runId) ?? [];
    const pass = statuses.length > 0 && statuses.every((status) => status === "PASS");
    const summary = Object.freeze({
      schemaVersion: "aaw.phase3-p3d.runtime-summary/v1",
      runId,
      family,
      realElectron: common.realElectron === true,
      nativeEnvironment: common.nativeEnvironment === true,
      domOraclePassed: pass,
      stateOraclePassed: pass,
      securityOraclePassed: pass && common.productionBoundaryPassed === true,
      processOraclePassed: common.processOraclePassed === true,
      noOrphans: common.noOrphans === true,
      productionBoundaryPassed: common.productionBoundaryPassed,
      statusCounts: Object.freeze(
        statuses.reduce((counts, status) => {
          counts[status] = (counts[status] ?? 0) + 1;
          return counts;
        }, {}),
      ),
    });
    writeNewJson(resolve(runsRoot, runId, "runtime-summary.json"), summary);
  }
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("P3-D Electron matrix is Windows-only.");
  }
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(screenshotsRoot, { recursive: true });
  const runIds = Object.fromEntries(
    Object.values(runFamilies).map((family) => [family, allocateRunId(family)]),
  );
  for (const runId of Object.values(runIds)) {
    mkdirSync(resolve(runsRoot, runId), { recursive: true });
  }
  const productBefore = productSnapshot();
  const productionBuilds = await buildProduction();
  const productionBoundary = auditP3dProductionBoundaryV1();
  if (!productionBoundary.passed) {
    throw new Error("The production graph or bundle is contaminated by P3-D test code.");
  }
  const productionRunId = runIds[runFamilies.production];
  const productionRuntime = await runExactProduction(
    productionRunId,
    productionBoundary,
  );
  const harnessBuilds = await buildAndStageHarness();
  const testMatrix = await runTestMatrix(runIds);
  const productAfter = productSnapshot();
  const productUnchanged =
    JSON.stringify(productBefore) === JSON.stringify(productAfter);
  if (!productUnchanged) {
    throw new Error("A governed product source, fixture, package, or lock file changed.");
  }
  const perRunStatuses = new Map();
  const capturedKeys = new Set();
  for (const capture of testMatrix.captures) {
    const written = writeCaptureEvidence(capture, runIds);
    if (written === null) continue;
    capturedKeys.add(`${capture.profileId}/${capture.marker.caseId}`);
    if (
      isRequiredSummaryCase(
        capture.profileId,
        capture.marker.caseId,
      )
    ) {
      const list = perRunStatuses.get(written.runId) ?? [];
      list.push(written.status);
      perRunStatuses.set(written.runId, list);
    }
  }
  const firstCapture = testMatrix.captures[0];
  const actualEnvironment = firstCapture === undefined
    ? Object.freeze({
        deviceScaleFactor: 1,
        pageZoom: 1,
        forcedColorsActive: false,
      })
    : Object.freeze({
        deviceScaleFactor: firstCapture.marker.environment.deviceScaleFactor,
        pageZoom: 1,
        forcedColorsActive: firstCapture.marker.environment.forcedColorsActive,
      });
  writeUnavailableProfiles(
    capturedKeys,
    runIds,
    actualEnvironment,
    perRunStatuses,
  );
  const raceRunId = runIds[runFamilies.race];
  const raceRaw = resolve(runsRoot, raceRunId, "race-results.json");
  writeNewJson(raceRaw, {
    schemaVersion: "aaw.phase3-p3d.race-results/v1",
    cases: testMatrix.races,
  });
  const racePass =
    testMatrix.races.length >= 7 &&
    testMatrix.races.every(
      (entry) =>
        entry.zeroRendererCommit === true &&
        (entry.caseId === "unmount" || entry.successfulResponses === 0),
    );
  const recordedRaces = testMatrix.races.length === 0
    ? raceCaseIds.map((caseId) => ({
        caseId,
        zeroRendererCommit: false,
        successfulResponses: null,
      }))
    : testMatrix.races;
  const raceStatuses = writeRaceEvidence(
    recordedRaces,
    testMatrix.raceCaptures,
    raceRunId,
    actualEnvironment,
  );
  perRunStatuses.set(raceRunId, raceStatuses);
  const productionStatus = writeProductionEvidence(
    productionRuntime,
    productionBoundary,
    productionRunId,
    actualEnvironment,
  );
  perRunStatuses.set(productionRunId, [productionStatus]);
  writeRunSummaries(runIds, perRunStatuses, {
    realElectron: true,
    nativeEnvironment: true,
    productionBoundaryPassed: productionBoundary.passed,
    processOraclePassed:
      productionRuntime.noOrphans &&
      (testMatrix.secondResult?.exitCode === 0 ||
        testMatrix.secondResult?.exitCode === 1),
    noOrphans: productionRuntime.noOrphans && testMatrix.noOrphans,
  });
  const runMetadata = Object.freeze({
    schemaVersion: "aaw.phase3-p3d.run-metadata/v1",
    startedAt: new Date().toISOString(),
    runIds,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electronBinary,
    exactProductMainSha256: sha256File(
      resolve(repositoryRoot, "dist/main/main/index.js"),
    ),
    testBundleSha256: sha256File(resolve(harnessAppRoot, "dist/main/index.js")),
    packageLockSha256: sha256File(resolve(repositoryRoot, "package-lock.json")),
    productUnchanged,
    productionBuilds,
    harnessBuilds,
  });
  for (const runId of Object.values(runIds)) {
    writeNewJson(
      resolve(runsRoot, runId, "run-metadata.json"),
      Object.freeze({
        ...runMetadata,
        runId,
        attemptId: runId,
      }),
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok:
          productionStatus === "PASS" &&
          racePass &&
          raceStatuses.every((status) => status === "PASS") &&
          productUnchanged &&
          productionBoundary.passed,
        runIds,
        capturedCaseCount: capturedKeys.size,
        notRunCount: P3D_VISUAL_PROFILES_V1.length *
          P3D_DELIVERY_SCENARIOS_V1.length - capturedKeys.size,
        racePass,
        productUnchanged,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch(async (error) => {
  for (const processId of liveElectronRoots) {
    await runProcess(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", String(processId), "/T", "/F"],
      { acceptExitCodes: [0, 128, 255], timeoutMs: 15_000 },
    ).catch(() => undefined);
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
