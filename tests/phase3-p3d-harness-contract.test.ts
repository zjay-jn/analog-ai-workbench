import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  P3D_BUILD_BOUNDARY_V1,
  P3D_DELIVERY_SCENARIOS_V1,
  P3D_LIFECYCLE_CASES_V1,
  P3D_PAGE_ZOOM_CASE_IDS_V1,
  P3D_VISUAL_PROFILES_V1,
  P3dHarnessContractError,
  validateP3dHarnessContractV1,
} from "../tools/phase3-p3d-matrix-contract";

const persistentBanner =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED";
const overlayBanner = "SYNTHETIC OVERLAY · NO AGENT";

const expectedBuildBoundary = Object.freeze({
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

const expectedScenarios = Object.freeze([
  {
    caseId: "two-tabs-ready-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "flat-basic",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "selection-and-net-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "same-label-different-net",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "inspector-and-hierarchy-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "repeated-hierarchy",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "blackbox-unavailable-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "blackbox-child",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "synthetic-overlay-current",
    deliveryPath: "p3c-typed-resolve-then-p3b-reducer",
    fixtureId: "repeated-hierarchy",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner, overlayBanner]),
  },
  {
    caseId: "loading-delayed-resolve",
    deliveryPath: "main-owned-delayed-p3c-resolve",
    fixtureId: "flat-basic",
    freshness: null,
    terminalState: "loading",
    geometryAllowed: false,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "error-production-empty-registry",
    deliveryPath: "production-p3c-resolve-rejected",
    fixtureId: null,
    freshness: null,
    terminalState: "error",
    geometryAllowed: false,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "unverified-no-delivery",
    deliveryPath: "typed-boundary-unverified",
    fixtureId: null,
    freshness: null,
    terminalState: "unverified",
    geometryAllowed: false,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "historical-typed-delivery",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "flat-basic",
    freshness: "historical",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner]),
  },
  {
    caseId: "unicode-high-contrast-current",
    deliveryPath: "p3c-typed-resolve",
    fixtureId: "unicode-labels",
    freshness: "current",
    terminalState: "ready",
    geometryAllowed: true,
    banners: Object.freeze([persistentBanner]),
  },
]);

const expectedVisualProfiles = Object.freeze([
  {
    profileId: "windows-1366x768-dsf-100",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 1,
    forcedColorsActive: false,
  },
  {
    profileId: "windows-1366x768-dsf-125",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1.25,
    pageZoom: 1,
    forcedColorsActive: false,
  },
  {
    profileId: "windows-1366x768-dsf-150",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1.5,
    pageZoom: 1,
    forcedColorsActive: false,
  },
  {
    profileId: "windows-1366x768-page-zoom-200",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 2,
    forcedColorsActive: false,
  },
  {
    profileId: "windows-1366x768-high-contrast",
    physicalWidth: 1366,
    physicalHeight: 768,
    deviceScaleFactor: 1,
    pageZoom: 1,
    forcedColorsActive: true,
  },
]);

const expectedLifecycleCases = Object.freeze([
  {
    caseId: "reload-clears-ephemeral-state",
    trigger: "reload",
    expected: "fresh-resolve-zero-old-delivery",
  },
  {
    caseId: "revision-switch-rejects-late-result",
    trigger: "revision-switch",
    expected: "new-generation-only",
  },
  {
    caseId: "unmount-rejects-late-result",
    trigger: "unmount",
    expected: "idle-zero-delivery",
  },
  {
    caseId: "window-close-rejects-late-result",
    trigger: "window-close",
    expected: "zero-post-close-delivery",
  },
]);

test("P3-D test harness is isolated from production and preserves the exact two-method preload", () => {
  assert.deepEqual(P3D_BUILD_BOUNDARY_V1, expectedBuildBoundary);
  assert.doesNotThrow(() =>
    validateP3dHarnessContractV1({
      buildBoundary: P3D_BUILD_BOUNDARY_V1,
      deliveryScenarios: P3D_DELIVERY_SCENARIOS_V1,
      lifecycleCases: P3D_LIFECYCLE_CASES_V1,
      visualProfiles: P3D_VISUAL_PROFILES_V1,
    }),
  );

  const contaminatedBoundary = {
    ...P3D_BUILD_BOUNDARY_V1,
    productionEntries: [
      ...P3D_BUILD_BOUNDARY_V1.productionEntries,
      "tools/phase3-p3d-electron-matrix.mjs",
    ],
  };
  assert.throws(
    () =>
      validateP3dHarnessContractV1({
        buildBoundary: contaminatedBoundary,
        deliveryScenarios: P3D_DELIVERY_SCENARIOS_V1,
        lifecycleCases: P3D_LIFECYCLE_CASES_V1,
        visualProfiles: P3D_VISUAL_PROFILES_V1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof P3dHarnessContractError);
      assert.equal(error.code, "PRODUCTION_CONTAMINATION");
      return true;
    },
  );
});

test("P3-D typed delivery scenarios never use a renderer object fixture bypass", () => {
  assert.deepEqual(P3D_DELIVERY_SCENARIOS_V1, expectedScenarios);
  assert.equal(
    P3D_DELIVERY_SCENARIOS_V1.every(
      (scenario: { readonly deliveryPath: string }) =>
        scenario.deliveryPath !== "renderer-object-injection",
    ),
    true,
  );

  const bypassedScenarios = P3D_DELIVERY_SCENARIOS_V1.map(
    (scenario: Record<string, unknown>, index: number) =>
      index === 0
        ? { ...scenario, deliveryPath: "renderer-object-injection" }
        : scenario,
  );
  assert.throws(
    () =>
      validateP3dHarnessContractV1({
        buildBoundary: P3D_BUILD_BOUNDARY_V1,
        deliveryScenarios: bypassedScenarios,
        lifecycleCases: P3D_LIFECYCLE_CASES_V1,
        visualProfiles: P3D_VISUAL_PROFILES_V1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof P3dHarnessContractError);
      assert.equal(error.code, "RENDERER_OBJECT_BYPASS");
      return true;
    },
  );
});

test("P3-D freezes the lifecycle and Windows scale, page-zoom and high-contrast matrix", () => {
  assert.deepEqual(P3D_LIFECYCLE_CASES_V1, expectedLifecycleCases);
  assert.deepEqual(P3D_VISUAL_PROFILES_V1, expectedVisualProfiles);
  assert.deepEqual(P3D_PAGE_ZOOM_CASE_IDS_V1, [
    "two-tabs-ready-current",
    "selection-and-net-current",
    "inspector-and-hierarchy-current",
  ]);
  assert.deepEqual(
    P3D_VISUAL_PROFILES_V1.map(
      (profile: {
        readonly physicalWidth: number;
        readonly physicalHeight: number;
      }) => [profile.physicalWidth, profile.physicalHeight],
    ),
    Array.from({ length: expectedVisualProfiles.length }, () => [1366, 768]),
  );
});

test("P3-D scale and 200% oracles include Inspector evidence and prove three-region keyboard focus return", () => {
  const mainSource = readFileSync("tools/phase3-p3d-test-main.ts", "utf8");
  const matrixSource = readFileSync("tools/phase3-p3d-electron-matrix.mjs", "utf8");
  const workspaceSource = readFileSync("tools/phase3-p3d-workspace.tsx", "utf8");
  const viewerSource = readFileSync(
    "apps/desktop/src/renderer/SchematicViewer.tsx",
    "utf8",
  );
  const styles = readFileSync("apps/desktop/src/renderer/styles.css", "utf8");

  for (const oracle of [
    "semanticRegionsKeyboardReachable",
    "inspectorFocusReturned",
    "inspectorResponsive",
    "inspectorWithinViewport",
    "focusContractPassed",
  ]) {
  assert.match(mainSource, new RegExp(oracle, "u"));
  }
  assert.match(mainSource, /setAlwaysOnTop\(true\)/u);
  assert.match(matrixSource, /dom\.focusContractPassed === true/u);
  assert.match(matrixSource, /timeoutMs: 300_000/u);
  for (const profileId of [
    "windows-1366x768-dsf-125",
    "windows-1366x768-dsf-150",
  ]) {
    const profileIndex = matrixSource.indexOf(`"${profileId}"`);
    assert.notEqual(profileIndex, -1);
    assert.match(
      matrixSource.slice(profileIndex, profileIndex + 300),
      /"inspector-and-hierarchy-current"/u,
    );
    assert.match(
      matrixSource.slice(profileIndex, profileIndex + 300),
      /"selection-and-net-current"/u,
    );
  }
  const pageZoomProfileIndex = matrixSource.indexOf(
    '"windows-1366x768-page-zoom-200"',
  );
  assert.notEqual(pageZoomProfileIndex, -1);
  assert.match(
    matrixSource.slice(pageZoomProfileIndex, pageZoomProfileIndex + 160),
    /\.\.\.P3D_PAGE_ZOOM_CASE_IDS_V1/u,
  );
  assert.match(mainSource, /for \(const zoomScenario of zoomScenarios\)/u);
  assert.match(workspaceSource, /type: "open-inspector", target: action\.target/u);
  assert.match(viewerSource, /new ResizeObserver\(updateMode\)/u);
  assert.match(viewerSource, /role=.*"dialog"/su);
  assert.match(styles, /\.schematic-inspector\s*\{[\s\S]*position: fixed/u);
  assert.match(styles, /\.schematic-inspector-modal\s*\{[\s\S]*z-index: 40/u);
  assert.match(styles, /\.schematic-viewer svg\s*\{[\s\S]*min-height: 0/u);
});
