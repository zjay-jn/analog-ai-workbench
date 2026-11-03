import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  P3D_EVIDENCE_RESULT_SCHEMA_V1,
  P3D_EVIDENCE_STATUSES_V1,
  P3dEvidenceContractError,
  selectLatestApplicableP3dAttemptV1,
  validateP3dEvidenceResultV1,
} from "../tools/phase3-p3d-evidence-contract";

const sha256A = `sha256:${"a".repeat(64)}`;
const sha256B = `sha256:${"b".repeat(64)}`;

const passingResult = Object.freeze({
  schemaVersion: "aaw.phase3-p3d.evidence-result/v1",
  phase: "exit",
  caseId: "windows-1366x768-dsf-100/two-tabs-ready-current",
  required: true,
  status: "PASS",
  environment: Object.freeze({
    platform: "win32",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 1,
    forcedColorsActive: false,
  }),
  oracles: Object.freeze({
    typedResolvePath: true,
    exactRevisionBinding: true,
    persistentBannerVisible: true,
    overlayBannerVisible: false,
    geometryAllowed: true,
    noHorizontalOverflow: true,
    focusContract: true,
    ariaContract: true,
    artifactDigestUnchanged: true,
    registryMutationCount: 0,
    productDocumentFileMutationCount: 0,
    nativeSaveHelperCallCount: 0,
    oaEdaMutationCount: 0,
    externalNetworkRequestCount: 0,
    processSpawnCount: 0,
  }),
  screenshot: Object.freeze({
    relativePath: "screenshots/windows-1366x768-dsf-100--two-tabs-ready-current.png",
    width: 1366,
    height: 768,
    sha256: sha256A,
  }),
  rawLog: Object.freeze({
    relativePath: "raw/windows-1366x768-dsf-100--two-tabs-ready-current.log",
    sha256: sha256B,
  }),
  blocker: null,
});

test("P3-D evidence result schema has one closed status vocabulary and exact required fields", () => {
  assert.deepEqual(P3D_EVIDENCE_STATUSES_V1, [
    "PASS",
    "FAIL",
    "BLOCKED",
    "NOT_RUN",
  ]);
  assert.deepEqual(P3D_EVIDENCE_RESULT_SCHEMA_V1, {
    schemaVersion: "aaw.phase3-p3d.evidence-result/v1",
    requiredKeys: [
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
    ],
    environmentKeys: [
      "platform",
      "physicalWidth",
      "physicalHeight",
      "deviceScaleFactor",
      "pageZoom",
      "forcedColorsActive",
    ],
    blockerKeys: ["reason", "owner", "exitCondition"],
    forbiddenStatusTokens: ["SKIP", "N/A", "NOT_AVAILABLE"],
    additionalProperties: false,
  });
  assert.deepEqual(validateP3dEvidenceResultV1(passingResult), passingResult);
});

test("P3-D NOT_RUN is temporary, fully owned, and forbidden for a required exit case", () => {
  const ownedNotRun = {
    ...passingResult,
    phase: "work",
    status: "NOT_RUN",
    screenshot: null,
    blocker: {
      reason: "The main-owned historical typed-delivery seam is not implemented.",
      owner: "schematic-owner",
      exitCondition: "An exact historical revision resolves through P3-C and passes the renderer host.",
    },
  };
  assert.equal(validateP3dEvidenceResultV1(ownedNotRun).status, "NOT_RUN");

  for (const candidate of [
    { ...ownedNotRun, blocker: null },
    { ...ownedNotRun, blocker: { ...ownedNotRun.blocker, owner: "" } },
    { ...ownedNotRun, phase: "exit" },
  ]) {
    assert.throws(
      () => validateP3dEvidenceResultV1(candidate),
      (error: unknown) => {
        assert.ok(error instanceof P3dEvidenceContractError);
        assert.ok(
          error.code === "NOT_RUN_REQUIRES_BLOCKER" ||
            error.code === "REQUIRED_CASE_NOT_RUN_AT_EXIT",
        );
        return true;
      },
    );
  }
});

test("P3-D evidence rejects aliases, non-Windows execution and incomplete PASS claims", () => {
  const invalidResults: ReadonlyArray<readonly [string, unknown, string]> = [
    ["status alias", { ...passingResult, status: "N/A" }, "INVALID_STATUS"],
    [
      "non-Windows run",
      {
        ...passingResult,
        environment: { ...passingResult.environment, platform: "linux" },
      },
      "INVALID_ENVIRONMENT",
    ],
    [
      "wrong screenshot size",
      {
        ...passingResult,
        screenshot: { ...passingResult.screenshot, width: 1365 },
      },
      "INVALID_SCREENSHOT",
    ],
    [
      "missing raw log",
      { ...passingResult, rawLog: null },
      "INCOMPLETE_PASS_EVIDENCE",
    ],
    [
      "side effect",
      {
        ...passingResult,
        oracles: { ...passingResult.oracles, externalNetworkRequestCount: 1 },
      },
      "SIDE_EFFECT_DETECTED",
    ],
  ];

  for (const [label, candidate, expectedCode] of invalidResults) {
    assert.throws(
      () => validateP3dEvidenceResultV1(candidate),
      (error: unknown) => {
        assert.ok(error instanceof P3dEvidenceContractError);
        assert.equal(error.code, expectedCode);
        return true;
      },
      label,
    );
  }
});

test("P3-D attempt selection ignores later environment-mismatch placeholders but not a real failure", () => {
  const passAttempt = Object.freeze({
    runId: "P3D-WIN-DEV-125-RERUN-30",
    statuses: Object.freeze(["PASS"] as const),
  });
  const mismatchedEnvironment = Object.freeze({
    runId: "P3D-WIN-DEV-125-RERUN-31",
    statuses: Object.freeze(["NOT_RUN"] as const),
  });
  const laterFailure = Object.freeze({
    runId: "P3D-WIN-DEV-125-RERUN-32",
    statuses: Object.freeze(["FAIL"] as const),
  });

  assert.equal(
    selectLatestApplicableP3dAttemptV1(
      [passAttempt, mismatchedEnvironment],
      (attempt) => attempt.statuses,
    ),
    passAttempt,
  );
  assert.equal(
    selectLatestApplicableP3dAttemptV1(
      [passAttempt, mismatchedEnvironment, laterFailure],
      (attempt) => attempt.statuses,
    ),
    laterFailure,
  );
});

test("P3-D window-close lifecycle PASS may use a bound external absence log instead of a screenshot", () => {
  const lifecycleResult = {
    ...passingResult,
    caseId: "windows-lifecycle/window-close",
    screenshot: null,
    oracles: {
      ...passingResult.oracles,
      persistentBannerVisible: false,
      noHorizontalOverflow: false,
      focusContract: false,
      ariaContract: false,
    },
  };
  assert.equal(validateP3dEvidenceResultV1(lifecycleResult), lifecycleResult);
});

test("P3-D reverse patch rewrites headers only and proves a non-no-op isolated restore", () => {
  const source = readFileSync("tools/phase3-p3d-evidence.mjs", "utf8");
  assert.match(source, /function rewriteReversePatchHeaders\(diffText\)/u);
  assert.match(source, /GIT_CEILING_DIRECTORIES: workDirectory/u);
  assert.match(source, /"\* -text\\n"/u);
  assert.match(
    source,
    /\[\.\.\.gitBinaryConfig, "apply", "--numstat", "--binary", reversePatchPath\]/u,
  );
  assert.match(source, /numstatEntries\.length === changedEntries\.length/u);
  assert.match(source, /transformedToBaseline = apply\.status === 0 && treesMatch/u);
  assert.doesNotMatch(
    source,
    /diff\.stdout\s*\.replaceAll\("a\/current-tree\/"/u,
  );
});

test("P3-D cross-harness evidence requires the one approved non-transitive receipt", () => {
  const source = readFileSync("tools/phase3-p3d-evidence.mjs", "utf8");

  assert.match(
    source,
    /APPROVED_COMPATIBILITY_PAYLOAD_SHA256\s*=\s*\n\s*"sha256:d8db0837baa3715f426d6ee6d1dbd9794ac560664f87742eb8f66f2d7aa011e8"/u,
  );
  assert.match(
    source,
    /APPROVED_PREVIOUS_HARNESS_SHA256\s*=\s*\n\s*"sha256:dba156bf201e91cb7ef3d17ea0dd951513bcbbebcecdf7328539cfdb7917d21b"/u,
  );
  assert.match(
    source,
    /APPROVED_CURRENT_HARNESS_SHA256\s*=\s*\n\s*"sha256:ab4b5a5668ad18e65bb7abae06b4cd21ad742853eca58426de9dcc85e541ea3b"/u,
  );
  assert.match(source, /function validateApprovedCompatibilityReceipt\(/u);
  assert.match(source, /singlePairOnly !== true/u);
  assert.match(source, /nonTransitive !== true/u);
  assert.match(source, /noGeneralCrossCohortWaiver !== true/u);
  assert.match(source, /noFutureCohortReuse !== true/u);
  assert.match(
    source,
    /compatibility machine-checked delta is not fail-closed/iu,
  );
  assert.match(
    source,
    /testBundleHashes\.size !== 1[\s\S]*validateApprovedCompatibilityReceipt\(evidenceDirectory, runMap\)[\s\S]*currentRuns = \[\.\.\.compatibility\.selectedRuns\]/u,
  );
  assert.doesNotMatch(source, /noGeneralCrossCohortWaiver\s*!==\s*false/u);
});
