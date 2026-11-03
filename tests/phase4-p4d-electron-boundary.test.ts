import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { P4D_AGENT_CASES_V1, P4D_LIFECYCLE_CASES_V1, P4D_VISUAL_PROFILES_V1 } from "../tools/phase4-p4d-matrix-contract";

test("P4D_ELECTRON_BOUNDARY_UNAVAILABLE", async () => {
  assert.doesNotThrow(() => readFileSync("tools/phase4-p4d-electron-matrix.mjs", "utf8"));
});

test("P4-D freezes three app-local Windows scale profiles and three Agent visual states", () => {
  assert.deepEqual(P4D_VISUAL_PROFILES_V1, [
    { profileId: "windows-1366x768-dsf-125", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1.25, pageZoom: 1 },
    { profileId: "windows-1366x768-dsf-150", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1.5, pageZoom: 1 },
    { profileId: "windows-1366x768-page-zoom-200", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1, pageZoom: 2 },
  ]);
  assert.deepEqual(P4D_AGENT_CASES_V1.map((entry) => entry.caseId), [
    "running-stream-cancel",
    "replay-recovery",
    "citation-historical-unavailable",
  ]);
});

test("P4-D freezes revocation races and keeps its test main unreachable from production", () => {
  assert.deepEqual(P4D_LIFECYCLE_CASES_V1.map((entry) => entry.caseId), [
    "navigation",
    "reload",
    "workspace-switch",
    "revision-revoke",
    "quarantine",
    "window-close",
  ]);
  const runner = readFileSync("tools/phase4-p4d-electron-matrix.mjs", "utf8");
  const boundaryAudit = readFileSync("tools/phase4-p4d-production-boundary.mjs", "utf8");
  const productionMain = readFileSync("apps/desktop/src/main/index.ts", "utf8");
  assert.match(runner, /phase4-p4d-test-main/u);
  assert.match(runner, /cpSync\(resolve\(repositoryRoot, "dist\/preload"\)/u);
  assert.match(boundaryAudit, /preloadSingleFile/u);
  assert.match(boundaryAudit, /preloadLocalRequires/u);
  assert.doesNotMatch(productionMain, /phase4-p4d|AAW_P4D/u);
});
