import assert from "node:assert/strict";
import test from "node:test";
import { assertP4dExitCompleteV1, P4dEvidenceContractError, validateP4dEvidenceResultV1 } from "../tools/phase4-p4d-evidence-contract";

const pass = Object.freeze({
  schemaVersion: "aaw.phase4.p4d.evidence-result/v1", kind: "visual", caseId: "profile/case", required: true, status: "PASS",
  environment: { platform: "win32", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1.25, pageZoom: 1 },
  oracles: {
    apiExactSeven: true, ariaContract: true, artifactDigestUnchanged: true, contextIsolation: true, cspClosed: true,
    expectedStateVisible: true, focusVisible: true, keyboardReachable: true, noHorizontalOverflow: true,
    noModelToolsLabelVisible: true, noOrphans: true, nodeIntegrationDisabled: true, postActionPassed: true,
    realElectron: true, sandbox: true, syntheticLabelVisible: true, webviewDisabled: true, zeroPostRevokeDelivery: true,
    externalNetworkCount: 0, fileMutationCount: 0, nativeSaveHelperCallCount: 0, oaEdaMutationCount: 0,
    postRevokeDeliveryCount: 0, processSpawnCount: 0, registryMutationCount: 0,
  },
  screenshot: { relativePath: "screenshots/example.png", width: 1366, height: 768, sha256: `sha256:${"a".repeat(64)}` },
  rawLog: { relativePath: "runs/example/raw.log", sha256: `sha256:${"b".repeat(64)}` }, blocker: null,
});

test("P4-D evidence accepts only a complete zero-side-effect PASS", () => {
  assert.equal(validateP4dEvidenceResultV1(pass), pass);
  assert.throws(() => validateP4dEvidenceResultV1({ ...pass, screenshot: null }), (error: unknown) => error instanceof P4dEvidenceContractError && error.code === "INCOMPLETE_PASS");
  assert.throws(() => validateP4dEvidenceResultV1({ ...pass, oracles: { ...pass.oracles, externalNetworkCount: 1 } }), (error: unknown) => error instanceof P4dEvidenceContractError && error.code === "SIDE_EFFECT_DETECTED");
});

test("P4-D exit rejects any required NOT_RUN", () => {
  const rows = Array.from({ length: 16 }, (_, index) => index === 0 ? { ...pass, status: "NOT_RUN", blocker: { reason: "not run", owner: "QA", exitCondition: "rerun" } } : { ...pass, caseId: `case-${index}` });
  assert.throws(() => assertP4dExitCompleteV1(rows), (error: unknown) => error instanceof P4dEvidenceContractError && error.code === "REQUIRED_NOT_RUN");
});
