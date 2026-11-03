export type P4dVisualProfileV1 = Readonly<{
  profileId: string;
  physicalWidth: 1366;
  physicalHeight: 768;
  deviceScaleFactor: 1 | 1.25 | 1.5;
  pageZoom: 1 | 2;
}>;

export type P4dAgentCaseV1 = Readonly<{
  caseId: "running-stream-cancel" | "replay-recovery" | "citation-historical-unavailable";
  expectedLifecycle: "running" | "error";
  screenshotRequired: true;
}>;

export type P4dLifecycleCaseV1 = Readonly<{
  caseId: "navigation" | "reload" | "workspace-switch" | "revision-revoke" | "quarantine" | "window-close";
  expected: "zero-post-revoke-delivery";
}>;

export const P4D_VISUAL_PROFILES_V1: readonly P4dVisualProfileV1[] = Object.freeze([
  Object.freeze({ profileId: "windows-1366x768-dsf-125", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1.25, pageZoom: 1 }),
  Object.freeze({ profileId: "windows-1366x768-dsf-150", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1.5, pageZoom: 1 }),
  Object.freeze({ profileId: "windows-1366x768-page-zoom-200", physicalWidth: 1366, physicalHeight: 768, deviceScaleFactor: 1, pageZoom: 2 }),
]);

export const P4D_AGENT_CASES_V1: readonly P4dAgentCaseV1[] = Object.freeze([
  Object.freeze({ caseId: "running-stream-cancel", expectedLifecycle: "running", screenshotRequired: true }),
  Object.freeze({ caseId: "replay-recovery", expectedLifecycle: "error", screenshotRequired: true }),
  Object.freeze({ caseId: "citation-historical-unavailable", expectedLifecycle: "running", screenshotRequired: true }),
]);

export const P4D_LIFECYCLE_CASES_V1: readonly P4dLifecycleCaseV1[] = Object.freeze([
  Object.freeze({ caseId: "navigation", expected: "zero-post-revoke-delivery" }),
  Object.freeze({ caseId: "reload", expected: "zero-post-revoke-delivery" }),
  Object.freeze({ caseId: "workspace-switch", expected: "zero-post-revoke-delivery" }),
  Object.freeze({ caseId: "revision-revoke", expected: "zero-post-revoke-delivery" }),
  Object.freeze({ caseId: "quarantine", expected: "zero-post-revoke-delivery" }),
  Object.freeze({ caseId: "window-close", expected: "zero-post-revoke-delivery" }),
]);

export const P4D_BUILD_BOUNDARY_V1 = Object.freeze({
  schemaVersion: "aaw.phase4.p4d.harness-boundary/v1",
  executionEnvironment: "windows-electron-test-only",
  testMain: "tools/phase4-p4d-test-main.ts",
  matrixRunner: "tools/phase4-p4d-electron-matrix.mjs",
  productionEntries: Object.freeze(["apps/desktop/src/main/index.ts", "apps/desktop/src/renderer/main.tsx"]),
  productionForbiddenPrefixes: Object.freeze(["tools/phase4-p4d-"]),
  publicWorkbenchMethods: Object.freeze(["getInfo", "resolveReviewedArtifact", "startTurn", "subscribeRun", "cancelRun", "resolveArtifact", "resolveCitation"]),
  publicAgentChannelCount: 5,
  rendererObjectInjectionAllowed: false,
  networkAllowed: false,
  realModelAllowed: false,
  realRagAllowed: false,
  toolBrokerAllowed: false,
});

export class P4dMatrixContractError extends Error {
  readonly code: "INVALID_CONTRACT" | "INCOMPLETE_MATRIX" | "PRODUCTION_CONTAMINATION" | "PUBLIC_SURFACE_DRIFT";

  constructor(code: "INVALID_CONTRACT" | "INCOMPLETE_MATRIX" | "PRODUCTION_CONTAMINATION" | "PUBLIC_SURFACE_DRIFT") {
    super("The P4-D matrix contract is invalid.");
    this.name = "P4dMatrixContractError";
    this.code = code;
  }
}

function json(value: unknown): string { return JSON.stringify(value); }

export function validateP4dMatrixContractV1(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new P4dMatrixContractError("INVALID_CONTRACT");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (json(Object.keys(record).sort()) !== json(["agentCases", "buildBoundary", "lifecycleCases", "visualProfiles"])) {
    throw new P4dMatrixContractError("INVALID_CONTRACT");
  }
  if (json(record.buildBoundary) !== json(P4D_BUILD_BOUNDARY_V1)) throw new P4dMatrixContractError("PUBLIC_SURFACE_DRIFT");
  if (json(record.visualProfiles) !== json(P4D_VISUAL_PROFILES_V1) || json(record.agentCases) !== json(P4D_AGENT_CASES_V1) || json(record.lifecycleCases) !== json(P4D_LIFECYCLE_CASES_V1)) {
    throw new P4dMatrixContractError("INCOMPLETE_MATRIX");
  }
  const boundary = P4D_BUILD_BOUNDARY_V1;
  if (boundary.productionEntries.some((entry) => boundary.productionForbiddenPrefixes.some((prefix) => entry.startsWith(prefix)))) {
    throw new P4dMatrixContractError("PRODUCTION_CONTAMINATION");
  }
}
