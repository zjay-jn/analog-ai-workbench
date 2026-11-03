import type { ReviewedArtifactRefV1 } from "../../../document-contract/src/reviewed-identity";
import type {
  CircuitDefinitionV1,
  CircuitPointV1,
  ReviewedCircuitIrV1,
} from "../reviewed-circuit-ir";
import {
  VIEWER_INTERACTION_CONTRACT_V1,
  ViewerViewStateError,
  resolveViewerOccurrenceDefinitionV1,
  viewerWorldToScreenV1,
  type SyntheticOverlayStyleTokenV1,
  type ViewerCssPointV1,
  type ViewerElementTargetV1,
  type ViewerViewStateV1,
  type ViewerViewportV1,
} from "./view-state";

export const SAFE_SVG_PRIMITIVE_ALLOWLIST_V1 = Object.freeze([
  "circle",
  "g",
  "line",
  "path",
  "polyline",
  "rect",
  "svg",
  "text",
] as const);

const SAFE_SVG_ATTRIBUTE_KEYS_V1 = Object.freeze([
  "className",
  "cx",
  "cy",
  "dominantBaseline",
  "fill",
  "height",
  "points",
  "r",
  "rx",
  "ry",
  "stroke",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeWidth",
  "textAnchor",
  "transform",
  "vectorEffect",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
] as const);

type SafeSvgAttributeKeyV1 = (typeof SAFE_SVG_ATTRIBUTE_KEYS_V1)[number];

export const SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1: readonly string[] =
  SAFE_SVG_ATTRIBUTE_KEYS_V1;

export const SVG_LAYER_ORDER_V1 = Object.freeze([
  "base",
  "net",
  "overlay",
  "selection",
  "keyboard-focus",
] as const);

export const SCHEMATIC_VIEWER_PERSISTENT_BANNER_V1 =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED" as const;
export const SCHEMATIC_VIEWER_OVERLAY_BANNER_V1 =
  "SYNTHETIC OVERLAY · NO AGENT" as const;

const MAX_SCENE_PRIMITIVES = 50_000;
const MAX_SCENE_POINTS = 50_000;

export type SafeSvgLayerKindV1 = (typeof SVG_LAYER_ORDER_V1)[number];
export type SafeSvgEmittedTagV1 = "circle" | "polyline" | "rect" | "text";
export type SafeSvgStyleTokenV1 =
  | "base-instance"
  | "base-terminal"
  | "base-wire"
  | "base-label"
  | "net-highlight"
  | SyntheticOverlayStyleTokenV1
  | "selection-highlight"
  | "keyboard-focus";

export type SafeSvgPrimitiveV1 = Readonly<{
  key: string;
  tag: SafeSvgEmittedTagV1;
  layer: SafeSvgLayerKindV1;
  attributes: Readonly<Record<string, string | number>>;
  text: string | null;
  styleToken: SafeSvgStyleTokenV1;
  target: ViewerElementTargetV1;
}>;

export type SafeSvgLayerV1 = Readonly<{
  kind: SafeSvgLayerKindV1;
  primitives: readonly SafeSvgPrimitiveV1[];
}>;

type ScreenHitShapeV1 =
  | Readonly<{ kind: "point"; point: ViewerCssPointV1; radiusCss: number }>
  | Readonly<{
      kind: "rect";
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    }>
  | Readonly<{ kind: "polyline"; points: readonly ViewerCssPointV1[] }>;

export type SafeSvgHitTargetV1 = Readonly<{
  target: ViewerElementTargetV1;
  priority: number;
  screenArea: number;
  shape: ScreenHitShapeV1;
}>;

export type SchematicViewerRenderStateV1 =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; freshness: "current" | "historical" }>
  | Readonly<{ status: "unverified" }>
  | Readonly<{ status: "error"; safeCode: string }>
  | Readonly<{ status: "revoked" }>
  | Readonly<{ status: "quarantined" }>;

export type SafeSvgOverlayFailureV1 = Readonly<{
  overlayId: string;
  failedTarget: ViewerElementTargetV1;
  safeCode: string;
}>;

export type SafeSvgSceneV1 = Readonly<{
  viewport: ViewerViewportV1;
  layers: readonly SafeSvgLayerV1[];
  primitives: readonly SafeSvgPrimitiveV1[];
  hitTargets: readonly SafeSvgHitTargetV1[];
  geometryVisible: boolean;
  deliveryAllowed: boolean;
  cancelDelivery: boolean;
  historicalWarningVisible: boolean;
  overlayVisible: boolean;
  overlayLocalErrorVisible: boolean;
  persistentBanner: typeof SCHEMATIC_VIEWER_PERSISTENT_BANNER_V1;
  overlayBanner: typeof SCHEMATIC_VIEWER_OVERLAY_BANNER_V1 | null;
}>;

export type BuildSafeSvgSceneInputV1 = Readonly<{
  circuitIr: ReviewedCircuitIrV1;
  artifactRef: ReviewedArtifactRefV1;
  viewState: ViewerViewStateV1;
  renderState: SchematicViewerRenderStateV1;
  overlayFailure?: SafeSvgOverlayFailureV1;
}>;

function sceneFail(message: string): never {
  throw new ViewerViewStateError("NON_FINITE_GEOMETRY", message);
}

function finite(value: number): number {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    return sceneFail("Scene geometry is not finite.");
  }
  return value === 0 ? 0 : value;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function sameTarget(
  left: ViewerElementTargetV1,
  right: ViewerElementTargetV1,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.revisionId === right.revisionId &&
    samePath(left.occurrencePath, right.occurrencePath) &&
    left.definitionId === right.definitionId &&
    left.elementKind === right.elementKind &&
    left.elementId === right.elementId
  );
}

function targetStableKey(target: ViewerElementTargetV1): string {
  return JSON.stringify([
    target.artifactId,
    target.revisionId,
    target.occurrencePath,
    target.definitionId,
    target.elementKind,
    target.elementId,
  ]);
}

function targetFor(
  artifactRef: ReviewedArtifactRefV1,
  viewState: ViewerViewStateV1,
  definition: CircuitDefinitionV1,
  elementKind: ViewerElementTargetV1["elementKind"],
  elementId: string,
): ViewerElementTargetV1 {
  return Object.freeze({
    artifactId: artifactRef.artifactId,
    revisionId: artifactRef.revisionId,
    occurrencePath: Object.freeze([...viewState.occurrencePath]),
    definitionId: definition.definitionId,
    elementKind,
    elementId,
  });
}

function requireExactArtifactRevision(
  target:
    | Readonly<{ artifactId: string; revisionId: string }>
    | null
    | undefined,
  artifactRef: ReviewedArtifactRefV1,
): void {
  if (
    target === null ||
    target === undefined ||
    target.artifactId !== artifactRef.artifactId ||
    target.revisionId !== artifactRef.revisionId
  ) {
    throw new ViewerViewStateError(
      "REVISION_UNAVAILABLE",
      "Artifact is unavailable.",
    );
  }
}

function attributes(
  value: Readonly<Partial<Record<SafeSvgAttributeKeyV1, string | number>>>,
): Readonly<Record<string, string | number>> {
  for (const [name, entry] of Object.entries(value)) {
    if (!SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1.includes(name)) {
      return sceneFail("Scene attribute is not allowlisted.");
    }
    if (typeof entry === "number") finite(entry);
    if (
      typeof entry === "string" &&
      /(?:url\s*\(|(?:data|blob|https?|file):)/iu.test(entry)
    ) {
      return sceneFail("Scene attribute contains a resource capability.");
    }
  }
  return Object.freeze({ ...value });
}

function primitive(
  key: string,
  tag: SafeSvgEmittedTagV1,
  layer: SafeSvgLayerKindV1,
  primitiveAttributes: Readonly<
    Partial<Record<SafeSvgAttributeKeyV1, string | number>>
  >,
  text: string | null,
  styleToken: SafeSvgStyleTokenV1,
  target: ViewerElementTargetV1,
): SafeSvgPrimitiveV1 {
  if (!(SAFE_SVG_PRIMITIVE_ALLOWLIST_V1 as readonly string[]).includes(tag)) {
    return sceneFail("Scene primitive is not allowlisted.");
  }
  return Object.freeze({
    key,
    tag,
    layer,
    attributes: attributes(primitiveAttributes),
    text,
    styleToken,
    target,
  });
}

function screenPoint(
  viewport: ViewerViewportV1,
  point: CircuitPointV1,
): ViewerCssPointV1 {
  return viewerWorldToScreenV1(viewport, point);
}

function screenPolylineArea(points: readonly ViewerCssPointV1[]): number {
  if (points.length === 0) return 0;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return finite(
    (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys)),
  );
}

function cloneForLayer(
  source: SafeSvgPrimitiveV1,
  key: string,
  layer: SafeSvgLayerKindV1,
  styleToken: SafeSvgStyleTokenV1,
): SafeSvgPrimitiveV1 {
  return Object.freeze({
    ...source,
    key,
    layer,
    styleToken,
  });
}

function buildBase(
  definition: CircuitDefinitionV1,
  artifactRef: ReviewedArtifactRefV1,
  viewState: ViewerViewStateV1,
): Readonly<{
  primitives: readonly SafeSvgPrimitiveV1[];
  hitTargets: readonly SafeSvgHitTargetV1[];
}> {
  const primitives: SafeSvgPrimitiveV1[] = [];
  const hitTargets: SafeSvgHitTargetV1[] = [];
  const byId = new Map<
    string,
    Readonly<{ kind: ViewerElementTargetV1["elementKind"]; value: unknown }>
  >();
  for (const value of definition.instances) {
    byId.set(value.instanceId, { kind: "instance", value });
  }
  for (const value of definition.ports) {
    byId.set(value.portId, { kind: "port", value });
  }
  for (const value of definition.pins ?? []) {
    byId.set(value.pinId, { kind: "pin", value });
  }
  for (const value of definition.wires) {
    byId.set(value.wireId, { kind: "wire", value });
  }
  for (const value of definition.labels) {
    byId.set(value.labelId, { kind: "label", value });
  }

  let pointCount = 0;
  for (const elementId of definition.renderOrder) {
    const entry = byId.get(elementId);
    if (entry === undefined) return sceneFail("Render order target is unavailable.");
    const target = targetFor(
      artifactRef,
      viewState,
      definition,
      entry.kind,
      elementId,
    );
    const key = `p${primitives.length}`;
    if (entry.kind === "instance") {
      const value = entry.value as CircuitDefinitionV1["instances"][number];
      if (value.bounds === undefined) return sceneFail("Instance geometry is unavailable.");
      const width = finite(value.bounds.maxX - value.bounds.minX);
      const height = finite(value.bounds.maxY - value.bounds.minY);
      const item = primitive(
        key,
        "rect",
        "base",
        {
          x: value.bounds.minX,
          y: value.bounds.minY,
          width,
          height,
        },
        null,
        "base-instance",
        target,
      );
      primitives.push(item);
      const first = viewerWorldToScreenV1(viewState.viewport, {
        x: value.bounds.minX,
        y: value.bounds.minY,
      });
      const second = viewerWorldToScreenV1(viewState.viewport, {
        x: value.bounds.maxX,
        y: value.bounds.maxY,
      });
      hitTargets.push(
        Object.freeze({
          target,
          priority: 3,
          screenArea: finite(Math.abs((second.x - first.x) * (second.y - first.y))),
          shape: Object.freeze({
            kind: "rect",
            minX: Math.min(first.x, second.x),
            minY: Math.min(first.y, second.y),
            maxX: Math.max(first.x, second.x),
            maxY: Math.max(first.y, second.y),
          }),
        }),
      );
    } else if (entry.kind === "port" || entry.kind === "pin") {
      const value = entry.value as {
        readonly x?: number;
        readonly y?: number;
      };
      if (value.x === undefined || value.y === undefined) {
        return sceneFail("Terminal geometry is unavailable.");
      }
      const radiusWorld = 4 / viewState.viewport.zoom;
      primitives.push(
        primitive(
          key,
          "circle",
          "base",
          { cx: value.x, cy: value.y, r: radiusWorld },
          null,
          "base-terminal",
          target,
        ),
      );
      hitTargets.push(
        Object.freeze({
          target,
          priority: 4,
          screenArea: Math.PI * 16,
          shape: Object.freeze({
            kind: "point",
            point: viewerWorldToScreenV1(viewState.viewport, {
              x: value.x,
              y: value.y,
            }),
            radiusCss: 4,
          }),
        }),
      );
    } else if (entry.kind === "wire") {
      const value = entry.value as CircuitDefinitionV1["wires"][number];
      if (value.points === undefined || value.points.length < 2) {
        return sceneFail("Wire geometry is unavailable.");
      }
      pointCount += value.points.length;
      if (pointCount > MAX_SCENE_POINTS) {
        throw new ViewerViewStateError("BUDGET_EXCEEDED", "Scene point budget exceeded.");
      }
      const serializedPoints = value.points
        .map((point) => `${finite(point.x)},${finite(point.y)}`)
        .join(" ");
      primitives.push(
        primitive(
          key,
          "polyline",
          "base",
          { points: serializedPoints },
          null,
          "base-wire",
          target,
        ),
      );
      const points = Object.freeze(
        value.points.map((point) => screenPoint(viewState.viewport, point)),
      );
      hitTargets.push(
        Object.freeze({
          target,
          priority: 2,
          screenArea: screenPolylineArea(points),
          shape: Object.freeze({ kind: "polyline", points }),
        }),
      );
    } else {
      const value = entry.value as CircuitDefinitionV1["labels"][number];
      if (value.x === undefined || value.y === undefined) {
        return sceneFail("Label geometry is unavailable.");
      }
      primitives.push(
        primitive(
          key,
          "text",
          "base",
          { x: value.x, y: value.y },
          value.text,
          "base-label",
          target,
        ),
      );
      hitTargets.push(
        Object.freeze({
          target,
          priority: 1,
          screenArea: 0,
          shape: Object.freeze({
            kind: "point",
            point: viewerWorldToScreenV1(viewState.viewport, {
              x: value.x,
              y: value.y,
            }),
            radiusCss: 0,
          }),
        }),
      );
    }
    if (primitives.length > MAX_SCENE_PRIMITIVES) {
      throw new ViewerViewStateError("BUDGET_EXCEEDED", "Scene primitive budget exceeded.");
    }
  }
  return Object.freeze({
    primitives: Object.freeze(primitives),
    hitTargets: Object.freeze(hitTargets),
  });
}

function netMemberIds(
  definition: CircuitDefinitionV1,
  viewState: ViewerViewStateV1,
  artifactRef: ReviewedArtifactRefV1,
): ReadonlySet<string> {
  const highlight = viewState.netHighlight;
  if (highlight !== null) {
    requireExactArtifactRevision(highlight, artifactRef);
  }
  if (
    highlight === null ||
    !samePath(highlight.occurrencePath, viewState.occurrencePath) ||
    highlight.definitionId !== definition.definitionId
  ) {
    return new Set();
  }
  return new Set(
    definition.nets.find((net) => net.netId === highlight.netId)?.memberElementIds ?? [],
  );
}

function emptyLayers(): readonly SafeSvgLayerV1[] {
  return Object.freeze(
    SVG_LAYER_ORDER_V1.map((kind) =>
      Object.freeze({ kind, primitives: Object.freeze([]) }),
    ),
  );
}

export function buildSafeSvgSceneV1(
  input: BuildSafeSvgSceneInputV1,
): SafeSvgSceneV1 {
  if (input.artifactRef.artifactKind !== "circuit_ir_reviewed") {
    throw new ViewerViewStateError("REVISION_UNAVAILABLE", "Artifact is unavailable.");
  }
  requireExactArtifactRevision(
    input.viewState.artifactBinding,
    input.artifactRef,
  );
  for (const target of input.viewState.selection) {
    requireExactArtifactRevision(target, input.artifactRef);
  }
  if (input.viewState.netHighlight !== null) {
    requireExactArtifactRevision(input.viewState.netHighlight, input.artifactRef);
  }
  const geometryVisible = input.renderState.status === "ready";
  const deliveryAllowed = geometryVisible;
  const cancelDelivery =
    input.renderState.status === "revoked" ||
    input.renderState.status === "quarantined";
  const historicalWarningVisible =
    input.renderState.status === "ready" &&
    input.renderState.freshness === "historical";
  const overlayLocalErrorVisible = input.overlayFailure !== undefined;
  const overlayVisible =
    geometryVisible &&
    input.viewState.overlay !== null &&
    !overlayLocalErrorVisible;
  const overlayBanner =
    overlayVisible || overlayLocalErrorVisible
      ? SCHEMATIC_VIEWER_OVERLAY_BANNER_V1
      : null;

  if (!geometryVisible) {
    return Object.freeze({
      viewport: input.viewState.viewport,
      layers: emptyLayers(),
      primitives: Object.freeze([]),
      hitTargets: Object.freeze([]),
      geometryVisible,
      deliveryAllowed,
      cancelDelivery,
      historicalWarningVisible,
      overlayVisible: false,
      overlayLocalErrorVisible,
      persistentBanner: SCHEMATIC_VIEWER_PERSISTENT_BANNER_V1,
      overlayBanner,
    });
  }

  const definition = resolveViewerOccurrenceDefinitionV1(
    input.circuitIr,
    input.viewState.occurrencePath,
  );
  const base = buildBase(
    definition,
    input.artifactRef,
    input.viewState,
  );
  const byTarget = new Map(
    base.primitives.map((item) => [targetStableKey(item.target), item]),
  );
  const members = netMemberIds(definition, input.viewState, input.artifactRef);
  const net = base.primitives
    .filter((item) => members.has(item.target.elementId))
    .map((item, index) =>
      cloneForLayer(item, `n${index}`, "net", "net-highlight"),
    );
  const overlay: SafeSvgPrimitiveV1[] = [];
  if (overlayVisible && input.viewState.overlay !== null) {
    for (const [index, overlayTarget] of input.viewState.overlay.targets.entries()) {
      const source = byTarget.get(targetStableKey(overlayTarget.target));
      if (source !== undefined) {
        overlay.push(
          cloneForLayer(
            source,
            `o${index}`,
            "overlay",
            overlayTarget.styleToken,
          ),
        );
      }
    }
  }
  const selection = input.viewState.selection
    .map((target) => {
      requireExactArtifactRevision(target, input.artifactRef);
      return byTarget.get(targetStableKey(target));
    })
    .filter((item): item is SafeSvgPrimitiveV1 => item !== undefined)
    .map((item, index) =>
      cloneForLayer(item, `s${index}`, "selection", "selection-highlight"),
    );
  const keyboardFocus: SafeSvgPrimitiveV1[] = [];
  const layerValues: Readonly<Record<SafeSvgLayerKindV1, readonly SafeSvgPrimitiveV1[]>> = {
    base: base.primitives,
    net: Object.freeze(net),
    overlay: Object.freeze(overlay),
    selection: Object.freeze(selection),
    "keyboard-focus": Object.freeze(keyboardFocus),
  };
  const layers = Object.freeze(
    SVG_LAYER_ORDER_V1.map((kind) =>
      Object.freeze({ kind, primitives: layerValues[kind] }),
    ),
  );
  const primitives = Object.freeze(layers.flatMap((layer) => layer.primitives));
  if (primitives.length > MAX_SCENE_PRIMITIVES) {
    throw new ViewerViewStateError("BUDGET_EXCEEDED", "Scene primitive budget exceeded.");
  }
  return Object.freeze({
    viewport: input.viewState.viewport,
    layers,
    primitives,
    hitTargets: base.hitTargets,
    geometryVisible,
    deliveryAllowed,
    cancelDelivery,
    historicalWarningVisible,
    overlayVisible,
    overlayLocalErrorVisible,
    persistentBanner: SCHEMATIC_VIEWER_PERSISTENT_BANNER_V1,
    overlayBanner,
  });
}

function distanceToSegment(
  point: ViewerCssPointV1,
  start: ViewerCssPointV1,
  end: ViewerCssPointV1,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(
    point.x - (start.x + t * dx),
    point.y - (start.y + t * dy),
  );
}

function shapeHit(
  shape: ScreenHitShapeV1,
  point: ViewerCssPointV1,
  tolerance: number,
): boolean {
  if (shape.kind === "point") {
    return (
      Math.hypot(point.x - shape.point.x, point.y - shape.point.y) <=
      tolerance + shape.radiusCss
    );
  }
  if (shape.kind === "rect") {
    return (
      point.x >= shape.minX - tolerance &&
      point.x <= shape.maxX + tolerance &&
      point.y >= shape.minY - tolerance &&
      point.y <= shape.maxY + tolerance
    );
  }
  for (let index = 1; index < shape.points.length; index += 1) {
    const start = shape.points[index - 1];
    const end = shape.points[index];
    if (
      start !== undefined &&
      end !== undefined &&
      distanceToSegment(point, start, end) <= tolerance
    ) {
      return true;
    }
  }
  return false;
}

export function hitTestSafeSvgSceneV1(
  scene: Pick<SafeSvgSceneV1, 'geometryVisible'|'hitTargets'>,
  input: Readonly<{ pointCss: ViewerCssPointV1; toleranceCssPx: number }>,
): SafeSvgHitTargetV1 | null {
  if (!scene.geometryVisible) return null;
  const tolerance = finite(input.toleranceCssPx);
  if (
    tolerance < 0 ||
    tolerance > VIEWER_INTERACTION_CONTRACT_V1.hitToleranceCssPx
  ) {
    throw new ViewerViewStateError("INVALID_ACTION", "Hit tolerance is invalid.");
  }
  const point = Object.freeze({
    x: finite(input.pointCss.x),
    y: finite(input.pointCss.y),
  });
  const matches = scene.hitTargets
    .filter((candidate) => shapeHit(candidate.shape, point, tolerance))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.screenArea - right.screenArea ||
        targetStableKey(left.target).localeCompare(targetStableKey(right.target)),
    );
  return matches[0] ?? null;
}
