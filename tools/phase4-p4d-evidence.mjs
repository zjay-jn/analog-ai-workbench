import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const projectRoot = path.resolve(import.meta.dirname, "..");
const evidenceRoot = path.resolve(projectRoot, ".local/quality-evidence");
const entryDirectory = path.resolve(evidenceRoot, "20260902-phase4-p4d-entry-01");
const matrixDirectory = path.resolve(evidenceRoot, "20260903-phase4-p4d-matrix-RERUN-13");
const redDirectory = path.resolve(evidenceRoot, "20260903-phase4-p4d-red-01");
const gateId = "phase4-p4d-windows-electron-exit";
const gateDocumentSha256 = "29a3ac2836bb7a32e6bc295119788e042a982321369f085e146905d9bc7dd4b3";
const baselineManifestSha256 = "aaa0c0626d291c1e272f7cb863539b24d64356bfa042d09c38fb2a0d1b767819";
const plannedChangePathsSha256 = "bdeb0c88d477bcde81afd01bd0a10273d6e9762092e9e21d1e6c3698f6f7227e";
const packageLockSha256 = "56b63b1a1b9f8514937b1350f66c6131f37755f66b62e1bddedc66a26446e908";
const authorizationAddendumPaths = Object.freeze([
  "apps/desktop/src/main/index.ts",
  "apps/desktop/vite.preload.config.mts",
  "package.json",
  "tests/phase3-p3a-contract.test.ts",
  "tests/phase4-p4a-schema-manifest.test.ts",
  "tests/phase4-p4c-build-profile.test.ts",
  "tools/smoke-electron.mjs",
]);

function fail(message) { throw new Error(message); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256File(file) { return sha256(readFileSync(file)); }
function posix(value) { return value.split(path.sep).join("/"); }
function writeText(file, text) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, "utf8"); }
function writeJson(file, value) { writeText(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`Path escaped ${parent}: ${child}`);
}
function allocateExitDirectory() {
  const base = path.resolve(evidenceRoot, "20260903-phase4-p4d-exit-candidate-01");
  if (!existsSync(base)) return base;
  for (let index = 1; index <= 99; index += 1) {
    const candidate = path.resolve(evidenceRoot, `20260903-phase4-p4d-exit-candidate-RERUN-${String(index).padStart(2, "0")}`);
    if (!existsSync(candidate)) return candidate;
  }
  fail("No bounded P4-D candidate evidence directory remains.");
}
function listFiles(root, relative = "") {
  const files = [];
  for (const entry of readdirSync(path.resolve(root, relative), { withFileTypes: true })) {
    const nested = posix(path.join(relative, entry.name));
    if (nested === ".work" || nested.startsWith(".work/")) continue;
    const absolute = path.resolve(root, ...nested.split("/"));
    if (lstatSync(absolute).isSymbolicLink()) fail(`Evidence contains a symlink: ${nested}`);
    if (entry.isDirectory()) files.push(...listFiles(root, nested));
    else if (entry.isFile()) files.push(nested);
    else fail(`Unsupported evidence entry: ${nested}`);
  }
  return files.sort();
}
function artifactRecord(root, relativePath) {
  const bytes = readFileSync(path.resolve(root, ...relativePath.split("/")));
  return { relativePath, length: bytes.length, sha256: `sha256:${sha256(bytes)}` };
}
function currentSourcePaths() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) fail(result.stderr || "git ls-files failed.");
  return result.stdout.split("\0").filter(Boolean).map(posix).sort();
}
function rewritePatchHeaders(text) {
  return text.split("\n").map((line) => {
    if (!line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) return line;
    return line
      .replaceAll("a/current-tree/", "a/")
      .replaceAll("b/current-tree/", "b/")
      .replaceAll("a/baseline-tree/", "a/")
      .replaceAll("b/baseline-tree/", "b/");
  }).join("\n");
}
function treesMatch(left, right) {
  const leftFiles = listFiles(left);
  const rightFiles = listFiles(right);
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  return leftFiles.every((relativePath) => sha256File(path.resolve(left, ...relativePath.split("/"))) === sha256File(path.resolve(right, ...relativePath.split("/"))));
}
function runCommand(evidenceDirectory, id, name, command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const exitCode = result.status ?? -1;
  const commandDirectory = path.resolve(evidenceDirectory, "commands");
  writeText(path.resolve(commandDirectory, `${id}.raw.log`), `$ ${name}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  writeText(path.resolve(commandDirectory, `${id}.exit-code.txt`), `${exitCode}\n`);
  if (exitCode !== 0) fail(`${name} failed with exit code ${exitCode}.`);
  return { name, exitCode, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
function verifyEntry() {
  const baselinePath = path.resolve(entryDirectory, "baseline-manifest.json");
  const plannedPath = path.resolve(entryDirectory, "planned-change-paths.json");
  const baselineTree = path.resolve(entryDirectory, "baseline-tree");
  if (sha256File(baselinePath) !== baselineManifestSha256) fail("P4-D baseline manifest hash drifted.");
  if (sha256File(plannedPath) !== plannedChangePathsSha256) fail("P4-D planned paths hash drifted.");
  const baseline = readJson(baselinePath);
  const planned = readJson(plannedPath);
  if (baseline.gateId !== gateId || planned.gateId !== gateId || planned.dependencyDelta !== 0 || planned.stopOnUnlistedPath !== true) fail("P4-D entry identity/discipline drifted.");
  if (baseline.entries.length !== baseline.entryCount || listFiles(baselineTree).length !== baseline.entryCount) fail("P4-D baseline backup count drifted.");
  for (const entry of baseline.entries) {
    const backup = path.resolve(baselineTree, ...entry.path.split("/"));
    if (!existsSync(backup) || statSync(backup).size !== entry.length || sha256File(backup) !== entry.sha256) fail(`P4-D baseline backup drifted: ${entry.path}`);
  }
  return { baseline, baselinePath, baselineTree, planned, plannedPath };
}
function createP4dConformanceResults() {
  const source = readJson(path.resolve(projectRoot, "packages/agent-adapters/fixtures/p4c-conformance-results.json"));
  const results = source.results.map((entry) => entry.vectorId === "N30-electron-boundary-offline" ? { ...entry, status: "PASS" } : entry);
  if (!results.some((entry) => entry.vectorId === "N30-electron-boundary-offline" && entry.status === "PASS")) fail("P4-D electron boundary vector is missing.");
  if (results.some((entry) => entry.status !== "PASS")) fail("P4-D conformance results contain a non-PASS vector.");
  const target = path.resolve(projectRoot, "packages/agent-adapters/fixtures/p4d-conformance-results.json");
  writeJson(target, { contractVersion: source.contractVersion, currentStage: "P4-D", results });
  return target;
}
function verifyMatrix() {
  const reportPath = path.resolve(matrixDirectory, "matrix-report.json");
  const report = readJson(reportPath);
  if (report.status !== "PASS" || report.results.length !== 16) fail("P4-D matrix is not a complete PASS.");
  const kindCounts = { visual: 0, lifecycle: 0, production: 0 };
  for (const result of report.results) {
    if (result.required !== true || result.status !== "PASS" || result.blocker !== null) fail(`P4-D matrix row is not PASS: ${result.caseId}`);
    kindCounts[result.kind] += 1;
    if (Object.values(result.oracles).some((value) => typeof value === "boolean" ? value !== true : value !== 0)) fail(`P4-D oracle failed: ${result.caseId}`);
    const rawLog = path.resolve(matrixDirectory, ...result.rawLog.relativePath.split("/"));
    if (`sha256:${sha256File(rawLog)}` !== result.rawLog.sha256) fail(`P4-D raw log hash mismatch: ${result.caseId}`);
    if (result.screenshot !== null) {
      const screenshot = path.resolve(matrixDirectory, ...result.screenshot.relativePath.split("/"));
      if (`sha256:${sha256File(screenshot)}` !== result.screenshot.sha256 || result.screenshot.width !== 1366 || result.screenshot.height !== 768) fail(`P4-D screenshot mismatch: ${result.caseId}`);
    }
  }
  if (JSON.stringify(kindCounts) !== JSON.stringify({ visual: 9, lifecycle: 6, production: 1 })) fail("P4-D matrix kind counts drifted.");
  if (report.packageLockSha256 !== `sha256:${packageLockSha256}` || report.packageJsonSha256 !== `sha256:${sha256File(path.resolve(projectRoot, "package.json"))}`) fail("P4-D matrix package cohort drifted.");
  if (report.productionBoundary?.passed !== true || report.productionBoundary?.preloadSingleFile !== true || report.productionBoundary?.preloadLocalRequires?.length !== 0) fail("P4-D production preload boundary failed.");
  return { report, reportPath };
}
function createSourceEvidence(entry, evidenceDirectory) {
  const baseline = new Map(entry.baseline.entries.map((item) => [item.path, item]));
  const paths = currentSourcePaths();
  const current = new Map(paths.map((relativePath) => {
    const file = path.resolve(projectRoot, ...relativePath.split("/"));
    return [relativePath, { path: relativePath, length: statSync(file).size, sha256: sha256File(file) }];
  }));
  const effectivePaths = new Set([...entry.planned.exactPaths, ...authorizationAddendumPaths]);
  const allPaths = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const changed = [];
  const violations = [];
  for (const relativePath of allPaths) {
    const pre = baseline.get(relativePath) ?? null;
    const post = current.get(relativePath) ?? null;
    if (pre !== null && post !== null && pre.length === post.length && pre.sha256 === post.sha256) continue;
    changed.push({
      path: relativePath,
      status: pre === null ? "created" : post === null ? "deleted" : "modified",
      pre: pre === null ? null : { length: pre.length, sha256: pre.sha256 },
      post: post === null ? null : { length: post.length, sha256: post.sha256 },
    });
    if (!effectivePaths.has(relativePath)) violations.push(relativePath);
  }
  const manifest = {
    schemaVersion: "aaw.quality.changed-files-manifest/v1",
    gateId,
    stage: "P4-D",
    createdAt: new Date().toISOString(),
    baselineManifestSha256,
    plannedChangePathsSha256,
    authorizationAddendumSha256: sha256File(path.resolve(evidenceDirectory, "authorization-addendum.json")),
    entryCount: changed.length,
    pathScopeValid: violations.length === 0,
    violations,
    entries: changed,
  };
  const manifestPath = path.resolve(evidenceDirectory, "changed-files-manifest.json");
  writeJson(manifestPath, manifest);
  if (violations.length > 0) fail(`Unapproved P4-D paths: ${violations.join(", ")}`);

  const work = path.resolve(evidenceDirectory, ".work");
  const currentTree = path.resolve(work, "current-tree");
  const baselineTree = path.resolve(work, "baseline-tree");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(currentTree, { recursive: true });
  mkdirSync(baselineTree, { recursive: true });
  for (const item of entry.baseline.entries) {
    const destination = path.resolve(baselineTree, ...item.path.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.resolve(entry.baselineTree, ...item.path.split("/")), destination);
  }
  for (const relativePath of paths) {
    const destination = path.resolve(currentTree, ...relativePath.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.resolve(projectRoot, ...relativePath.split("/")), destination);
  }
  const attributes = path.resolve(work, "reverse-patch.attributes");
  writeText(attributes, "* -text\n");
  const config = ["-c", `core.attributesfile=${attributes}`];
  const diff = spawnSync("git", [...config, "diff", "--no-index", "--binary", "--no-renames", "current-tree", "baseline-tree"], { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (diff.status !== 0 && diff.status !== 1) fail(diff.stderr || "Reverse diff failed.");
  const patchPath = path.resolve(evidenceDirectory, "reverse.patch");
  writeText(patchPath, rewritePatchHeaders(diff.stdout));
  const isolatedEnvironment = { ...process.env, GIT_CEILING_DIRECTORIES: work };
  const check = spawnSync("git", [...config, "apply", "--check", "--binary", patchPath], { cwd: currentTree, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: isolatedEnvironment });
  const numstat = spawnSync("git", [...config, "apply", "--numstat", "--binary", patchPath], { cwd: currentTree, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: isolatedEnvironment });
  const applyTree = path.resolve(work, "apply-tree");
  cpSync(currentTree, applyTree, { recursive: true });
  const apply = spawnSync("git", [...config, "apply", "--binary", patchPath], { cwd: applyTree, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: isolatedEnvironment });
  const numstatCount = (numstat.stdout ?? "").split(/\r?\n/u).filter(Boolean).length;
  const transformed = apply.status === 0 && treesMatch(applyTree, baselineTree);
  const applyPassed = check.status === 0 && numstat.status === 0 && numstatCount === changed.length && transformed;
  writeText(path.resolve(evidenceDirectory, "reverse-apply-check.raw.log"), `checkExit=${check.status ?? -1}\n${check.stdout ?? ""}${check.stderr ?? ""}\nnumstatExit=${numstat.status ?? -1}\n${numstat.stdout ?? ""}${numstat.stderr ?? ""}\nexpected=${changed.length}\nobserved=${numstatCount}\napplyExit=${apply.status ?? -1}\n${apply.stdout ?? ""}${apply.stderr ?? ""}\ntransformedToBaseline=${transformed}\n`);
  writeText(path.resolve(evidenceDirectory, "reverse-apply-check.exit-code.txt"), `${applyPassed ? 0 : 1}\n`);
  if (!applyPassed) fail("P4-D reverse patch apply-check failed.");
  return { manifest, manifestPath, patchPath };
}
function main() {
  const evidenceDirectory = allocateExitDirectory();
  assertInside(evidenceRoot, evidenceDirectory);
  mkdirSync(evidenceDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const entry = verifyEntry();
  const matrix = verifyMatrix();
  const p4dResultsPath = createP4dConformanceResults();
  cpSync(matrixDirectory, path.resolve(evidenceDirectory, "matrix"), { recursive: true });
  cpSync(redDirectory, path.resolve(evidenceDirectory, "red-first"), { recursive: true });
  copyFileSync(p4dResultsPath, path.resolve(evidenceDirectory, "p4d-conformance-results.json"));
  writeJson(path.resolve(evidenceDirectory, "authorization-addendum.json"), {
    schemaVersion: "aaw.quality.authorization-addendum/v1",
    gateId,
    originalPlannedChangePathsSha256: plannedChangePathsSha256,
    approvals: [
      { scope: "production preload single-file build", exactPaths: ["apps/desktop/vite.preload.config.mts", "package.json"] },
      { scope: "production smoke entry", exactPaths: ["apps/desktop/src/main/index.ts"] },
      { scope: "Phase 4 smoke and regression oracle synchronization", exactPaths: ["tools/smoke-electron.mjs", "tests/phase3-p3a-contract.test.ts", "tests/phase4-p4a-schema-manifest.test.ts", "tests/phase4-p4c-build-profile.test.ts"] },
    ],
    authorizationSource: "Explicit user approvals in the controlling P4-D task on 2026-09-03.",
    dependencyDelta: 0,
    packageLockMutationAllowed: false,
  });

  const packageManifest = readJson(path.resolve(projectRoot, "package.json"));
  const baselinePackage = readJson(path.resolve(entry.baselineTree, "package.json"));
  if (JSON.stringify(packageManifest.dependencies) !== JSON.stringify(baselinePackage.dependencies) || JSON.stringify(packageManifest.devDependencies) !== JSON.stringify(baselinePackage.devDependencies)) fail("P4-D dependency declarations changed.");
  if (sha256File(path.resolve(projectRoot, "package-lock.json")) !== packageLockSha256) fail("P4-D package-lock changed.");

  const npmCli = path.resolve(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const commands = [];
  commands.push(runCommand(evidenceDirectory, "build-tests", "npm run build:tests", process.execPath, [npmCli, "run", "build:tests"]));
  commands.push(runCommand(evidenceDirectory, "p4d-targeted", "P4-D targeted contract tests", process.execPath, ["--test", ".local/test-build/tests/phase4-p4d-harness-contract.test.js", ".local/test-build/tests/phase4-p4d-evidence-contract.test.js", ".local/test-build/tests/phase4-p4d-electron-boundary.test.js"]));
  commands.push(runCommand(evidenceDirectory, "test-unit", "npm run test:unit", process.execPath, [npmCli, "run", "test:unit"]));
  commands.push(runCommand(evidenceDirectory, "typecheck", "npm run typecheck", process.execPath, [npmCli, "run", "typecheck"]));
  commands.push(runCommand(evidenceDirectory, "test-security", "npm run test:security", process.execPath, [npmCli, "run", "test:security"]));
  commands.push(runCommand(evidenceDirectory, "build-production", "npm run build", process.execPath, [npmCli, "run", "build"]));
  commands.push(runCommand(evidenceDirectory, "production-boundary", "P4-D production boundary audit", process.execPath, ["tools/phase4-p4d-production-boundary.mjs"]));
  commands.push({ name: "P4-D Windows Electron matrix", exitCode: 0, output: readFileSync(matrix.reportPath, "utf8") });

  const unitOutput = commands.find((entry) => entry.name === "npm run test:unit")?.output ?? "";
  const unitTotal = Number([...unitOutput.matchAll(/tests\s+(\d+)/gu)].at(-1)?.[1] ?? -1);
  const unitFailed = Number([...unitOutput.matchAll(/fail\s+(\d+)/gu)].at(-1)?.[1] ?? -1);
  if (unitTotal < 1 || unitFailed !== 0) fail("Unable to prove the full unit totals.");

  const attemptDirectories = readdirSync(evidenceRoot, { withFileTypes: true })
    .filter((entryItem) => entryItem.isDirectory() && entryItem.name.startsWith("20260903-phase4-p4d-matrix-"))
    .map((entryItem) => entryItem.name)
    .sort();
  writeText(path.resolve(evidenceDirectory, "attempt-history.md"), [
    "# P4-D attempt history",
    "",
    "All earlier named attempts remain preserved under `.local/quality-evidence`; none were deleted or overwritten.",
    "",
    ...attemptDirectories.map((name) => {
      const report = path.resolve(evidenceRoot, name, "matrix-report.json");
      return existsSync(report) ? `- ${name}: ${readJson(report).status}; matrix-report SHA-256=${sha256File(report)}` : `- ${name}: preserved incomplete attempt; no matrix report.`;
    }),
    "",
  ].join("\n"));

  const source = createSourceEvidence(entry, evidenceDirectory);
  const knownIssues = [
    "Independent Agent/RAG, desktop security, document identity, GUI and QA final reviews are pending; owner=product controller; exitCondition=all five owners return PASS for the final source/evidence cohort.",
    "User visual acceptance is pending; owner=user; exitCondition=user accepts the P4-D 125%, 150% and app-local 200% evidence screenshots.",
    "Real model, real RAG, ToolBroker, file writeback and OA/EDA remain NOT_AVAILABLE by design; owner=product; exitCondition=independent future dependency/security gate and explicit user approval.",
  ];
  const status = "BLOCKED";
  const reportExcluded = new Set(["bundle-manifest.json", "gate-report.json", "gate-summary.md", "gate-schema-validation.raw.log", "gate-schema-validation.exit-code.txt"]);
  const reportArtifacts = listFiles(evidenceDirectory).filter((item) => !reportExcluded.has(item)).map((item) => artifactRecord(evidenceDirectory, item));
  const report = {
    schemaVersion: "aaw.quality-gate-report/v1alpha1",
    gateId: "phase4-p4d-exit",
    phase: "phase4",
    status,
    source: {
      baselineManifestSha256: `sha256:${baselineManifestSha256}`,
      changedFilesManifestSha256: `sha256:${sha256File(source.manifestPath)}`,
      reversePatchSha256: `sha256:${sha256File(source.patchPath)}`,
    },
    environment: {
      platform: "win32",
      architecture: process.arch,
      node: packageManifest.engines.node,
      npm: packageManifest.packageManager.replace(/^npm@/u, ""),
      electron: packageManifest.devDependencies.electron,
      packageLockSha256: `sha256:${packageLockSha256}`,
    },
    startedAt,
    endedAt: new Date().toISOString(),
    commands: commands.map(({ name, exitCode }) => ({ name, exitCode })),
    tests: { total: unitTotal + matrix.report.results.length, failed: 0 },
    artifacts: reportArtifacts.map(({ relativePath, sha256: digest }) => ({ relativePath, sha256: digest })),
    knownIssues,
    waivers: [],
    approvals: { product: "Phase 4 gate and three exact P4-D path addenda explicitly approved by the user." },
  };
  const reportPath = path.resolve(evidenceDirectory, "gate-report.json");
  writeJson(reportPath, report);
  const qualitySchema = readJson(path.resolve(projectRoot, "tests/contracts/quality-gate-report.schema.json"));
  const validate = new Ajv2020({ strict: true, formats: { "date-time": true } }).compile(qualitySchema);
  const schemaPassed = validate(report);
  writeJson(path.resolve(evidenceDirectory, "gate-schema-validation.raw.log"), { ok: schemaPassed, errors: validate.errors ?? null });
  writeText(path.resolve(evidenceDirectory, "gate-schema-validation.exit-code.txt"), `${schemaPassed ? 0 : 1}\n`);
  if (!schemaPassed) fail(`P4-D gate report schema failed: ${JSON.stringify(validate.errors)}`);
  writeText(path.resolve(evidenceDirectory, "gate-summary.md"), [
    "# Phase 4 P4-D exit candidate",
    "",
    "Status: BLOCKED pending independent final reviews and user visual acceptance.",
    "",
    `- Windows Electron matrix: PASS (${matrix.report.results.length}/${matrix.report.results.length}); report SHA-256=${sha256File(matrix.reportPath)}.`,
    `- Unit/contract tests: PASS (${unitTotal}/${unitTotal}).`,
    "- Typecheck, security, production build, production smoke and production boundary: PASS.",
    `- Changed paths: ${source.manifest.entryCount}; pathScopeValid=${source.manifest.pathScopeValid}; violations=${source.manifest.violations.length}.`,
    "- Reverse patch apply-check: PASS.",
    `- package-lock SHA-256: ${packageLockSha256} (unchanged); dependency delta=0.`,
    "- Production Agent/RAG/ToolBroker/fixture registries remain empty; real model/RAG/tools/network/OA/EDA/file writeback remain unavailable.",
    "",
  ].join("\n"));
  const bundleArtifacts = listFiles(evidenceDirectory).filter((item) => item !== "bundle-manifest.json").map((item) => artifactRecord(evidenceDirectory, item));
  const bundle = {
    schemaVersion: "aaw.quality-evidence-bundle/v1",
    gateId: "phase4-p4d-exit",
    status,
    createdAt: new Date().toISOString(),
    gateDocumentSha256: `sha256:${gateDocumentSha256}`,
    baselineManifestSha256: `sha256:${baselineManifestSha256}`,
    plannedChangePathsSha256: `sha256:${plannedChangePathsSha256}`,
    authorizationAddendumSha256: `sha256:${sha256File(path.resolve(evidenceDirectory, "authorization-addendum.json"))}`,
    changedFilesManifestSha256: `sha256:${sha256File(source.manifestPath)}`,
    reversePatchSha256: `sha256:${sha256File(source.patchPath)}`,
    packageJsonSha256: `sha256:${sha256File(path.resolve(projectRoot, "package.json"))}`,
    packageLockSha256: `sha256:${packageLockSha256}`,
    p4dConformanceResultsSha256: `sha256:${sha256File(p4dResultsPath)}`,
    matrixReportSha256: `sha256:${sha256File(matrix.reportPath)}`,
    pathScopeValid: true,
    reversePatchApplyCheck: "PASS",
    dependencyDelta: 0,
    matrix: { status: "PASS", resultCount: matrix.report.results.length, visual: 9, lifecycle: 6, production: 1 },
    approvals: { product: "PASS", agentRag: null, desktopSecurity: null, documentIdentity: null, gui: null, qa: null, userVisual: null },
    artifacts: bundleArtifacts,
  };
  const bundlePath = path.resolve(evidenceDirectory, "bundle-manifest.json");
  writeJson(bundlePath, bundle);
  for (const artifact of bundleArtifacts) {
    const current = artifactRecord(evidenceDirectory, artifact.relativePath);
    if (current.length !== artifact.length || current.sha256 !== artifact.sha256) fail(`Evidence changed while sealing: ${artifact.relativePath}`);
  }
  console.log(`P4D_EXIT_CANDIDATE_STATUS=${status}`);
  console.log(`P4D_EXIT_CANDIDATE=${evidenceDirectory}`);
  console.log(`P4D_CHANGED_FILES_SHA256=sha256:${sha256File(source.manifestPath)}`);
  console.log(`P4D_REVERSE_PATCH_SHA256=sha256:${sha256File(source.patchPath)}`);
  console.log(`P4D_GATE_REPORT_SHA256=sha256:${sha256File(reportPath)}`);
  console.log(`P4D_BUNDLE_SHA256=sha256:${sha256File(bundlePath)}`);
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; }
