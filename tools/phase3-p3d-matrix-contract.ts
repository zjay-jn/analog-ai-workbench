export type P3dHarnessContractErrorCodeV1 =
  | "INVALID_CONTRACT"
  | "PRODUCTION_CONTAMINATION"
  | "PUBLIC_API_DRIFT"
  | "RENDERER_OBJECT_BYPASS"
  | "INCOMPLETE_MATRIX";

export class P3dHarnessContractError extends Error {
  readonly code: P3dHarnessContractErrorCodeV1;

  constructor(
    code: P3dHarnessContractErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "P3dHarnessContractError";
    this.code = code;
  }
}

const PERSISTENT_BANNER =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED";
const OVERLAY_BANNER = "SYNTHETIC OVERLAY · NO AGENT";

export const P3D_BUILD_BOUNDARY_V1 = Object.freeze({
  schemaVersion: "aaw.phase3-p3d.harness-boundary/v1",
  executionEnvironment: "windows-electron-test-only",
  toolEntrypoint: "tools/phase3-p3d-electron-matrix.mjs",
  outputRoot: ".local/quality-evidence/20260901-phase3-p3d-exit-01",
  productionEntries: Object.freeze([
    "apps/desktop/src/main/index.ts",
    "apps/desktop/src/renderer/main.tsx",
  ]),
  productionForbiddenModulePrefixes: Object.freeze(["tools/phase3-p3d-"]),
  productionForbiddenTokens: Object.freeze([
    "--aaw-p3d-scenario",
    "--aaw-p3d-control",
    "repeated-hierarchy",
    "same-label-different-net",
    "blackbox-child",
    "unicode-labels",
  ]),
  publicPreloadMethods: Object.freeze(["getInfo", "resolveReviewedArtifact"]),
  rendererObjectInjectionAllowed: false,
});

export const P3D_DELIVERY_SCENARIOS_V1 = Object.freeze([
  Object.freeze({
    caseId: "two-tabs-ready-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "flat-basic",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "selection-and-net-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "same-label-different-net",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "inspector-and-hierarchy-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "repeated-hierarchy",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "blackbox-unavailable-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "blackbox-child",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "synthetic-overlay-current",
    deliveryPath: "p3c-typed-resolve-then-p3b-reducer",
    fixtureId: "repeated-hierarchy",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER, OVERLAY_BANNER]),
  }),
  Object.freeze({
    caseId: "loading-delayed-resolve",
    deliveryPath: "main-owned-delayed-p3c-resolve",
    fixtureId: "flat-basic",
    freshness: null,
    terminalState: "loading",
    geometryAllowed: false,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "error-production-empty-registry",
    deliveryPath: "production-p3c-resolve-rejected",
    fixtureId: null,
    freshness: null,
    terminalState: "error",
    geometryAllowed: false,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "unverified-no-delivery",
    deliveryPath: "typed-boundary-unverified",
    fixtureId: null,
    freshness: null,
    terminalState: "unverified",
    geometryAllowed: false,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "historical-typed-delivery",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "flat-basic",
    freshness: "historical",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
  Object.freeze({
    caseId: "unicode-high-contrast-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "unicode-labels",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([PERSISTENT_BANNER]),
  }),
]);

export const P3D_PAGE_ZOOM_CASE_IDS_V1 = Object.freeze([
  "two-tabs-ready-current",
  "selection-and-net-current",
  "inspector-and-hierarchy-current",
]);

export const P3D_VISUAL_PROFILES_V1 = Object.freeze([
  Object.freeze({
    profileId: "windows-1366x768-dsf-100",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 1,
    forcedColorsActive: false,
  }),
  Object.freeze({
    profileId: "windows-1366x768-dsf-125",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1.25,
    pageZoom: 1,
    forcedColorsActive: false,
  }),
  Object.freeze({
    profileId: "windows-1366x768-dsf-150",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1.5,
    pageZoom: 1,
    forcedColorsActive: false,
  }),
  Object.freeze({
    profileId: "windows-1366x768-page-zoom-200",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 2,
    forcedColorsActive: false,
  }),
  Object.freeze({
    profileId: "windows-1366x768-high-contrast",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 1,
    forcedColorsActive: true,
  }),
]);

export const P3D_LIFECYCLE_CASES_V1 = Object.freeze([
  Object.freeze({
    caseId: "reload-clears-ephemeral-state",
    trigger: "reload",
    expected: "fresh-resolve-zero-old-delivery",
  }),
  Object.freeze({
    caseId: "revision-switch-rejects-late-result",
    trigger: "revision-switch",
    expected: "new-generation-only",
  }),
  Object.freeze({
    caseId: "unmount-rejects-late-result",
    trigger: "unmount",
    expected: "idle-zero-delivery",
  }),
  Object.freeze({
    caseId: "window-close-rejects-late-result",
    trigger: "window-close",
    expected: "zero-post-close-delivery",
  }),
]);

type ExactRecord = Readonly<Record<string, unknown>>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: P3dHarnessContractErrorCodeV1 = "INVALID_CONTRACT",
): ExactRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new P3dHarnessContractError(code, "P3-D harness contract object is invalid.");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new P3dHarnessContractError(code, "P3-D harness contract is not closed.");
  }
  return value as ExactRecord;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateP3dHarnessContractV1(value: unknown): void {
  const root = exactRecord(value, [
    "buildBoundary",
    "deliveryScenarios",
    "lifecycleCases",
    "visualProfiles",
  ]);
  const boundary = exactRecord(root.buildBoundary, [
    "schemaVersion",
    "executionEnvironment",
    "toolEntrypoint",
    "outputRoot",
    "productionEntries",
    "productionForbiddenModulePrefixes",
    "productionForbiddenTokens",
    "publicPreloadMethods",
    "rendererObjectInjectionAllowed",
  ]);

  const entries = Array.isArray(boundary.productionEntries)
    ? boundary.productionEntries
    : [];
  const forbiddenPrefixes = Array.isArray(
    boundary.productionForbiddenModulePrefixes,
  )
    ? boundary.productionForbiddenModulePrefixes
    : [];
  if (
    entries.some(
      (entry) =>
        typeof entry !== "string" ||
        forbiddenPrefixes.some(
          (prefix) => typeof prefix === "string" && entry.startsWith(prefix),
        ),
    )
  ) {
    throw new P3dHarnessContractError(
      "PRODUCTION_CONTAMINATION",
      "A P3-D test module is reachable from a production entry.",
    );
  }
  if (
    !jsonEqual(boundary.publicPreloadMethods, [
      "getInfo",
      "resolveReviewedArtifact",
    ])
  ) {
    throw new P3dHarnessContractError(
      "PUBLIC_API_DRIFT",
      "The public preload method set drifted.",
    );
  }

  const scenarios = Array.isArray(root.deliveryScenarios)
    ? root.deliveryScenarios
    : [];
  if (
    boundary.rendererObjectInjectionAllowed !== false ||
    scenarios.some(
      (scenario) =>
        scenario !== null &&
        typeof scenario === "object" &&
        (scenario as Record<string, unknown>).deliveryPath ===
          "renderer-object-injection",
    )
  ) {
    throw new P3dHarnessContractError(
      "RENDERER_OBJECT_BYPASS",
      "Renderer object fixture injection is forbidden.",
    );
  }

  if (
    !jsonEqual(boundary, P3D_BUILD_BOUNDARY_V1) ||
    !jsonEqual(scenarios, P3D_DELIVERY_SCENARIOS_V1) ||
    !jsonEqual(root.lifecycleCases, P3D_LIFECYCLE_CASES_V1) ||
    !jsonEqual(root.visualProfiles, P3D_VISUAL_PROFILES_V1)
  ) {
    throw new P3dHarnessContractError(
      "INCOMPLETE_MATRIX",
      "The P3-D harness matrix is incomplete or has drifted.",
    );
  }
}
