import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  P4D_AGENT_CASES_V1, P4D_BUILD_BOUNDARY_V1, P4D_LIFECYCLE_CASES_V1, P4D_VISUAL_PROFILES_V1,
  P4dMatrixContractError, validateP4dMatrixContractV1,
} from "../tools/phase4-p4d-matrix-contract";

test("P4-D matrix is exact, complete and test-isolated", () => {
  assert.doesNotThrow(() => validateP4dMatrixContractV1({
    buildBoundary: P4D_BUILD_BOUNDARY_V1, visualProfiles: P4D_VISUAL_PROFILES_V1,
    agentCases: P4D_AGENT_CASES_V1, lifecycleCases: P4D_LIFECYCLE_CASES_V1,
  }));
  assert.equal(P4D_VISUAL_PROFILES_V1.length * P4D_AGENT_CASES_V1.length, 9);
  assert.equal(P4D_LIFECYCLE_CASES_V1.length, 6);
  assert.deepEqual(P4D_BUILD_BOUNDARY_V1.publicWorkbenchMethods, ["getInfo", "resolveReviewedArtifact", "startTurn", "subscribeRun", "cancelRun", "resolveArtifact", "resolveCitation"]);
  assert.throws(() => validateP4dMatrixContractV1({
    buildBoundary: { ...P4D_BUILD_BOUNDARY_V1, publicAgentChannelCount: 6 }, visualProfiles: P4D_VISUAL_PROFILES_V1,
    agentCases: P4D_AGENT_CASES_V1, lifecycleCases: P4D_LIFECYCLE_CASES_V1,
  }), (error: unknown) => error instanceof P4dMatrixContractError && error.code === "PUBLIC_SURFACE_DRIFT");
});

test("P4-D production sources cannot import the test harness", () => {
  for (const source of P4D_BUILD_BOUNDARY_V1.productionEntries) {
    assert.doesNotMatch(readFileSync(source, "utf8"), /phase4-p4d|AAW_P4D/u);
  }
});
