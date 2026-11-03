import type { ResolveReviewedArtifactRequestV1 } from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";
import { P3D_DELIVERY_SCENARIOS_V1 } from "./phase3-p3d-matrix-contract";

export const P3D_APPROVED_FIXTURE_IDS_V1 = Object.freeze([
  "flat-basic",
  "repeated-hierarchy",
  "same-label-different-net",
  "blackbox-child",
  "explicit-port-mapping",
  "empty-minimum",
  "max-boundary",
  "unicode-labels",
] as const);

export type P3dApprovedFixtureIdV1 =
  (typeof P3D_APPROVED_FIXTURE_IDS_V1)[number];

export type P3dRuntimePresentationV1 =
  | "current"
  | "selection-net"
  | "inspector-hierarchy"
  | "blackbox"
  | "overlay"
  | "loading"
  | "error"
  | "unverified";

export type P3dRuntimeScenarioV1 = Readonly<{
  caseId: string;
  fixtureId: P3dApprovedFixtureIdV1 | null;
  request: ResolveReviewedArtifactRequestV1;
  presentation: P3dRuntimePresentationV1;
  registryMode: "admitted" | "empty";
  delayResolve: boolean;
  freshnessOverride: "historical" | null;
  runnable: boolean;
  notRunReason: string | null;
}>;

const CONTRACT_VERSION =
  "workbench.schematic.resolveReviewedArtifact.v1" as const;

function requestFor(fixtureId: P3dApprovedFixtureIdV1): ResolveReviewedArtifactRequestV1 {
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    documentRef: Object.freeze({
      documentId: `synthetic.schematic.${fixtureId}`,
      revisionId: "rev-1",
      documentKind: "schematic_reviewed" as const,
    }),
    artifactRef: Object.freeze({
      artifactId: `synthetic.circuit-ir.${fixtureId}`,
      revisionId: "rev-1",
      artifactKind: "circuit_ir_reviewed" as const,
    }),
    intent: "render" as const,
  });
}

const unavailableRequest = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  documentRef: Object.freeze({
    documentId: "synthetic.schematic.unavailable",
    revisionId: "rev-1",
    documentKind: "schematic_reviewed" as const,
  }),
  artifactRef: Object.freeze({
    artifactId: "synthetic.circuit-ir.unavailable",
    revisionId: "rev-1",
    artifactKind: "circuit_ir_reviewed" as const,
  }),
  intent: "render" as const,
}) satisfies ResolveReviewedArtifactRequestV1;

function scenario(
  caseId: string,
  fixtureId: P3dApprovedFixtureIdV1 | null,
  presentation: P3dRuntimePresentationV1,
  options: Readonly<{
    registryMode?: "admitted" | "empty";
    delayResolve?: boolean;
    freshnessOverride?: "historical" | null;
    runnable?: boolean;
    notRunReason?: string | null;
  }> = {},
): P3dRuntimeScenarioV1 {
  return Object.freeze({
    caseId,
    fixtureId,
    request: fixtureId === null ? unavailableRequest : requestFor(fixtureId),
    presentation,
    registryMode: options.registryMode ?? "admitted",
    delayResolve: options.delayResolve ?? false,
    freshnessOverride: options.freshnessOverride ?? null,
    runnable: options.runnable ?? true,
    notRunReason: options.notRunReason ?? null,
  });
}

export const P3D_RUNTIME_SCENARIOS_V1 = Object.freeze([
  scenario("two-tabs-ready-current", "flat-basic", "current"),
  scenario(
    "selection-and-net-current",
    "same-label-different-net",
    "selection-net",
  ),
  scenario(
    "inspector-and-hierarchy-current",
    "repeated-hierarchy",
    "inspector-hierarchy",
  ),
  scenario("blackbox-unavailable-current", "blackbox-child", "blackbox"),
  scenario("synthetic-overlay-current", "repeated-hierarchy", "overlay"),
  scenario("loading-delayed-resolve", "flat-basic", "loading", {
    delayResolve: true,
  }),
  scenario("error-production-empty-registry", null, "error", {
    registryMode: "empty",
  }),
  scenario("unverified-no-delivery", null, "unverified", {
    registryMode: "empty",
  }),
  scenario("historical-typed-delivery", "flat-basic", "current", {
    freshnessOverride: "historical",
  }),
  scenario("unicode-high-contrast-current", "unicode-labels", "current"),
]);

const matrixCaseIds = P3D_DELIVERY_SCENARIOS_V1.map((entry) => entry.caseId);
const runtimeCaseIds = P3D_RUNTIME_SCENARIOS_V1.map((entry) => entry.caseId);
if (JSON.stringify(matrixCaseIds) !== JSON.stringify(runtimeCaseIds)) {
  throw new Error("The P3-D runtime scenario table drifted from the matrix contract.");
}

export function p3dRuntimeScenarioByIdV1(caseId: string): P3dRuntimeScenarioV1 {
  const found = P3D_RUNTIME_SCENARIOS_V1.find((entry) => entry.caseId === caseId);
  if (found === undefined) throw new Error("The P3-D runtime case is unavailable.");
  return found;
}
