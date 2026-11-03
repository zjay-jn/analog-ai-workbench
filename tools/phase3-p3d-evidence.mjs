import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { selectLatestApplicableP3dAttemptV1 } from "./phase3-p3d-evidence-contract.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qualityEvidenceRoot = path.join(projectRoot, ".local", "quality-evidence");
const defaultEntryDirectory = path.join(
  qualityEvidenceRoot,
  "20260901-phase3-p3d-entry-01",
);
const parentBundlePath = path.join(
  qualityEvidenceRoot,
  "20260901-phase3-p3c-exit-01",
  "bundle-manifest.json",
);

const GATE_ID = "phase3-p3d-windows-electron-visual-acceptance";
const RESULT_SCHEMA = "aaw.phase3-p3d.evidence-result/v1";
const EXIT_METADATA_SCHEMA = "aaw.phase3-p3d.exit-metadata/v1";
const COMPATIBILITY_RECEIPT_SCHEMA =
  "aaw.phase3-p3d.harness-compatibility-receipt/v1alpha2";
const COMPATIBILITY_RECEIPT_RELATIVE_PATH =
  "cohort-reconstruction/compatibility-receipt.candidate.json";
const APPROVED_COMPATIBILITY_PAYLOAD_SHA256 =
  "sha256:d8db0837baa3715f426d6ee6d1dbd9794ac560664f87742eb8f66f2d7aa011e8";
const APPROVED_PREVIOUS_HARNESS_SHA256 =
  "sha256:dba156bf201e91cb7ef3d17ea0dd951513bcbbebcecdf7328539cfdb7917d21b";
const APPROVED_CURRENT_HARNESS_SHA256 =
  "sha256:ab4b5a5668ad18e65bb7abae06b4cd21ad742853eca58426de9dcc85e541ea3b";
const APPROVED_PRODUCT_MAIN_SHA256 =
  "sha256:e178154f37e419ce1f23c3029c92ce6441398f4b9d3bffc21f1e294c24f70140";
const APPROVED_PACKAGE_LOCK_SHA256 =
  "sha256:56b63b1a1b9f8514937b1350f66c6131f37755f66b62e1bddedc66a26446e908";
const COMPATIBILITY_REVIEWERS = Object.freeze({
  "qa-owner": "/root/p3d_compat_qa",
  "gui-owner": "/root/p3d_compat_gui",
  "desktop-security-owner": "/root/p3d_compat_security",
});
const COMPATIBILITY_CONTENT_PATHS = Object.freeze([
  "cohort-reconstruction/manifests/previous-main-harness.json",
  "cohort-reconstruction/manifests/current-main-harness.json",
  "cohort-reconstruction/manifests/previous-renderer-harness.json",
  "cohort-reconstruction/manifests/current-renderer-harness.json",
  "cohort-reconstruction/manifests/selected-evidence.json",
  "cohort-reconstruction/manifests/product-runtime.json",
  "cohort-reconstruction/manifests/reconstruction-inputs.json",
  "cohort-reconstruction/manifests/compatibility-allowlist.json",
  "cohort-reconstruction/source-delta.patch",
  "cohort-reconstruction/patch-apply-check.json",
]);
const RESULT_KEYS = [
  "schemaVersion",
  "phase",
  "caseId",
  "required",
  "status",
  "environment",
  "oracles",
  "screenshot",
  "rawLog",
  "blocker",
];
const ENVIRONMENT_KEYS = [
  "platform",
  "physicalWidth",
  "physicalHeight",
  "deviceScaleFactor",
  "pageZoom",
  "forcedColorsActive",
];
const RESULT_ORACLE_KEYS = [
  "typedResolvePath",
  "exactRevisionBinding",
  "persistentBannerVisible",
  "overlayBannerVisible",
  "geometryAllowed",
  "noHorizontalOverflow",
  "focusContract",
  "ariaContract",
  "artifactDigestUnchanged",
  "registryMutationCount",
  "productDocumentFileMutationCount",
  "nativeSaveHelperCallCount",
  "oaEdaMutationCount",
  "externalNetworkRequestCount",
  "processSpawnCount",
];
const SUMMARY_PASS_KEYS = [
  "realElectron",
  "nativeEnvironment",
  "domOraclePassed",
  "stateOraclePassed",
  "securityOraclePassed",
  "processOraclePassed",
  "noOrphans",
];
const RESULT_STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
const REQUIRED_COMMANDS = [
  "npm run test:unit",
  "npm run typecheck",
  "npm run test:security",
  "npm run build:main:dev",
  "npm run build",
  "production bundle/CSP/development-gate scan",
];
const REQUIRED_CAPABILITIES = [
  "realReviewedPayload",
  "oaEda",
  "agent",
  "fileWriteback",
];
const PROFILE_100 = "windows-1366x768-dsf-100";
const PROFILE_125 = "windows-1366x768-dsf-125";
const PROFILE_150 = "windows-1366x768-dsf-150";
const PROFILE_ZOOM_200 = "windows-1366x768-page-zoom-200";
const PROFILE_HIGH_CONTRAST = "windows-1366x768-high-contrast";
const PROFILE_LIFECYCLE = "windows-lifecycle";
const PROFILE_ENVIRONMENTS = Object.freeze({
  [PROFILE_100]: Object.freeze({ deviceScaleFactor: 1, pageZoom: 1, forcedColorsActive: false }),
  [PROFILE_125]: Object.freeze({ deviceScaleFactor: 1.25, pageZoom: 1, forcedColorsActive: false }),
  [PROFILE_150]: Object.freeze({ deviceScaleFactor: 1.5, pageZoom: 1, forcedColorsActive: false }),
  [PROFILE_ZOOM_200]: Object.freeze({ deviceScaleFactor: 1, pageZoom: 2, forcedColorsActive: false }),
  [PROFILE_HIGH_CONTRAST]: Object.freeze({ deviceScaleFactor: 1, pageZoom: 1, forcedColorsActive: true }),
  [PROFILE_LIFECYCLE]: Object.freeze({ deviceScaleFactor: 1, pageZoom: 1, forcedColorsActive: false }),
});

function expectedCase(profileId, caseId, geometryAllowed, overlayBannerVisible = false) {
  return Object.freeze({
    caseId: `${profileId}/${caseId}`,
    profileId,
    geometryAllowed,
    overlayBannerVisible,
  });
}

const RUN_FAMILIES = Object.freeze([
  Object.freeze({
    id: "prod-100",
    prefix: "P3D-WIN-PROD-100",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_100, "error-production-empty-registry", false),
    ]),
  }),
  Object.freeze({
    id: "dev-100",
    prefix: "P3D-WIN-DEV-100",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_100, "two-tabs-ready-current", true),
      expectedCase(PROFILE_100, "selection-and-net-current", true),
      expectedCase(PROFILE_100, "inspector-and-hierarchy-current", true),
      expectedCase(PROFILE_100, "blackbox-unavailable-current", true),
      expectedCase(PROFILE_100, "synthetic-overlay-current", true, true),
      expectedCase(PROFILE_100, "loading-delayed-resolve", false),
      expectedCase(PROFILE_100, "unverified-no-delivery", false),
      expectedCase(PROFILE_100, "historical-typed-delivery", true),
    ]),
  }),
  Object.freeze({
    id: "dev-125",
    prefix: "P3D-WIN-DEV-125",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_125, "two-tabs-ready-current", true),
      expectedCase(PROFILE_125, "selection-and-net-current", true),
      expectedCase(PROFILE_125, "inspector-and-hierarchy-current", true),
    ]),
  }),
  Object.freeze({
    id: "dev-150",
    prefix: "P3D-WIN-DEV-150",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_150, "two-tabs-ready-current", true),
      expectedCase(PROFILE_150, "selection-and-net-current", true),
      expectedCase(PROFILE_150, "inspector-and-hierarchy-current", true),
    ]),
  }),
  Object.freeze({
    id: "dev-zoom200",
    prefix: "P3D-WIN-DEV-ZOOM200",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_ZOOM_200, "two-tabs-ready-current", true),
      expectedCase(PROFILE_ZOOM_200, "selection-and-net-current", true),
      expectedCase(PROFILE_ZOOM_200, "inspector-and-hierarchy-current", true),
    ]),
  }),
  Object.freeze({
    id: "dev-high-contrast",
    prefix: "P3D-WIN-DEV-HC",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_HIGH_CONTRAST, "unicode-high-contrast-current", true),
    ]),
  }),
  Object.freeze({
    id: "race",
    prefix: "P3D-WIN-RACE",
    expectedCases: Object.freeze([
      expectedCase(PROFILE_LIFECYCLE, "navigation", false),
      expectedCase(PROFILE_LIFECYCLE, "reload", false),
      expectedCase(PROFILE_LIFECYCLE, "revision-quarantine", false),
      expectedCase(PROFILE_LIFECYCLE, "revision-revoke", false),
      expectedCase(PROFILE_LIFECYCLE, "revision-switch", false),
      expectedCase(PROFILE_LIFECYCLE, "unmount", false),
      expectedCase(PROFILE_LIFECYCLE, "window-close", false),
    ]),
  }),
]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object.`);
}

function assertExactKeys(value, requiredKeys, optionalKeys, label) {
  assertPlainObject(value, label);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed.`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required.`);
  }
}

function assertNonEmptyString(value, label, maximum = 500) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be non-empty, trimmed and control-free.`);
  }
}

function assertDateTime(value, label) {
  assertNonEmptyString(value, label, 64);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO date-time.`);
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256.`);
  }
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function assertInside(parent, child, label) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} must be a non-root descendant of ${path.resolve(parent)}.`);
  }
}

function normalizeRelativePath(value, label) {
  assertNonEmptyString(value, label, 512);
  if (
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value !== path.posix.normalize(value) ||
    value === "." ||
    value.startsWith("../") ||
    value.includes("/../")
  ) {
    fail(`${label} must be a normalized relative POSIX path.`);
  }
  return value;
}

function resolveEvidenceFile(evidenceDirectory, relativePath, label) {
  const normalized = normalizeRelativePath(relativePath, label);
  const absolute = path.resolve(evidenceDirectory, ...normalized.split("/"));
  assertInside(evidenceDirectory, absolute, label);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${label} is missing: ${normalized}.`);
  }
  if (lstatSync(absolute).isSymbolicLink()) fail(`${label} must not be a symlink.`);
  assertInside(realpathSync(evidenceDirectory), realpathSync(absolute), label);
  return { absolute, normalized };
}

function listFilesRecursive(rootDirectory, relativeDirectory = "") {
  const result = [];
  for (const entry of readdirSync(path.join(rootDirectory, relativeDirectory), {
    withFileTypes: true,
  })) {
    const relativePath = toPosix(path.join(relativeDirectory, entry.name));
    if (relativePath === ".work" || relativePath.startsWith(".work/")) continue;
    const absolute = path.join(rootDirectory, ...relativePath.split("/"));
    if (lstatSync(absolute).isSymbolicLink()) {
      fail(`Evidence contains forbidden symlink ${relativePath}.`);
    }
    if (entry.isDirectory()) result.push(...listFilesRecursive(rootDirectory, relativePath));
    else if (entry.isFile()) result.push(relativePath);
    else fail(`Evidence contains unsupported entry ${relativePath}.`);
  }
  return result.sort(compareText);
}

function canonicalizeCompatibilityPayload(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || !Number.isSafeInteger(value)) {
      fail("Compatibility receipt contains an invalid number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeCompatibilityPayload(entry)).join(",")}]`;
  }
  assertPlainObject(value, "compatibility canonical payload object");
  return `{${Object.keys(value)
    .sort(compareText)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeCompatibilityPayload(value[key])}`,
    )
    .join(",")}}`;
}

function compatibilityCandidatePayloadSha256(receipt) {
  const { status: _status, decision: _decision, ...candidatePayload } = receipt;
  return `sha256:${sha256(Buffer.from(canonicalizeCompatibilityPayload(candidatePayload), "utf8"))}`;
}

function reviewedCompatibilityCandidateFileSha256(receipt) {
  const candidateReceipt = {
    ...receipt,
    status: "CANDIDATE_NOT_APPROVED",
    decision: {
      candidatePayloadCanonicalizationVersion:
        receipt.decision.candidatePayloadCanonicalizationVersion,
      candidatePayloadSha256: receipt.decision.candidatePayloadSha256,
      compatibilityAccepted: false,
      attestations: [],
    },
  };
  return `sha256:${sha256(Buffer.from(`${JSON.stringify(candidateReceipt, null, 2)}\n`, "utf8"))}`;
}

function verifyCompatibilityFileRecord(record, baseDirectory, label) {
  assertExactKeys(record, ["path", "byteLength", "sha256"], [], label);
  const normalized = normalizeRelativePath(record.path, `${label}.path`);
  if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0) {
    fail(`${label}.byteLength is invalid.`);
  }
  assertSha256(record.sha256, `${label}.sha256`);
  const absolute = path.resolve(baseDirectory, ...normalized.split("/"));
  assertInside(baseDirectory, absolute, label);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${label} is missing ${normalized}.`);
  }
  if (lstatSync(absolute).isSymbolicLink()) fail(`${label} must not be a symlink.`);
  assertInside(realpathSync(baseDirectory), realpathSync(absolute), label);
  const bytes = readFileSync(absolute);
  if (
    bytes.length !== record.byteLength ||
    `sha256:${sha256(bytes)}` !== record.sha256
  ) {
    fail(`${label} length/hash mismatch for ${normalized}.`);
  }
  return { absolute, bytes, normalized };
}

function verifyCompatibilityReference(reference, bases, label) {
  assertExactKeys(
    reference,
    ["pathBase", "path", "byteLength", "sha256"],
    [],
    label,
  );
  const baseDirectory = bases[reference.pathBase];
  if (baseDirectory === undefined) fail(`${label}.pathBase is not approved.`);
  return verifyCompatibilityFileRecord(
    {
      path: reference.path,
      byteLength: reference.byteLength,
      sha256: reference.sha256,
    },
    baseDirectory,
    label,
  );
}

function verifyCompatibilityFileRecords(records, baseDirectory, label) {
  if (!Array.isArray(records)) fail(`${label} must be an array.`);
  const seen = new Set();
  return records.map((record, index) => {
    const verified = verifyCompatibilityFileRecord(
      record,
      baseDirectory,
      `${label}[${index}]`,
    );
    if (seen.has(verified.normalized)) fail(`${label} duplicates ${verified.normalized}.`);
    seen.add(verified.normalized);
    return verified;
  });
}

function validateCompatibilityTreeManifest(manifest, evidenceDirectory, expectedId) {
  assertExactKeys(
    manifest,
    ["schemaVersion", "manifestId", "pathBase", "root", "files"],
    [],
    `${expectedId} manifest`,
  );
  if (
    manifest.schemaVersion !== "aaw.phase3-p3d.content-tree-manifest/v1" ||
    manifest.manifestId !== expectedId ||
    manifest.pathBase !== "manifest-root"
  ) {
    fail(`${expectedId} manifest identity is invalid.`);
  }
  const root = normalizeRelativePath(manifest.root, `${expectedId}.root`);
  const absoluteRoot = path.resolve(evidenceDirectory, ...root.split("/"));
  assertInside(evidenceDirectory, absoluteRoot, `${expectedId}.root`);
  if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
    fail(`${expectedId} manifest root is missing.`);
  }
  const verified = verifyCompatibilityFileRecords(
    manifest.files,
    absoluteRoot,
    `${expectedId}.files`,
  );
  const declared = verified.map((entry) => entry.normalized).sort(compareText);
  const actual = listFilesRecursive(absoluteRoot);
  if (!isDeepStrictEqual(declared, actual)) {
    fail(`${expectedId} manifest does not describe its complete tree.`);
  }
}

function validateCompatibilityReviewAttestations(receipt, bases) {
  assertExactKeys(
    receipt.decision,
    [
      "candidatePayloadCanonicalizationVersion",
      "candidatePayloadSha256",
      "compatibilityAccepted",
      "approvedAt",
      "attestations",
    ],
    [],
    "compatibility decision",
  );
  if (
    receipt.status !== "APPROVED" ||
    receipt.decision.candidatePayloadCanonicalizationVersion !== "aaw-json-c14n/v1" ||
    receipt.decision.candidatePayloadSha256 !== APPROVED_COMPATIBILITY_PAYLOAD_SHA256 ||
    receipt.decision.compatibilityAccepted !== true
  ) {
    fail("Compatibility receipt is not the exact approved candidate payload.");
  }
  assertDateTime(receipt.decision.approvedAt, "compatibility decision approvedAt");
  const calculatedPayloadSha256 = compatibilityCandidatePayloadSha256(receipt);
  if (calculatedPayloadSha256 !== APPROVED_COMPATIBILITY_PAYLOAD_SHA256) {
    fail("Compatibility receipt canonical payload digest mismatch.");
  }
  if (!Array.isArray(receipt.decision.attestations)) {
    fail("Compatibility attestations must be an array.");
  }
  const expectedCandidateFileSha256 = reviewedCompatibilityCandidateFileSha256(receipt);
  const roles = new Set();
  for (const [index, attestation] of receipt.decision.attestations.entries()) {
    assertExactKeys(
      attestation,
      [
        "ownerRole",
        "reviewerTask",
        "verdict",
        "reviewedAt",
        "boundCandidatePayloadSha256",
        "reviewReport",
      ],
      [],
      `compatibility attestation[${index}]`,
    );
    const expectedReviewer = COMPATIBILITY_REVIEWERS[attestation.ownerRole];
    if (
      expectedReviewer === undefined ||
      attestation.reviewerTask !== expectedReviewer ||
      attestation.verdict !== "PASS" ||
      attestation.boundCandidatePayloadSha256 !== APPROVED_COMPATIBILITY_PAYLOAD_SHA256
    ) {
      fail(`compatibility attestation[${index}] identity/verdict is invalid.`);
    }
    assertDateTime(attestation.reviewedAt, `compatibility attestation[${index}].reviewedAt`);
    if (roles.has(attestation.ownerRole)) {
      fail(`Duplicate compatibility owner role ${attestation.ownerRole}.`);
    }
    roles.add(attestation.ownerRole);
    const reportArtifact = verifyCompatibilityReference(
      attestation.reviewReport,
      bases,
      `compatibility attestation[${index}].reviewReport`,
    );
    const report = JSON.parse(reportArtifact.bytes.toString("utf8"));
    assertExactKeys(
      report,
      [
        "schemaVersion",
        "ownerRole",
        "reviewerTask",
        "verdict",
        "reviewedAt",
        "receiptSha256",
        "candidatePayloadSha256",
        "findings",
      ],
      [],
      `compatibility review ${attestation.ownerRole}`,
    );
    if (
      report.schemaVersion !== "aaw.phase3-p3d.compatibility-review/v1" ||
      report.ownerRole !== attestation.ownerRole ||
      report.reviewerTask !== attestation.reviewerTask ||
      report.verdict !== "PASS" ||
      report.reviewedAt !== attestation.reviewedAt ||
      report.receiptSha256 !== expectedCandidateFileSha256 ||
      report.candidatePayloadSha256 !== APPROVED_COMPATIBILITY_PAYLOAD_SHA256 ||
      !Array.isArray(report.findings) ||
      report.findings.length === 0
    ) {
      fail(`Compatibility review ${attestation.ownerRole} is not bound to the candidate.`);
    }
    for (const [findingIndex, finding] of report.findings.entries()) {
      assertNonEmptyString(
        finding,
        `compatibility review ${attestation.ownerRole}.findings[${findingIndex}]`,
      );
    }
  }
  if (!isDeepStrictEqual([...roles].sort(compareText), Object.keys(COMPATIBILITY_REVIEWERS).sort(compareText))) {
    fail("Compatibility receipt requires exact QA, GUI and security PASS attestations.");
  }
}

function validateCompatibilityAllowlist(allowlist, runMap, evidenceDirectory) {
  assertExactKeys(
    allowlist,
    [
      "schemaVersion",
      "singlePairOnly",
      "direction",
      "nonTransitive",
      "noGeneralCrossCohortWaiver",
      "noFutureCohortReuse",
      "previousHarnessSha256",
      "currentHarnessSha256",
      "commonProductMainSha256",
      "packageLockSha256",
      "preservedPageZoomCaseId",
      "addedPageZoomCaseIds",
      "pageZoom",
      "allowedSourcePatchSha256",
      "runs",
    ],
    [],
    "compatibility allowlist",
  );
  if (
    allowlist.schemaVersion !== "aaw.phase3-p3d.monotonic-harness-allowlist/v1alpha1" ||
    allowlist.singlePairOnly !== true ||
    allowlist.direction !== "previous-to-current" ||
    allowlist.nonTransitive !== true ||
    allowlist.noGeneralCrossCohortWaiver !== true ||
    allowlist.noFutureCohortReuse !== true ||
    allowlist.previousHarnessSha256 !== APPROVED_PREVIOUS_HARNESS_SHA256 ||
    allowlist.currentHarnessSha256 !== APPROVED_CURRENT_HARNESS_SHA256 ||
    allowlist.commonProductMainSha256 !== APPROVED_PRODUCT_MAIN_SHA256 ||
    allowlist.packageLockSha256 !== APPROVED_PACKAGE_LOCK_SHA256 ||
    allowlist.preservedPageZoomCaseId !== "two-tabs-ready-current" ||
    !isDeepStrictEqual(allowlist.addedPageZoomCaseIds, [
      "selection-and-net-current",
      "inspector-and-hierarchy-current",
    ]) ||
    allowlist.pageZoom !== 2 ||
    allowlist.allowedSourcePatchSha256 !==
      "sha256:a37673e4acd36d803630454984bdc6fd41ba3ba11342c9563113fcb3ad93aaf1"
  ) {
    fail("Compatibility allowlist is not the exact approved monotonic delta.");
  }
  if (!Array.isArray(allowlist.runs)) fail("Compatibility allowlist runs must be an array.");
  const actualById = runMap;
  const expectedRunIds = [
    "P3D-WIN-PROD-100-RERUN-61",
    "P3D-WIN-DEV-100-RERUN-61",
    "P3D-WIN-DEV-125-RERUN-64",
    "P3D-WIN-DEV-150-RERUN-65",
    "P3D-WIN-DEV-HC-RERUN-63",
    "P3D-WIN-RACE-RERUN-61",
    "P3D-WIN-DEV-ZOOM200-RERUN-66",
  ].sort(compareText);
  const allowedRunIds = allowlist.runs.map((run) => run.runId).sort(compareText);
  if (
    !isDeepStrictEqual(allowedRunIds, expectedRunIds)
  ) {
    fail(
      `Compatibility receipt is restricted to the exact seven selected runs; allowed=${allowedRunIds.join(",")}.`,
    );
  }
  const seenRuns = new Set();
  for (const [runIndex, allowedRun] of allowlist.runs.entries()) {
    assertExactKeys(
      allowedRun,
      [
        "runId",
        "attemptId",
        "productMainSha256",
        "testHarnessSha256",
        "packageLockSha256",
        "metadataSha256",
        "runtimeSummarySha256",
        "cases",
      ],
      [],
      `compatibility allowlist run[${runIndex}]`,
    );
    if (seenRuns.has(allowedRun.runId)) fail(`Duplicate compatibility run ${allowedRun.runId}.`);
    seenRuns.add(allowedRun.runId);
    const actual = actualById.get(allowedRun.runId);
    if (actual === undefined) fail(`Compatibility run ${allowedRun.runId} is not current.`);
    const metadataPath = path.join(evidenceDirectory, "runs", allowedRun.runId, "run-metadata.json");
    const summaryPath = path.join(evidenceDirectory, "runs", allowedRun.runId, "runtime-summary.json");
    const metadata = actual.runtime.metadata;
    if (
      allowedRun.attemptId !== metadata.attemptId ||
      allowedRun.productMainSha256 !== metadata.exactProductMainSha256 ||
      allowedRun.testHarnessSha256 !== metadata.testBundleSha256 ||
      allowedRun.packageLockSha256 !== metadata.packageLockSha256 ||
      allowedRun.metadataSha256 !== `sha256:${sha256(readFileSync(metadataPath))}` ||
      allowedRun.runtimeSummarySha256 !== `sha256:${sha256(readFileSync(summaryPath))}`
    ) {
      fail(`Compatibility run ${allowedRun.runId} metadata binding mismatch.`);
    }
    const actualCases = new Map(actual.results.map((entry) => [entry.result.caseId, entry]));
    if (!Array.isArray(allowedRun.cases) || allowedRun.cases.length !== actualCases.size) {
      fail(`Compatibility run ${allowedRun.runId} case count mismatch.`);
    }
    const seenCases = new Set();
    for (const [caseIndex, allowedCase] of allowedRun.cases.entries()) {
      assertExactKeys(
        allowedCase,
        ["caseId", "required", "status", "resultSha256"],
        [],
        `compatibility run ${allowedRun.runId} case[${caseIndex}]`,
      );
      if (seenCases.has(allowedCase.caseId)) {
        fail(`Compatibility run ${allowedRun.runId} duplicates ${allowedCase.caseId}.`);
      }
      seenCases.add(allowedCase.caseId);
      const actualCase = actualCases.get(allowedCase.caseId);
      if (
        actualCase === undefined ||
        allowedCase.required !== actualCase.result.required ||
        allowedCase.status !== actualCase.result.status ||
        allowedCase.resultSha256 !==
          `sha256:${sha256(readFileSync(path.join(evidenceDirectory, ...actualCase.relativePath.split("/"))))}`
      ) {
        fail(`Compatibility run ${allowedRun.runId}/${allowedCase.caseId} mismatch.`);
      }
    }
  }
  const zoom = allowlist.runs.find(
    (run) => run.runId === "P3D-WIN-DEV-ZOOM200-RERUN-66",
  );
  if (
    zoom === undefined ||
    zoom.cases.filter((entry) => entry.status === "PASS").length !== 3 ||
    zoom.cases.filter((entry) => entry.status === "NOT_RUN").length !== 7
  ) {
    fail("Page-zoom compatibility must remain exactly 3 PASS plus 7 NOT_RUN.");
  }
  return RUN_FAMILIES.map((family) => {
    const selected = allowlist.runs.find(
      (run) => actualById.get(run.runId)?.family.id === family.id,
    );
    if (selected === undefined) {
      fail(`Compatibility allowlist is missing family ${family.id}.`);
    }
    return actualById.get(selected.runId);
  });
}

function validateApprovedCompatibilityReceipt(evidenceDirectory, runMap) {
  const receiptArtifact = resolveEvidenceFile(
    evidenceDirectory,
    COMPATIBILITY_RECEIPT_RELATIVE_PATH,
    "approved compatibility receipt",
  );
  const receipt = readJson(receiptArtifact.absolute, "approved compatibility receipt");
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "status",
      "pathBases",
      "contentManifest",
      "exactAllowlist",
      "singlePair",
      "machineCheckedDelta",
      "artifactCoverage",
      "decision",
    ],
    [],
    "approved compatibility receipt",
  );
  if (receipt.schemaVersion !== COMPATIBILITY_RECEIPT_SCHEMA) {
    fail("Approved compatibility receipt schema is invalid.");
  }
  assertExactKeys(
    receipt.pathBases,
    ["evidence-root", "repository-root"],
    [],
    "compatibility pathBases",
  );
  const expectedEvidenceRoot = toPosix(path.resolve(evidenceDirectory));
  const expectedRepositoryRoot = toPosix(projectRoot);
  if (
    receipt.pathBases["evidence-root"] !== expectedEvidenceRoot ||
    receipt.pathBases["repository-root"] !== expectedRepositoryRoot
  ) {
    fail("Compatibility receipt path bases do not name the current repository/evidence root.");
  }
  const bases = Object.freeze({
    "evidence-root": evidenceDirectory,
    "repository-root": projectRoot,
  });
  assertExactKeys(
    receipt.singlePair,
    [
      "previousHarnessSha256",
      "currentHarnessSha256",
      "commonProductMainSha256",
      "packageLockSha256",
      "direction",
      "singlePairOnly",
      "nonTransitive",
      "noGeneralCrossCohortWaiver",
      "noFutureCohortReuse",
    ],
    [],
    "compatibility singlePair",
  );
  if (
    receipt.singlePair.previousHarnessSha256 !== APPROVED_PREVIOUS_HARNESS_SHA256 ||
    receipt.singlePair.currentHarnessSha256 !== APPROVED_CURRENT_HARNESS_SHA256 ||
    receipt.singlePair.commonProductMainSha256 !== APPROVED_PRODUCT_MAIN_SHA256 ||
    receipt.singlePair.packageLockSha256 !== APPROVED_PACKAGE_LOCK_SHA256 ||
    receipt.singlePair.direction !== "previous-to-current" ||
    receipt.singlePair.singlePairOnly !== true ||
    receipt.singlePair.nonTransitive !== true ||
    receipt.singlePair.noGeneralCrossCohortWaiver !== true ||
    receipt.singlePair.noFutureCohortReuse !== true
  ) {
    fail("Compatibility receipt single-pair restriction is invalid.");
  }
  assertExactKeys(
    receipt.machineCheckedDelta,
    [
      "sourcePatch",
      "patchApplyCheck",
      "preservedPageZoomCaseId",
      "addedPageZoomCaseIds",
      "pageZoom",
      "failClosedOnMissingOrNonRunnableCase",
      "allOtherSourceArtifactOracleSecurityProductionDifferencesAllowed",
    ],
    [],
    "compatibility machineCheckedDelta",
  );
  if (
    receipt.machineCheckedDelta.preservedPageZoomCaseId !== "two-tabs-ready-current" ||
    !isDeepStrictEqual(receipt.machineCheckedDelta.addedPageZoomCaseIds, [
      "selection-and-net-current",
      "inspector-and-hierarchy-current",
    ]) ||
    receipt.machineCheckedDelta.pageZoom !== 2 ||
    receipt.machineCheckedDelta.failClosedOnMissingOrNonRunnableCase !== true ||
    receipt.machineCheckedDelta.allOtherSourceArtifactOracleSecurityProductionDifferencesAllowed !== false
  ) {
    fail("Compatibility machine-checked delta is not fail-closed.");
  }
  assertExactKeys(
    receipt.artifactCoverage,
    [
      "selectedRunCount",
      "includesProduction100",
      "includesNative100",
      "includesNative125",
      "includesNative150",
      "includesHighContrast",
      "includesLifecycleRace",
      "includesPageZoom200",
      "pageZoom200PassCount",
      "pageZoom200NotRunCount",
      "bindsRunMetadataSummaryResultsRawAndScreenshots",
      "bindsPreviousAndCurrentMainTrees",
      "bindsPreviousAndCurrentRendererTrees",
      "bindsProductMainRendererPreloadCspAndLockfile",
      "preservesAllHistoricalAttempts",
    ],
    [],
    "compatibility artifactCoverage",
  );
  if (
    receipt.artifactCoverage.selectedRunCount !== 7 ||
    receipt.artifactCoverage.pageZoom200PassCount !== 3 ||
    receipt.artifactCoverage.pageZoom200NotRunCount !== 7 ||
    Object.entries(receipt.artifactCoverage).some(
      ([key, value]) =>
        key !== "selectedRunCount" &&
        key !== "pageZoom200PassCount" &&
        key !== "pageZoom200NotRunCount" &&
        value !== true,
    )
  ) {
    fail("Compatibility artifact coverage is incomplete.");
  }
  validateCompatibilityReviewAttestations(receipt, bases);
  const contentArtifact = verifyCompatibilityReference(
    receipt.contentManifest,
    bases,
    "compatibility contentManifest",
  );
  if (receipt.contentManifest.path !== "cohort-reconstruction/compatibility-content.manifest.json") {
    fail("Compatibility content manifest path is not fixed.");
  }
  const contentManifest = JSON.parse(contentArtifact.bytes.toString("utf8"));
  assertExactKeys(
    contentManifest,
    ["schemaVersion", "pathBase", "artifacts"],
    [],
    "compatibility content manifest",
  );
  if (
    contentManifest.schemaVersion !== "aaw.phase3-p3d.compatibility-content-manifest/v1" ||
    contentManifest.pathBase !== "evidence-root" ||
    !Array.isArray(contentManifest.artifacts)
  ) {
    fail("Compatibility content manifest identity is invalid.");
  }
  const contentByPath = new Map();
  for (const [index, record] of contentManifest.artifacts.entries()) {
    const verified = verifyCompatibilityFileRecord(
      record,
      evidenceDirectory,
      `compatibility content[${index}]`,
    );
    if (contentByPath.has(verified.normalized)) {
      fail(`Compatibility content duplicates ${verified.normalized}.`);
    }
    contentByPath.set(verified.normalized, verified);
  }
  if (
    !isDeepStrictEqual(
      [...contentByPath.keys()].sort(compareText),
      [...COMPATIBILITY_CONTENT_PATHS].sort(compareText),
    )
  ) {
    fail("Compatibility content manifest must contain the exact ten approved artifacts.");
  }
  for (const [relativePath, manifestId] of [
    ["cohort-reconstruction/manifests/previous-main-harness.json", "previous-main-harness"],
    ["cohort-reconstruction/manifests/current-main-harness.json", "current-main-harness"],
    [
      "cohort-reconstruction/manifests/previous-renderer-harness.json",
      "previous-renderer-harness-reconstruction",
    ],
    ["cohort-reconstruction/manifests/current-renderer-harness.json", "current-renderer-harness"],
  ]) {
    validateCompatibilityTreeManifest(
      JSON.parse(contentByPath.get(relativePath).bytes.toString("utf8")),
      evidenceDirectory,
      manifestId,
    );
  }
  const selected = JSON.parse(
    contentByPath
      .get("cohort-reconstruction/manifests/selected-evidence.json")
      .bytes.toString("utf8"),
  );
  assertExactKeys(
    selected,
    ["schemaVersion", "pathBase", "selectedRuns"],
    [],
    "selected compatibility evidence",
  );
  if (
    selected.schemaVersion !== "aaw.phase3-p3d.selected-evidence-manifest/v1" ||
    selected.pathBase !== "evidence-root" ||
    !Array.isArray(selected.selectedRuns) ||
    selected.selectedRuns.length !== 7
  ) {
    fail("Selected compatibility evidence identity/count is invalid.");
  }
  for (const [index, selectedRun] of selected.selectedRuns.entries()) {
    assertExactKeys(selectedRun, ["runId", "files"], [], `selected run[${index}]`);
    verifyCompatibilityFileRecords(
      selectedRun.files,
      evidenceDirectory,
      `selected run ${selectedRun.runId}.files`,
    );
  }
  for (const [relativePath, schemaVersion, expectedPathBase] of [
    [
      "cohort-reconstruction/manifests/product-runtime.json",
      "aaw.phase3-p3d.product-runtime-manifest/v1",
      "repository-root",
    ],
    [
      "cohort-reconstruction/manifests/reconstruction-inputs.json",
      "aaw.phase3-p3d.reconstruction-inputs-manifest/v1",
      "repository-root",
    ],
  ]) {
    const manifest = JSON.parse(contentByPath.get(relativePath).bytes.toString("utf8"));
    assertExactKeys(manifest, ["schemaVersion", "pathBase", "files"], [], relativePath);
    if (manifest.schemaVersion !== schemaVersion || manifest.pathBase !== expectedPathBase) {
      fail(`${relativePath} identity is invalid.`);
    }
    verifyCompatibilityFileRecords(manifest.files, projectRoot, `${relativePath}.files`);
  }
  const patchArtifact = verifyCompatibilityReference(
    receipt.machineCheckedDelta.sourcePatch,
    bases,
    "compatibility sourcePatch",
  );
  const boundPatch = contentByPath.get("cohort-reconstruction/source-delta.patch");
  if (
    patchArtifact.bytes.length !== boundPatch.bytes.length ||
    sha256(patchArtifact.bytes) !== sha256(boundPatch.bytes)
  ) {
    fail("Compatibility source patch references disagree.");
  }
  const patchCheckArtifact = verifyCompatibilityReference(
    receipt.machineCheckedDelta.patchApplyCheck,
    bases,
    "compatibility patchApplyCheck",
  );
  const patchCheck = JSON.parse(patchCheckArtifact.bytes.toString("utf8"));
  assertExactKeys(
    patchCheck,
    ["schemaVersion", "checkExitCode", "applyExitCode", "postApply"],
    [],
    "compatibility patch apply check",
  );
  if (
    patchCheck.schemaVersion !== "aaw.phase3-p3d.compatibility-patch-check/v1" ||
    patchCheck.checkExitCode !== 0 ||
    patchCheck.applyExitCode !== 0 ||
    !Array.isArray(patchCheck.postApply) ||
    patchCheck.postApply.length !== 2 ||
    patchCheck.postApply.some(
      (entry) => entry.expectedSha256 !== entry.actualSha256,
    )
  ) {
    fail("Compatibility patch did not apply to the exact current sources.");
  }
  const allowlistArtifact = verifyCompatibilityReference(
    receipt.exactAllowlist,
    bases,
    "compatibility exactAllowlist",
  );
  if (receipt.exactAllowlist.path !== "cohort-reconstruction/manifests/compatibility-allowlist.json") {
    fail("Compatibility allowlist path is not fixed.");
  }
  const boundAllowlist = contentByPath.get(receipt.exactAllowlist.path);
  if (
    allowlistArtifact.bytes.length !== boundAllowlist.bytes.length ||
    sha256(allowlistArtifact.bytes) !== sha256(boundAllowlist.bytes)
  ) {
    fail("Compatibility allowlist references disagree.");
  }
  const selectedRuns = validateCompatibilityAllowlist(
    JSON.parse(allowlistArtifact.bytes.toString("utf8")),
    runMap,
    evidenceDirectory,
  );
  return Object.freeze({
    selectedRuns: Object.freeze(selectedRuns),
    receipt: Object.freeze({
      receiptRelativePath: COMPATIBILITY_RECEIPT_RELATIVE_PATH,
      candidatePayloadSha256: APPROVED_COMPATIBILITY_PAYLOAD_SHA256,
      previousHarnessSha256: APPROVED_PREVIOUS_HARNESS_SHA256,
      currentHarnessSha256: APPROVED_CURRENT_HARNESS_SHA256,
    }),
  });
}

function artifactRecord(evidenceDirectory, relativePath) {
  const { absolute, normalized } = resolveEvidenceFile(
    evidenceDirectory,
    relativePath,
    `artifact ${relativePath}`,
  );
  const bytes = readFileSync(absolute);
  return {
    relativePath: normalized,
    length: bytes.length,
    sha256: `sha256:${sha256(bytes)}`,
  };
}

function parseArguments(argv) {
  const options = {
    entryDirectory: defaultEntryDirectory,
    evidenceDirectory: null,
    metadataPath: null,
    initTemplate: false,
    selfTest: false,
    sealEmptyFirstAttempts: false,
    sealEmptyAttempts: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--init-template") options.initTemplate = true;
    else if (argument === "--seal-empty-first-attempts") {
      options.sealEmptyFirstAttempts = true;
    }
    else if (argument === "--seal-empty-attempts") options.sealEmptyAttempts = true;
    else if (argument === "--entry-dir") {
      options.entryDirectory = path.resolve(argv[++index] ?? fail("--entry-dir needs a value."));
    } else if (argument === "--evidence-dir") {
      options.evidenceDirectory = path.resolve(
        argv[++index] ?? fail("--evidence-dir needs a value."),
      );
    } else if (argument === "--metadata") {
      options.metadataPath = path.resolve(argv[++index] ?? fail("--metadata needs a value."));
    } else fail(`Unknown argument ${argument}.`);
  }
  if (
    [
      options.selfTest,
      options.initTemplate,
      options.sealEmptyFirstAttempts,
      options.sealEmptyAttempts,
    ].filter(Boolean)
      .length > 1
  ) fail("Choose only one special mode.");
  if (
    !options.selfTest &&
    !options.initTemplate &&
    !options.sealEmptyFirstAttempts &&
    !options.sealEmptyAttempts &&
    options.evidenceDirectory === null
  ) {
    fail("--evidence-dir is required.");
  }
  if (options.sealEmptyFirstAttempts && options.evidenceDirectory === null) {
    fail("--seal-empty-first-attempts requires --evidence-dir.");
  }
  if (options.sealEmptyAttempts && options.evidenceDirectory === null) {
    fail("--seal-empty-attempts requires --evidence-dir.");
  }
  return options;
}

function validateEntry(entryDirectory) {
  assertInside(qualityEvidenceRoot, entryDirectory, "entry directory");
  const baselineManifestPath = path.join(entryDirectory, "baseline-manifest.json");
  const plannedPath = path.join(entryDirectory, "planned-change-paths.json");
  const entryReportPath = path.join(entryDirectory, "entry-report.json");
  const baselineTree = path.join(entryDirectory, "baseline-tree");
  for (const filePath of [baselineManifestPath, plannedPath, entryReportPath]) {
    if (!existsSync(filePath)) fail(`Missing P3-D entry file ${filePath}.`);
  }
  const baselineManifest = readJson(baselineManifestPath, "baseline manifest");
  const planned = readJson(plannedPath, "planned paths");
  const entryReport = readJson(entryReportPath, "entry report");
  if (
    baselineManifest.schemaVersion !== "aaw.quality.baseline-manifest/v1" ||
    planned.schemaVersion !== "aaw.quality.planned-change-paths/v1" ||
    baselineManifest.gateId !== GATE_ID ||
    planned.gateId !== GATE_ID
  ) fail("Entry schema or gate identity drifted.");
  if (
    planned.electronExecution !== "AUTHORIZED_SYNTHETIC_ONLY" ||
    planned.realPayload !== "NOT_AVAILABLE" ||
    planned.dependencyDelta !== 0 ||
    planned.stopOnUnlistedPath !== true
  ) fail("Entry authority/path/dependency discipline is not frozen.");
  if (!Array.isArray(baselineManifest.entries)) fail("Baseline entries must be an array.");
  const baseline = new Map();
  for (const [index, entry] of baselineManifest.entries.entries()) {
    assertExactKeys(entry, ["path", "length", "sha256"], [], `baseline.entries[${index}]`);
    const relativePath = normalizeRelativePath(entry.path, `baseline.entries[${index}].path`);
    if (baseline.has(relativePath)) fail(`Duplicate baseline path ${relativePath}.`);
    if (!Number.isSafeInteger(entry.length) || entry.length < 0) {
      fail(`Invalid baseline length for ${relativePath}.`);
    }
    if (!/^[0-9a-f]{64}$/u.test(entry.sha256)) fail(`Invalid baseline hash for ${relativePath}.`);
    const backupPath = path.join(baselineTree, ...relativePath.split("/"));
    if (!existsSync(backupPath) || !statSync(backupPath).isFile()) {
      fail(`Baseline backup is missing ${relativePath}.`);
    }
    const bytes = readFileSync(backupPath);
    if (bytes.length !== entry.length || sha256(bytes) !== entry.sha256) {
      fail(`Baseline backup mismatches ${relativePath}.`);
    }
    baseline.set(relativePath, entry);
  }
  if (
    baseline.size !== baselineManifest.entryCount ||
    listFilesRecursive(baselineTree).length !== baseline.size ||
    entryReport.baselineEntryCount !== baseline.size ||
    entryReport.baselineTreeEntryCount !== baseline.size ||
    entryReport.backupMismatchCount !== 0
  ) fail("P3-D entry backup count/mismatch evidence is invalid.");
  const parentBundleHash = sha256(readFileSync(parentBundlePath));
  if (
    parentBundleHash !== baselineManifest.parentCheckpointBundleSha256 ||
    parentBundleHash !== entryReport.parentCheckpointBundleSha256
  ) fail("P3-C parent bundle does not match the P3-D entry.");
  return {
    baseline,
    baselineManifestPath,
    baselineTree,
    parentBundleHash,
    planned,
    plannedPath,
  };
}

function validateExitMetadata(metadata, evidenceDirectory) {
  assertExactKeys(
    metadata,
    [
      "schemaVersion",
      "gateId",
      "startedAt",
      "endedAt",
      "environment",
      "commands",
      "tests",
      "approvals",
      "capabilities",
    ],
    [],
    "exit metadata",
  );
  if (metadata.schemaVersion !== EXIT_METADATA_SCHEMA || metadata.gateId !== GATE_ID) {
    fail("Exit metadata schemaVersion/gateId is invalid.");
  }
  assertDateTime(metadata.startedAt, "metadata.startedAt");
  assertDateTime(metadata.endedAt, "metadata.endedAt");
  if (Date.parse(metadata.endedAt) < Date.parse(metadata.startedAt)) {
    fail("metadata.endedAt precedes startedAt.");
  }
  assertExactKeys(
    metadata.environment,
    ["platform", "architecture", "node", "npm", "electron"],
    [],
    "metadata.environment",
  );
  const packageJson = readJson(path.join(projectRoot, "package.json"), "package.json");
  if (
    metadata.environment.platform !== "win32" ||
    metadata.environment.architecture !== process.arch ||
    metadata.environment.node !== packageJson.engines?.node ||
    metadata.environment.npm !== packageJson.packageManager?.replace(/^npm@/u, "") ||
    metadata.environment.electron !== packageJson.devDependencies?.electron ||
    process.platform !== "win32" ||
    process.version.replace(/^v/u, "") !== packageJson.engines?.node
  ) fail("Exit metadata/tool environment does not match package pins.");
  if (!Array.isArray(metadata.commands) || metadata.commands.length === 0) {
    fail("metadata.commands must be non-empty.");
  }
  const commandNames = new Set();
  for (const [index, command] of metadata.commands.entries()) {
    assertExactKeys(
      command,
      ["name", "exitCode", "rawLog", "exitCodeFile"],
      [],
      `metadata.commands[${index}]`,
    );
    assertNonEmptyString(command.name, `metadata.commands[${index}].name`, 120);
    if (!Number.isInteger(command.exitCode)) fail(`metadata.commands[${index}].exitCode is invalid.`);
    if (commandNames.has(command.name)) fail(`Duplicate command ${command.name}.`);
    commandNames.add(command.name);
    resolveEvidenceFile(evidenceDirectory, command.rawLog, `command ${command.name} rawLog`);
    const exitArtifact = resolveEvidenceFile(
      evidenceDirectory,
      command.exitCodeFile,
      `command ${command.name} exitCodeFile`,
    );
    if (readFileSync(exitArtifact.absolute, "utf8").trim() !== String(command.exitCode)) {
      fail(`Command ${command.name} exit code artifact disagrees with metadata.`);
    }
  }
  assertExactKeys(metadata.tests, ["total", "failed"], [], "metadata.tests");
  if (
    !Number.isSafeInteger(metadata.tests.total) ||
    metadata.tests.total < 0 ||
    !Number.isSafeInteger(metadata.tests.failed) ||
    metadata.tests.failed < 0 ||
    metadata.tests.failed > metadata.tests.total
  ) fail("metadata.tests is invalid.");
  assertExactKeys(
    metadata.approvals,
    ["product", "qa", "gui", "security"],
    [],
    "metadata.approvals",
  );
  assertNonEmptyString(metadata.approvals.product, "metadata.approvals.product", 120);
  for (const owner of ["qa", "gui", "security"]) {
    if (metadata.approvals[owner] !== null) {
      assertNonEmptyString(metadata.approvals[owner], `metadata.approvals.${owner}`, 120);
    }
  }
  if (!Array.isArray(metadata.capabilities)) fail("metadata.capabilities must be an array.");
  const capabilityNames = new Set();
  for (const [index, capability] of metadata.capabilities.entries()) {
    assertExactKeys(
      capability,
      ["name", "status", "reason", "owner", "exitCondition"],
      [],
      `metadata.capabilities[${index}]`,
    );
    if (!REQUIRED_CAPABILITIES.includes(capability.name)) fail(`Unknown capability ${capability.name}.`);
    if (capability.status !== "NOT_AVAILABLE") fail(`${capability.name} must remain NOT_AVAILABLE.`);
    for (const key of ["reason", "owner", "exitCondition"]) {
      assertNonEmptyString(capability[key], `metadata.capabilities[${index}].${key}`);
    }
    if (capabilityNames.has(capability.name)) fail(`Duplicate capability ${capability.name}.`);
    capabilityNames.add(capability.name);
  }
  for (const name of REQUIRED_CAPABILITIES) {
    if (!capabilityNames.has(name)) fail(`Missing NOT_AVAILABLE capability ${name}.`);
  }
}

function validateResultContract(result, label) {
  assertExactKeys(result, RESULT_KEYS, [], label);
  if (result.schemaVersion !== RESULT_SCHEMA) fail(`${label}.schemaVersion is invalid.`);
  if (result.phase !== "work" && result.phase !== "exit") fail(`${label}.phase is invalid.`);
  assertNonEmptyString(result.caseId, `${label}.caseId`, 2048);
  if (typeof result.required !== "boolean" || !RESULT_STATUSES.has(result.status)) {
    fail(`${label} identity/status is invalid.`);
  }
  assertExactKeys(result.environment, ENVIRONMENT_KEYS, [], `${label}.environment`);
  const environment = result.environment;
  if (
    environment.platform !== "win32" ||
    !Number.isSafeInteger(environment.physicalWidth) ||
    environment.physicalWidth <= 0 ||
    !Number.isSafeInteger(environment.physicalHeight) ||
    environment.physicalHeight <= 0 ||
    typeof environment.deviceScaleFactor !== "number" ||
    !Number.isFinite(environment.deviceScaleFactor) ||
    environment.deviceScaleFactor <= 0 ||
    typeof environment.pageZoom !== "number" ||
    !Number.isFinite(environment.pageZoom) ||
    environment.pageZoom <= 0 ||
    typeof environment.forcedColorsActive !== "boolean"
  ) fail(`${label}.environment is not real Windows evidence.`);
  assertExactKeys(result.oracles, RESULT_ORACLE_KEYS, [], `${label}.oracles`);
  const booleanKeys = RESULT_ORACLE_KEYS.slice(0, 9);
  const counterKeys = RESULT_ORACLE_KEYS.slice(9);
  for (const key of booleanKeys) {
    if (typeof result.oracles[key] !== "boolean") fail(`${label}.oracles.${key} is invalid.`);
  }
  for (const key of counterKeys) {
    if (!Number.isSafeInteger(result.oracles[key]) || result.oracles[key] < 0) {
      fail(`${label}.oracles.${key} is invalid.`);
    }
    if (result.oracles[key] !== 0) fail(`${label} reports forbidden side effect ${key}.`);
  }
  if (result.screenshot !== null) {
    assertExactKeys(
      result.screenshot,
      ["relativePath", "width", "height", "sha256"],
      [],
      `${label}.screenshot`,
    );
    normalizeRelativePath(result.screenshot.relativePath, `${label}.screenshot.relativePath`);
    if (
      result.screenshot.width !== environment.physicalWidth ||
      result.screenshot.height !== environment.physicalHeight
    ) fail(`${label}.screenshot dimensions do not match the environment.`);
    assertSha256(result.screenshot.sha256, `${label}.screenshot.sha256`);
  }
  if (result.rawLog !== null) {
    assertExactKeys(result.rawLog, ["relativePath", "sha256"], [], `${label}.rawLog`);
    normalizeRelativePath(result.rawLog.relativePath, `${label}.rawLog.relativePath`);
    assertSha256(result.rawLog.sha256, `${label}.rawLog.sha256`);
  }
  if (result.blocker !== null) {
    assertExactKeys(
      result.blocker,
      ["reason", "owner", "exitCondition"],
      [],
      `${label}.blocker`,
    );
    for (const key of ["reason", "owner", "exitCondition"]) {
      assertNonEmptyString(result.blocker[key], `${label}.blocker.${key}`, 2048);
    }
  }
  if (result.status === "PASS") {
    const lifecycleWindowClose = result.caseId === "windows-lifecycle/window-close";
    if (
      (!lifecycleWindowClose && result.screenshot === null) ||
      result.rawLog === null ||
      result.blocker !== null ||
      result.oracles.typedResolvePath !== true ||
      result.oracles.exactRevisionBinding !== true ||
      (!lifecycleWindowClose &&
        (result.oracles.persistentBannerVisible !== true ||
          result.oracles.noHorizontalOverflow !== true ||
          result.oracles.focusContract !== true ||
          result.oracles.ariaContract !== true)) ||
      result.oracles.artifactDigestUnchanged !== true
    ) fail(`${label} PASS evidence is incomplete.`);
  } else if (result.status === "NOT_RUN") {
    if (result.blocker === null) fail(`${label} NOT_RUN requires an owned blocker.`);
    if (result.required && result.phase === "exit") fail(`${label} required exit case cannot be NOT_RUN.`);
  } else if (result.blocker === null) fail(`${label} failure/BLOCKED requires an owned blocker.`);
  return result;
}

function pngDimensions(bytes, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) fail(`${label} is not a PNG.`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function verifyResultArtifacts(result, evidenceDirectory, label) {
  if (result.rawLog !== null) {
    const raw = resolveEvidenceFile(evidenceDirectory, result.rawLog.relativePath, `${label}.rawLog`);
    const rawBytes = readFileSync(raw.absolute);
    if (`sha256:${sha256(rawBytes)}` !== result.rawLog.sha256) {
      fail(`${label}.rawLog hash mismatch.`);
    }
    if (result.status === "PASS" && result.caseId === "windows-lifecycle/window-close") {
      let observation;
      try {
        observation = JSON.parse(rawBytes.toString("utf8"));
      } catch {
        fail(`${label}.rawLog is not a valid lifecycle observation.`);
      }
      if (
        observation?.schemaVersion !== "aaw.phase3-p3d.lifecycle-raw/v1" ||
        observation?.externalObservation?.schemaVersion !==
          "aaw.phase3-p3d.window-absence/v1" ||
        observation?.externalObservation?.windowAbsent !== true ||
        observation?.externalObservation?.observationAvailable !== true
      ) {
        fail(`${label} lacks a bound external window-absence observation.`);
      }
    }
  }
  if (result.screenshot !== null) {
    const screenshot = resolveEvidenceFile(
      evidenceDirectory,
      result.screenshot.relativePath,
      `${label}.screenshot`,
    );
    const bytes = readFileSync(screenshot.absolute);
    if (`sha256:${sha256(bytes)}` !== result.screenshot.sha256) fail(`${label}.screenshot hash mismatch.`);
    const dimensions = pngDimensions(bytes, `${label}.screenshot`);
    if (dimensions.width !== result.screenshot.width || dimensions.height !== result.screenshot.height) {
      fail(`${label}.screenshot encoded dimensions mismatch.`);
    }
  }
}

function parseRunIdentity(runId) {
  for (const family of RUN_FAMILIES) {
    if (runId === `${family.prefix}-01`) return { family, attempt: 1 };
    if (runId.startsWith(`${family.prefix}-RERUN-`)) {
      const suffix = runId.slice(`${family.prefix}-RERUN-`.length);
      if (!/^[0-9]{2}$/u.test(suffix) || Number(suffix) < 1) fail(`${runId} has invalid rerun ordinal.`);
      return { family, attempt: Number(suffix) + 1 };
    }
  }
  fail(`Unknown run family ${runId}.`);
}

function aggregateStatuses(results) {
  if (results.some((entry) => entry.result.status === "FAIL")) return "FAIL";
  if (results.some((entry) => entry.result.status === "BLOCKED")) return "BLOCKED";
  if (results.some((entry) => entry.result.status === "NOT_RUN")) return "NOT_RUN";
  return "PASS";
}

function validateExpectedResult(resultEntry, expected, label) {
  const result = resultEntry.result;
  if (result.caseId !== expected.caseId || result.required !== true) {
    fail(`${label} does not satisfy required case ${expected.caseId}.`);
  }
  const profile = PROFILE_ENVIRONMENTS[expected.profileId];
  if (
    result.status === "PASS" &&
    (result.environment.physicalWidth !== 1366 ||
      result.environment.physicalHeight !== 768 ||
      result.environment.deviceScaleFactor !== profile.deviceScaleFactor ||
      result.environment.pageZoom !== profile.pageZoom ||
      result.environment.forcedColorsActive !== profile.forcedColorsActive)
  ) fail(`${label} PASS environment does not match profile ${expected.profileId}.`);
  if (
    result.status === "PASS" &&
    (result.phase !== "exit" ||
      result.oracles.geometryAllowed !== expected.geometryAllowed ||
      result.oracles.overlayBannerVisible !== expected.overlayBannerVisible)
  ) fail(`${label} PASS terminal/overlay semantics mismatch ${expected.caseId}.`);
}

function validateRunMetadata(runDirectory, runId, status) {
  const metadataPath = path.join(runDirectory, "run-metadata.json");
  const summaryPath = path.join(runDirectory, "runtime-summary.json");
  if (!existsSync(metadataPath) || !existsSync(summaryPath)) {
    fail(`${runId} must retain run-metadata.json and runtime-summary.json.`);
  }
  const metadata = readJson(metadataPath, `${runId} metadata`);
  assertPlainObject(metadata, `${runId} metadata`);
  for (const key of [
    "runId",
    "attemptId",
    "startedAt",
    "platform",
    "exactProductMainSha256",
    "testBundleSha256",
  ]) {
    if (!Object.hasOwn(metadata, key)) fail(`${runId} metadata is missing ${key}.`);
  }
  if (metadata.runId !== runId || metadata.platform !== "win32") {
    fail(`${runId} metadata identity/platform mismatch.`);
  }
  assertNonEmptyString(metadata.attemptId, `${runId}.attemptId`, 100);
  assertDateTime(metadata.startedAt, `${runId}.startedAt`);
  assertSha256(metadata.exactProductMainSha256, `${runId}.exactProductMainSha256`);
  assertSha256(metadata.testBundleSha256, `${runId}.testBundleSha256`);
  if (
    status === "PASS" &&
    [metadata.exactProductMainSha256, metadata.testBundleSha256].some((digest) =>
      digest.endsWith("0".repeat(64)),
    )
  ) {
    fail(`${runId} PASS cannot use placeholder product/test bundle hashes.`);
  }
  const summary = readJson(summaryPath, `${runId} runtime summary`);
  assertPlainObject(summary, `${runId} runtime summary`);
  for (const key of SUMMARY_PASS_KEYS) {
    if (typeof summary[key] !== "boolean") fail(`${runId} runtime summary ${key} must be boolean.`);
    if (status === "PASS" && summary[key] !== true) {
      fail(`${runId} PASS requires runtime summary ${key}=true.`);
    }
  }
  return { metadata, summary };
}

function discoverRuns(evidenceDirectory) {
  const resultFiles = listFilesRecursive(evidenceDirectory).filter((relativePath) =>
    relativePath.endsWith("/evidence-result.json"),
  );
  if (resultFiles.length === 0) fail("No evidence-result/v1 JSON files were found.");
  const runMap = new Map();
  for (const relativePath of resultFiles) {
    const match = relativePath.match(
      /^runs\/([^/]+)\/([^/]+)\/([^/]+)\/evidence-result\.json$/u,
    );
    if (match === null) {
      fail(`Evidence result must use runs/<run-id>/<profile>/<case>/evidence-result.json: ${relativePath}.`);
    }
    const [, runId, profileId, caseFolder] = match;
    const identity = parseRunIdentity(runId);
    const result = validateResultContract(
      readJson(path.join(evidenceDirectory, ...relativePath.split("/")), relativePath),
      relativePath,
    );
    if (result.caseId !== `${profileId}/${caseFolder}`) {
      fail(`${relativePath} path identity disagrees with caseId ${result.caseId}.`);
    }
    verifyResultArtifacts(result, evidenceDirectory, relativePath);
    const runEntry = runMap.get(runId) ?? {
      runId,
      family: identity.family,
      attempt: identity.attempt,
      results: [],
    };
    if (runEntry.results.some((entry) => entry.result.caseId === result.caseId)) {
      fail(`${runId} duplicates caseId ${result.caseId}.`);
    }
    runEntry.results.push({ relativePath, result });
    runMap.set(runId, runEntry);
  }
  for (const run of runMap.values()) {
    run.status = aggregateStatuses(run.results);
    run.runtime = validateRunMetadata(
      path.join(evidenceDirectory, "runs", run.runId),
      run.runId,
      run.status,
    );
  }
  let currentRuns = [];
  for (const family of RUN_FAMILIES) {
    const attempts = [...runMap.values()]
      .filter((run) => run.family.id === family.id)
      .sort((left, right) => left.attempt - right.attempt);
    if (attempts.length === 0 || attempts[0].attempt !== 1) {
      fail(`${family.id} is missing its immutable first attempt.`);
    }
    for (let index = 0; index < attempts.length; index += 1) {
      if (attempts[index].attempt !== index + 1) fail(`${family.id} rerun sequence is not contiguous.`);
    }
    const requiredByRun = new Map();
    for (const attempt of attempts) {
      const byCase = new Map(attempt.results.map((entry) => [entry.result.caseId, entry]));
      const presentExpectedCount = family.expectedCases.reduce(
        (count, expected) => count + (byCase.has(expected.caseId) ? 1 : 0),
        0,
      );
      if (presentExpectedCount === 0) {
        requiredByRun.set(attempt.runId, {
          entries: [],
          statuses: ["NOT_RUN"],
        });
        continue;
      }
      if (presentExpectedCount !== family.expectedCases.length) {
        fail(`${attempt.runId} contains a partial required case set.`);
      }
      const requiredResults = [];
      for (const expected of family.expectedCases) {
        const resultEntry = byCase.get(expected.caseId);
        if (resultEntry === undefined) {
          fail(`${attempt.runId} is missing required case ${expected.caseId}.`);
        }
        validateExpectedResult(resultEntry, expected, `${attempt.runId}/${expected.caseId}`);
        requiredResults.push(resultEntry);
      }
      requiredByRun.set(attempt.runId, {
        entries: requiredResults,
        statuses: requiredResults.map((entry) => entry.result.status),
      });
    }
    const current = selectLatestApplicableP3dAttemptV1(
      attempts,
      (attempt) => requiredByRun.get(attempt.runId).statuses,
    );
    const requiredResults = requiredByRun.get(current.runId).entries;
    if (requiredResults.length === 0) {
      fail(`${family.id} has no applicable required attempt.`);
    }
    current.status = aggregateStatuses(requiredResults);
    current.runtime = validateRunMetadata(
      path.join(evidenceDirectory, "runs", current.runId),
      current.runId,
      current.status,
    );
    currentRuns.push(current);
  }
  const productHashes = new Set(
    currentRuns.map((run) => run.runtime.metadata.exactProductMainSha256),
  );
  const testBundleHashes = new Set(
    currentRuns.map((run) => run.runtime.metadata.testBundleSha256),
  );
  if (productHashes.size !== 1) {
    fail("Selected P3-D profile evidence does not share one product/test build hash cohort.");
  }
  let compatibilityReceipt = null;
  if (testBundleHashes.size !== 1) {
    const compatibility = validateApprovedCompatibilityReceipt(evidenceDirectory, runMap);
    currentRuns = [...compatibility.selectedRuns];
    compatibilityReceipt = compatibility.receipt;
  }
  return { currentRuns, runMap, compatibilityReceipt };
}

function verifyPackageDiscipline(entry) {
  for (const relativePath of [
    "package-lock.json",
    "packages/schematic-workbench/fixtures/approved-synthetic-fixtures.manifest.json",
  ]) {
    const baseline = entry.baseline.get(relativePath);
    if (baseline === undefined) fail(`Baseline is missing ${relativePath}.`);
    const bytes = readFileSync(path.join(projectRoot, ...relativePath.split("/")));
    if (bytes.length !== baseline.length || sha256(bytes) !== baseline.sha256) {
      fail(`${relativePath} changed during P3-D.`);
    }
  }
  const beforePackage = readJson(path.join(entry.baselineTree, "package.json"));
  const afterPackage = readJson(path.join(projectRoot, "package.json"));
  delete beforePackage.scripts;
  delete afterPackage.scripts;
  if (!isDeepStrictEqual(beforePackage, afterPackage)) {
    fail("package.json changed outside its approved scripts-only surface.");
  }
  return {
    packageJsonSha256: sha256(readFileSync(path.join(projectRoot, "package.json"))),
    packageLockSha256: sha256(readFileSync(path.join(projectRoot, "package-lock.json"))),
    approvedFixtureManifestSha256: sha256(
      readFileSync(
        path.join(
          projectRoot,
          "packages",
          "schematic-workbench",
          "fixtures",
          "approved-synthetic-fixtures.manifest.json",
        ),
      ),
    ),
  };
}

function getCurrentSourcePaths() {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) fail(result.stderr || "git ls-files failed.");
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((relativePath) => normalizeRelativePath(toPosix(relativePath), "source path"))
    .sort(compareText);
}

function rewriteReversePatchHeaders(diffText) {
  return diffText
    .split("\n")
    .map((line) => {
      if (
        !line.startsWith("diff --git ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ ")
      ) {
        return line;
      }
      return line
        .replaceAll("a/current-tree/", "a/")
        .replaceAll("b/current-tree/", "b/")
        .replaceAll("a/baseline-tree/", "a/")
        .replaceAll("b/baseline-tree/", "b/");
    })
    .join("\n");
}

function treesMatch(leftTree, rightTree) {
  const leftPaths = listFilesRecursive(leftTree);
  const rightPaths = listFilesRecursive(rightTree);
  if (!isDeepStrictEqual(leftPaths, rightPaths)) return false;
  return leftPaths.every((relativePath) => {
    const left = readFileSync(path.join(leftTree, ...relativePath.split("/")));
    const right = readFileSync(path.join(rightTree, ...relativePath.split("/")));
    return left.length === right.length && sha256(left) === sha256(right);
  });
}

function createSourceEvidence(entry, evidenceDirectory) {
  const currentPaths = getCurrentSourcePaths();
  const current = new Map();
  for (const relativePath of currentPaths) {
    const bytes = readFileSync(path.join(projectRoot, ...relativePath.split("/")));
    current.set(relativePath, {
      path: relativePath,
      length: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const allowed = (relativePath) =>
    entry.planned.exactPaths.includes(relativePath) ||
    entry.planned.allowedPrefixes.some((prefix) => relativePath.startsWith(prefix));
  const forbidden = (relativePath) =>
    entry.planned.forbiddenExactPaths.includes(relativePath) ||
    entry.planned.forbiddenPrefixes.some((prefix) => relativePath.startsWith(prefix));
  const changedEntries = [];
  const violations = [];
  const allPaths = [...new Set([...entry.baseline.keys(), ...current.keys()])].sort(compareText);
  for (const relativePath of allPaths) {
    const pre = entry.baseline.get(relativePath) ?? null;
    const post = current.get(relativePath) ?? null;
    if (
      pre !== null &&
      post !== null &&
      pre.length === post.length &&
      pre.sha256 === post.sha256
    ) continue;
    changedEntries.push({
      path: relativePath,
      status: pre === null ? "created" : post === null ? "deleted" : "modified",
      pre: pre === null ? null : { length: pre.length, sha256: pre.sha256 },
      post: post === null ? null : { length: post.length, sha256: post.sha256 },
    });
    if (!allowed(relativePath) || forbidden(relativePath)) violations.push(relativePath);
  }
  const changedManifest = {
    schemaVersion: "aaw.quality.changed-files-manifest/v1",
    gateId: GATE_ID,
    stage: "P3-D",
    createdAt: new Date().toISOString(),
    baselineManifestSha256: sha256(readFileSync(entry.baselineManifestPath)),
    plannedChangePathsSha256: sha256(readFileSync(entry.plannedPath)),
    entryCount: changedEntries.length,
    pathScopeValid: violations.length === 0,
    violations,
    entries: changedEntries,
  };
  const changedManifestPath = path.join(evidenceDirectory, "changed-files-manifest.json");
  writeJson(changedManifestPath, changedManifest);
  const workDirectory = path.join(evidenceDirectory, ".work");
  assertInside(evidenceDirectory, workDirectory, "evidence work directory");
  rmSync(workDirectory, { recursive: true, force: true });
  const currentTree = path.join(workDirectory, "current-tree");
  const baselineTree = path.join(workDirectory, "baseline-tree");
  mkdirSync(currentTree, { recursive: true });
  mkdirSync(baselineTree, { recursive: true });
  for (const baselineEntry of entry.baseline.values()) {
    const destination = path.join(baselineTree, ...baselineEntry.path.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(entry.baselineTree, ...baselineEntry.path.split("/")), destination);
  }
  for (const relativePath of currentPaths) {
    const destination = path.join(currentTree, ...relativePath.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(projectRoot, ...relativePath.split("/")), destination);
  }
  const binaryAttributesPath = path.join(workDirectory, "reverse-patch.attributes");
  // The entry backup is byte-exact. Force the no-index diff to treat every
  // governed path as binary so Windows CRLF conversion cannot produce a patch
  // that applies cleanly yet fails to restore the baseline bytes.
  writeText(binaryAttributesPath, "* -text\n");
  const gitBinaryConfig = ["-c", `core.attributesfile=${binaryAttributesPath}`];
  const diff = spawnSync(
    "git",
    [
      ...gitBinaryConfig,
      "diff",
      "--no-index",
      "--binary",
      "--no-renames",
      "current-tree",
      "baseline-tree",
    ],
    { cwd: workDirectory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (diff.status !== 0 && diff.status !== 1) fail(diff.stderr || "Reverse diff failed.");
  const reversePatchPath = path.join(evidenceDirectory, "reverse.patch");
  writeText(reversePatchPath, rewriteReversePatchHeaders(diff.stdout));
  const isolatedGitEnvironment = {
    ...process.env,
    // current-tree is nested below the shared repository. Stop discovery at
    // the evidence work root so `git apply` cannot silently delegate to the
    // parent repository and skip every patch path as outside its cwd prefix.
    GIT_CEILING_DIRECTORIES: workDirectory,
  };
  const applyCheck = spawnSync(
    "git",
    [...gitBinaryConfig, "apply", "--check", "--binary", reversePatchPath],
    {
      // Check the immutable post-image copied above. The shared root may move
      // while independent P3-D owners finish their approved files.
      cwd: currentTree,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: isolatedGitEnvironment,
    },
  );
  const numstat = spawnSync(
    "git",
    [...gitBinaryConfig, "apply", "--numstat", "--binary", reversePatchPath],
    {
      cwd: currentTree,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: isolatedGitEnvironment,
    },
  );
  const numstatEntries = (numstat.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  const applyTree = path.join(workDirectory, "apply-tree");
  rmSync(applyTree, { recursive: true, force: true });
  cpSync(currentTree, applyTree, { recursive: true });
  const apply = spawnSync(
    "git",
    [...gitBinaryConfig, "apply", "--binary", reversePatchPath],
    {
      cwd: applyTree,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: isolatedGitEnvironment,
    },
  );
  const transformedToBaseline = apply.status === 0 && treesMatch(applyTree, baselineTree);
  const applyCheckExitCode =
    applyCheck.status === 0 &&
    numstat.status === 0 &&
    changedEntries.length > 0 &&
    numstatEntries.length === changedEntries.length &&
    transformedToBaseline
      ? 0
      : 1;
  writeText(
    path.join(evidenceDirectory, "reverse-apply-check.raw.log"),
    [
      `checkExit=${applyCheck.status ?? -1}`,
      `${applyCheck.stdout ?? ""}${applyCheck.stderr ?? ""}`,
      `numstatExit=${numstat.status ?? -1}`,
      numstat.stdout ?? "",
      numstat.stderr ?? "",
      `expectedChangedEntries=${changedEntries.length}`,
      `observedNumstatEntries=${numstatEntries.length}`,
      `applyExit=${apply.status ?? -1}`,
      `${apply.stdout ?? ""}${apply.stderr ?? ""}`,
      `transformedToBaseline=${transformedToBaseline}`,
    ].join("\n"),
  );
  writeText(
    path.join(evidenceDirectory, "reverse-apply-check.exit-code.txt"),
    `${applyCheckExitCode}\n`,
  );
  return {
    applyCheckExitCode,
    changedManifest,
    changedManifestPath,
    reversePatchPath,
  };
}

function calculateOverallStatus(metadata, discovered, sourceEvidence) {
  if (
    metadata.commands.some((command) => command.exitCode !== 0) ||
    metadata.tests.failed > 0 ||
    discovered.currentRuns.some((run) => run.status === "FAIL") ||
    sourceEvidence.changedManifest.violations.length > 0 ||
    sourceEvidence.applyCheckExitCode !== 0
  ) return "FAIL";
  const approvalsReady = ["qa", "gui", "security"].every(
    (owner) =>
      typeof metadata.approvals[owner] === "string" &&
      /=PASS$/u.test(metadata.approvals[owner]),
  );
  if (!approvalsReady || discovered.currentRuns.some((run) => run.status !== "PASS")) {
    return "BLOCKED";
  }
  for (const requiredCommand of REQUIRED_COMMANDS) {
    if (!metadata.commands.some((command) => command.name === requiredCommand)) {
      fail(`PASS evidence is missing required command ${requiredCommand}.`);
    }
  }
  if (metadata.tests.total === 0) fail("PASS evidence must include current tests.");
  return "PASS";
}

function boundedIssue(text) {
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

function createKnownIssues(metadata, discovered) {
  const issues = [];
  for (const run of discovered.currentRuns) {
    if (run.status !== "PASS") {
      const blocker = run.results.find((entry) => entry.result.blocker !== null)?.result.blocker;
      issues.push(
        boundedIssue(
          `${run.family.id}=${run.status}; reason=${blocker?.reason ?? "required current evidence is incomplete"}; owner=${blocker?.owner ?? "GUI/QA"}; exitCondition=${blocker?.exitCondition ?? "named current run PASS"}`,
        ),
      );
    }
  }
  for (const capability of metadata.capabilities) {
    issues.push(
      boundedIssue(
        `${capability.name}=NOT_AVAILABLE; reason=${capability.reason}; owner=${capability.owner}; exitCondition=${capability.exitCondition}`,
      ),
    );
  }
  for (const owner of ["qa", "gui", "security"]) {
    if (metadata.approvals[owner] === null || !/=PASS$/u.test(metadata.approvals[owner])) {
      issues.push(`${owner} approval pending; owner=${owner}; exitCondition=P3-D differential review PASS.`);
    }
  }
  return issues;
}

function createReportAndBundle({
  metadata,
  metadataPath,
  discovered,
  entry,
  pins,
  sourceEvidence,
  evidenceDirectory,
}) {
  const status = calculateOverallStatus(metadata, discovered, sourceEvidence);
  const reportExcluded = new Set([
    "bundle-manifest.json",
    "gate-report.json",
    "gate-schema-validation.exit-code.txt",
    "gate-schema-validation.raw.log",
    "gate-summary.md",
  ]);
  const reportArtifacts = listFilesRecursive(evidenceDirectory)
    .filter((relativePath) => !reportExcluded.has(relativePath))
    .map((relativePath) => artifactRecord(evidenceDirectory, relativePath));
  const report = {
    schemaVersion: "aaw.quality-gate-report/v1alpha1",
    gateId: "phase3-p3d-exit",
    phase: "phase3",
    status,
    source: {
      baselineManifestSha256: `sha256:${sha256(readFileSync(entry.baselineManifestPath))}`,
      changedFilesManifestSha256: `sha256:${sha256(readFileSync(sourceEvidence.changedManifestPath))}`,
      reversePatchSha256: `sha256:${sha256(readFileSync(sourceEvidence.reversePatchPath))}`,
    },
    environment: {
      ...metadata.environment,
      packageLockSha256: `sha256:${pins.packageLockSha256}`,
    },
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    commands: metadata.commands.map(({ name, exitCode }) => ({ name, exitCode })),
    tests: metadata.tests,
    artifacts: reportArtifacts.map(({ relativePath, sha256: digest }) => ({
      relativePath,
      sha256: digest,
    })),
    knownIssues: createKnownIssues(metadata, discovered),
    waivers: [],
    approvals: {
      product: metadata.approvals.product,
      ...(metadata.approvals.qa === null ? {} : { qa: metadata.approvals.qa }),
    },
  };
  const reportPath = path.join(evidenceDirectory, "gate-report.json");
  writeJson(reportPath, report);
  const schema = readJson(
    path.join(projectRoot, "tests", "contracts", "quality-gate-report.schema.json"),
  );
  const ajv = new Ajv2020({ strict: true, formats: { "date-time": true } });
  const validate = ajv.compile(schema);
  const schemaOk = validate(report);
  writeJson(path.join(evidenceDirectory, "gate-schema-validation.raw.log"), {
    ok: schemaOk,
    errors: validate.errors ?? null,
  });
  writeText(
    path.join(evidenceDirectory, "gate-schema-validation.exit-code.txt"),
    `${schemaOk ? 0 : 1}\n`,
  );
  if (!schemaOk) fail(`Gate report schema validation failed: ${JSON.stringify(validate.errors)}.`);
  writeText(
    path.join(evidenceDirectory, "gate-summary.md"),
    [
      "# Phase 3 P3-D Windows Electron exit summary",
      "",
      `Status: ${status}`,
      "",
      ...discovered.currentRuns.map(
        (run) => `- ${run.family.id}: ${run.runId} = ${run.status}`,
      ),
      "",
      `Changed paths: ${sourceEvidence.changedManifest.entryCount}; pathScopeValid=${sourceEvidence.changedManifest.pathScopeValid}; violations=${sourceEvidence.changedManifest.violations.length}.`,
      `Reverse apply-check exit code: ${sourceEvidence.applyCheckExitCode}.`,
      `Package lock: ${pins.packageLockSha256} (unchanged).`,
      `Approved fixture manifest: ${pins.approvedFixtureManifestSha256} (unchanged).`,
      ...(discovered.compatibilityReceipt === null
        ? []
        : [
            `Harness compatibility receipt: ${discovered.compatibilityReceipt.candidatePayloadSha256}; exact ${discovered.compatibilityReceipt.previousHarnessSha256} -> ${discovered.compatibilityReceipt.currentHarnessSha256}; single-pair and non-transitive.`,
          ]),
      "",
      "Real reviewed payload, OA/EDA, Agent and file/writeback capabilities remain NOT_AVAILABLE.",
      "",
    ].join("\n"),
  );
  const artifacts = listFilesRecursive(evidenceDirectory)
    .filter((relativePath) => relativePath !== "bundle-manifest.json")
    .map((relativePath) => artifactRecord(evidenceDirectory, relativePath));
  const bundle = {
    schemaVersion: "aaw.quality-evidence-bundle/v1",
    gateId: "phase3-p3d-exit",
    status,
    createdAt: new Date().toISOString(),
    baselineManifestSha256: `sha256:${sha256(readFileSync(entry.baselineManifestPath))}`,
    plannedChangePathsSha256: `sha256:${sha256(readFileSync(entry.plannedPath))}`,
    parentCheckpointBundleSha256: `sha256:${entry.parentBundleHash}`,
    changedFilesManifestSha256: `sha256:${sha256(readFileSync(sourceEvidence.changedManifestPath))}`,
    reversePatchSha256: `sha256:${sha256(readFileSync(sourceEvidence.reversePatchPath))}`,
    exitMetadataSha256: `sha256:${sha256(readFileSync(metadataPath))}`,
    packageJsonSha256: `sha256:${pins.packageJsonSha256}`,
    packageLockSha256: `sha256:${pins.packageLockSha256}`,
    approvedFixtureManifestSha256: `sha256:${pins.approvedFixtureManifestSha256}`,
    pathScopeValid: sourceEvidence.changedManifest.pathScopeValid,
    reversePatchApplyCheck: sourceEvidence.applyCheckExitCode === 0 ? "PASS" : "FAIL",
    currentRuns: discovered.currentRuns.map((run) => ({
      requirementId: run.family.id,
      runId: run.runId,
      status: run.status,
      resultCount: run.results.length,
    })),
    compatibilityReceipt: discovered.compatibilityReceipt,
    approvals: metadata.approvals,
    artifacts,
  };
  const bundlePath = path.join(evidenceDirectory, "bundle-manifest.json");
  writeJson(bundlePath, bundle);
  for (const artifact of artifacts) {
    const current = artifactRecord(evidenceDirectory, artifact.relativePath);
    if (current.length !== artifact.length || current.sha256 !== artifact.sha256) {
      fail(`Artifact changed during bundle creation: ${artifact.relativePath}.`);
    }
  }
  return { bundlePath, reportPath, status };
}

function finalizeEvidence({ entryDirectory, evidenceDirectory, metadataPath }) {
  assertInside(qualityEvidenceRoot, evidenceDirectory, "evidence directory");
  if (!existsSync(evidenceDirectory) || !statSync(evidenceDirectory).isDirectory()) {
    fail("Evidence directory does not exist.");
  }
  const resolvedMetadataPath = metadataPath ?? path.join(evidenceDirectory, "exit-metadata.json");
  assertInside(evidenceDirectory, resolvedMetadataPath, "exit metadata path");
  const entry = validateEntry(entryDirectory);
  const metadata = readJson(resolvedMetadataPath, "exit metadata");
  validateExitMetadata(metadata, evidenceDirectory);
  const discovered = discoverRuns(evidenceDirectory);
  const pins = verifyPackageDiscipline(entry);
  const sourceEvidence = createSourceEvidence(entry, evidenceDirectory);
  const output = createReportAndBundle({
    metadata,
    metadataPath: resolvedMetadataPath,
    discovered,
    entry,
    pins,
    sourceEvidence,
    evidenceDirectory,
  });
  const result = {
    status: output.status,
    changedFilesManifestSha256: sha256(readFileSync(sourceEvidence.changedManifestPath)),
    reversePatchSha256: sha256(readFileSync(sourceEvidence.reversePatchPath)),
    gateReportSha256: sha256(readFileSync(output.reportPath)),
    bundleManifestSha256: sha256(readFileSync(output.bundlePath)),
    artifactCount: readJson(output.bundlePath).artifacts.length,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function unavailableCapabilities() {
  return REQUIRED_CAPABILITIES.map((name) => ({
    name,
    status: "NOT_AVAILABLE",
    reason: "Outside the authorized synthetic-only P3-D scope.",
    owner: "product",
    exitCondition: "Independent future capability gate and explicit user approval.",
  }));
}

function templateMetadata(evidenceDirectory, createArtifacts) {
  const now = new Date().toISOString();
  const rawLog = "commands/generator-self-test.raw.log";
  const exitCodeFile = "commands/generator-self-test.exit-code.txt";
  if (createArtifacts) {
    writeText(path.join(evidenceDirectory, ...rawLog.split("/")), "No product command or Electron was run.\n");
    writeText(path.join(evidenceDirectory, ...exitCodeFile.split("/")), "0\n");
  }
  const packageJson = readJson(path.join(projectRoot, "package.json"));
  return {
    schemaVersion: EXIT_METADATA_SCHEMA,
    gateId: GATE_ID,
    startedAt: now,
    endedAt: now,
    environment: {
      platform: "win32",
      architecture: process.arch,
      node: packageJson.engines.node,
      npm: packageJson.packageManager.replace(/^npm@/u, ""),
      electron: packageJson.devDependencies.electron,
    },
    commands: [
      {
        name: "generator self-test only; no product command",
        exitCode: 0,
        rawLog,
        exitCodeFile,
      },
    ],
    tests: { total: 0, failed: 0 },
    approvals: {
      product: "P3-D user authorization recorded at entry.",
      qa: null,
      gui: null,
      security: null,
    },
    capabilities: unavailableCapabilities(),
  };
}

function resultOracles(geometryAllowed) {
  return {
    typedResolvePath: false,
    exactRevisionBinding: false,
    persistentBannerVisible: false,
    overlayBannerVisible: false,
    geometryAllowed,
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
  };
}

function createNotRunCase(
  evidenceDirectory,
  runDirectory,
  expected,
  blockerReason,
) {
  const [, caseId] = expected.caseId.split("/");
  const caseDirectory = path.join(runDirectory, expected.profileId, caseId);
  const resultPath = path.join(caseDirectory, "evidence-result.json");
  const rawPath = path.join(caseDirectory, "raw.log");
  if (existsSync(resultPath) || existsSync(rawPath)) {
    fail(`${expected.caseId} already has partial sealed evidence.`);
  }
  const rawRelativePath = toPosix(path.relative(evidenceDirectory, rawPath));
  writeText(rawPath, "Real Electron environment was not run.\n");
  const profile = PROFILE_ENVIRONMENTS[expected.profileId];
  writeJson(resultPath, {
    schemaVersion: RESULT_SCHEMA,
    phase: "work",
    caseId: expected.caseId,
    required: true,
    status: "NOT_RUN",
    environment: {
      platform: "win32",
      physicalWidth: 1366,
      physicalHeight: 768,
      deviceScaleFactor: profile.deviceScaleFactor,
      pageZoom: profile.pageZoom,
      forcedColorsActive: profile.forcedColorsActive,
    },
    oracles: resultOracles(expected.geometryAllowed),
    screenshot: null,
    rawLog: {
      relativePath: rawRelativePath,
      sha256: `sha256:${sha256(readFileSync(rawPath))}`,
    },
    blocker: {
      reason: blockerReason,
      owner: "GUI/QA",
      exitCondition: "Execute the named run with native environment and complete evidence.",
    },
  });
}

function createNotRunAttempt(
  evidenceDirectory,
  family,
  runId,
  attemptId,
  startedAt = new Date().toISOString(),
  blockerReason = "Real Windows Electron environment has not been executed.",
) {
  const runDirectory = path.join(evidenceDirectory, "runs", runId);
    writeJson(path.join(runDirectory, "run-metadata.json"), {
      runId,
      attemptId,
      startedAt,
      platform: "win32",
      exactProductMainSha256: `sha256:${"0".repeat(64)}`,
      testBundleSha256: `sha256:${"0".repeat(64)}`,
    });
    writeJson(path.join(runDirectory, "runtime-summary.json"), {
      realElectron: false,
      nativeEnvironment: false,
      domOraclePassed: false,
      stateOraclePassed: false,
      securityOraclePassed: false,
      processOraclePassed: false,
      noOrphans: false,
    });
    for (const expected of family.expectedCases) {
      createNotRunCase(evidenceDirectory, runDirectory, expected, blockerReason);
    }
}

function sealEmptyFirstAttempts(evidenceDirectory) {
  assertInside(qualityEvidenceRoot, evidenceDirectory, "evidence directory");
  for (const family of RUN_FAMILIES) {
    const runId = `${family.prefix}-01`;
    const runDirectory = path.join(evidenceDirectory, "runs", runId);
    if (!existsSync(runDirectory)) fail(`${runId} first-attempt directory is missing.`);
    if (readdirSync(runDirectory).length !== 0) {
      fail(`${runId} is not empty and cannot be sealed as a pre-execution attempt.`);
    }
    const directoryStat = lstatSync(runDirectory);
    const startedAt = Number.isFinite(directoryStat.birthtimeMs)
      ? directoryStat.birthtime.toISOString()
      : directoryStat.mtime.toISOString();
    createNotRunAttempt(
      evidenceDirectory,
      family,
      runId,
      "01",
      startedAt,
      "The immutable first orchestration attempt stopped before Electron case execution; the empty first-attempt directory is preserved and sealed as NOT_RUN.",
    );
  }
  console.log("P3D_EMPTY_FIRST_ATTEMPTS_SEALED=7");
}

function sealEmptyAttempts(evidenceDirectory) {
  assertInside(qualityEvidenceRoot, evidenceDirectory, "evidence directory");
  const runsDirectory = path.join(evidenceDirectory, "runs");
  let sealed = 0;
  for (const runId of readdirSync(runsDirectory).sort(compareText)) {
    const runDirectory = path.join(runsDirectory, runId);
    if (!lstatSync(runDirectory).isDirectory()) continue;
    const existingFiles = listFilesRecursive(runDirectory);
    const existingResultFiles = existingFiles.filter((entry) =>
      entry.endsWith("/evidence-result.json")
    );
    if (existingResultFiles.length > 0) {
      const identity = parseRunIdentity(runId);
      const expectedByCaseId = new Map(
        identity.family.expectedCases.map((expected) => [expected.caseId, expected]),
      );
      const presentCaseIds = new Set();
      let hasExecutedEvidence = false;
      for (const relativeResultPath of existingResultFiles) {
        const result = validateResultContract(
          readJson(path.join(runDirectory, ...relativeResultPath.split("/"))),
          `${runId}/${relativeResultPath}`,
        );
        if (result.status !== "NOT_RUN") hasExecutedEvidence = true;
        if (expectedByCaseId.has(result.caseId)) presentCaseIds.add(result.caseId);
      }
      if (presentCaseIds.size === identity.family.expectedCases.length) continue;
      const { metadata, summary } = validateRunMetadata(runDirectory, runId, "NOT_RUN");
      const placeholderHashes = [
        metadata.exactProductMainSha256,
        metadata.testBundleSha256,
      ].every((digest) => digest === `sha256:${"0".repeat(64)}`);
      const preExecutionSummary = SUMMARY_PASS_KEYS.every((key) => summary[key] === false);
      if (!hasExecutedEvidence && (!placeholderHashes || !preExecutionSummary)) {
        fail(`${runId} partial evidence is not a sealed pre-execution NOT_RUN attempt.`);
      }
      const blockerReason = hasExecutedEvidence
        ? "This preserved attempt predates the expanded required case set; this case was not executed and is sealed as NOT_RUN."
        : "This preserved pre-execution NOT_RUN attempt was sealed against the expanded required case set; no Electron case was executed.";
      for (const expected of identity.family.expectedCases) {
        if (presentCaseIds.has(expected.caseId)) continue;
        createNotRunCase(
          evidenceDirectory,
          runDirectory,
          expected,
          blockerReason,
        );
      }
      sealed += 1;
      continue;
    }
    if (
      existsSync(path.join(runDirectory, "run-metadata.json")) ||
      existsSync(path.join(runDirectory, "runtime-summary.json"))
    ) fail(`${runId} has partial run metadata and cannot be sealed automatically.`);
    const identity = parseRunIdentity(runId);
    const directoryStat = lstatSync(runDirectory);
    const startedAt = Number.isFinite(directoryStat.birthtimeMs)
      ? directoryStat.birthtime.toISOString()
      : directoryStat.mtime.toISOString();
    const attemptId = identity.attempt === 1
      ? "01"
      : `RERUN-${String(identity.attempt - 1).padStart(2, "0")}`;
    createNotRunAttempt(
      evidenceDirectory,
      identity.family,
      runId,
      attemptId,
      startedAt,
      "This preserved orchestration attempt stopped before Electron case execution; its empty run directory is sealed as NOT_RUN rather than omitted.",
    );
    sealed += 1;
  }
  console.log(`P3D_EMPTY_ATTEMPTS_SEALED=${sealed}`);
}

function createNotRunEvidence(evidenceDirectory) {
  for (const family of RUN_FAMILIES) {
    createNotRunAttempt(evidenceDirectory, family, `${family.prefix}-01`, "01");
  }
}

function initializeTemplate() {
  const directory = path.join(qualityEvidenceRoot, "20260901-phase3-p3d-template");
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "exit-metadata.template.json"), templateMetadata(directory, false));
  writeText(
    path.join(directory, "README.md"),
    [
      "# P3-D evidence finalization input",
      "",
      "Copy exit-metadata.template.json to the ignored P3-D exit directory as exit-metadata.json and replace the self-test command with current raw-log/exit-code artifacts.",
      "Electron evidence is discovered recursively at runs/<run-id>/<profile-id>/<case-id>/evidence-result.json. The exact seven run families use -01 for the first attempt and -RERUN-NN for preserved named reruns.",
      "Every result must conform to aaw.phase3-p3d.evidence-result/v1; raw-log and screenshot hashes are independently checked. PASS also requires current static commands/tests, current terminal PASS attempts, native environment summaries, owner approvals, scoped source changes and a reverse patch apply-check.",
      "",
    ].join("\n"),
  );
  console.log(directory);
}

function selfTest() {
  const directory = path.join(
    qualityEvidenceRoot,
    "20260901-phase3-p3d-generator-selftest",
  );
  assertInside(qualityEvidenceRoot, directory, "self-test directory");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  createNotRunEvidence(directory);
  const rerunFamily = RUN_FAMILIES.find((family) => family.id === "dev-125");
  createNotRunAttempt(
    directory,
    rerunFamily,
    `${rerunFamily.prefix}-RERUN-01`,
    "RERUN-01",
  );
  const metadataPath = path.join(directory, "exit-metadata.json");
  writeJson(metadataPath, templateMetadata(directory, true));
  const result = finalizeEvidence({
    entryDirectory: defaultEntryDirectory,
    evidenceDirectory: directory,
    metadataPath,
  });
  if (result.status !== "BLOCKED") {
    fail(`Self-test required NOT_RUN matrix must be BLOCKED, received ${result.status}.`);
  }
  const bundle = readJson(path.join(directory, "bundle-manifest.json"));
  if (
    bundle.status !== "BLOCKED" ||
    bundle.currentRuns.length !== RUN_FAMILIES.length ||
    bundle.currentRuns.find((run) => run.requirementId === "dev-125")?.runId !==
      "P3D-WIN-DEV-125-RERUN-01" ||
    bundle.artifacts.length !== result.artifactCount
  ) fail("Self-test bundle binding failed.");
  console.log("P3D_EVIDENCE_GENERATOR_SELF_TEST=PASS");
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.initTemplate) initializeTemplate();
  else if (options.selfTest) selfTest();
  else if (options.sealEmptyFirstAttempts) {
    sealEmptyFirstAttempts(options.evidenceDirectory);
  }
  else if (options.sealEmptyAttempts) sealEmptyAttempts(options.evidenceDirectory);
  else {
    const result = finalizeEvidence(options);
    process.exitCode = result.status === "PASS" ? 0 : result.status === "BLOCKED" ? 2 : 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
