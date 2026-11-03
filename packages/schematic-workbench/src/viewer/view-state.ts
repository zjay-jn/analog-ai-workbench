import type { ReviewedArtifactRefV1 } from "../../../document-contract/src/reviewed-identity";
import type {
  CircuitBoundsV1,
  CircuitDefinitionV1,
  CircuitLabelV1,
  ReviewedCircuitIrV1,
} from "../reviewed-circuit-ir";

export const VIEWER_INTERACTION_CONTRACT_V1 = Object.freeze({
  fitPaddingCssPx: 24,
  minZoom: 0.1,
  maxZoom: 32,
  keyboardZoomFactor: 1.2,
  panDragThresholdCssPx: 3,
  keyboardPanStepCssPx: 40,
  keyboardPanLargeStepCssPx: 120,
  hitToleranceCssPx: 6,
} as const);

export const VIEWER_OVERLAY_TARGET_LIMIT_V1 = 4_096;
export const VIEWER_OCCURRENCE_DEPTH_LIMIT_V1 = 32;

export type ViewerViewStateErrorCode =
  | "INVALID_VIEW_STATE"
  | "INVALID_ACTION"
  | "NON_FINITE_GEOMETRY"
  | "VIEWPORT_UNAVAILABLE"
  | "OCCURRENCE_UNAVAILABLE"
  | "INVALID_TARGET"
  | "NET_UNAVAILABLE"
  | "AMBIGUOUS_NET"
  | "HIERARCHY_DEPTH_EXCEEDED"
  | "BLACKBOX_UNAVAILABLE"
  | "OVERLAY_REJECTED"
  | "REVISION_UNAVAILABLE"
  | "BUDGET_EXCEEDED";

export class ViewerViewStateError extends Error {
  readonly retryability = "never" as const;
  readonly recoveryAction = "none" as const;

  constructor(
    readonly code: ViewerViewStateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ViewerViewStateError";
  }
}

export type ViewerCssPointV1 = Readonly<{ x: number; y: number }>;
export type ViewerCssSizeV1 = Readonly<{ width: number; height: number }>;
export type ViewerViewportV1 = Readonly<{
  zoom: number;
  translateXCss: number;
  translateYCss: number;
  widthCss: number;
  heightCss: number;
}>;

export type ViewerElementKindV1 =
  | "instance"
  | "port"
  | "pin"
  | "wire"
  | "label";

export type ViewerElementTargetV1 = Readonly<{
  artifactId: string;
  revisionId: string;
  occurrencePath: readonly string[];
  definitionId: string;
  elementKind: ViewerElementKindV1;
  elementId: string;
}>;

export type ViewerNetTargetV1 = Readonly<{
  artifactId: string;
  revisionId: string;
  occurrencePath: readonly string[];
  definitionId: string;
  netId: string;
}>;

export type SyntheticOverlayStyleTokenV1 =
  | "synthetic-accent"
  | "synthetic-warning"
  | "synthetic-muted";

export type SyntheticOverlayTargetV1 = Readonly<{
  target: ViewerElementTargetV1;
  styleToken: SyntheticOverlayStyleTokenV1;
}>;

export type SyntheticOverlayEnvelopeV1 = Readonly<{
  contractVersion: "aaw.synthetic-overlay/v1alpha1";
  overlayId: string;
  artifactRef: ReviewedArtifactRefV1;
  targets: readonly SyntheticOverlayTargetV1[];
}>;

export type ViewerPanGestureV1 = Readonly<{
  pointerId: number;
  phase: "pending" | "active";
  startCss: ViewerCssPointV1;
  lastCss: ViewerCssPointV1;
  originViewport: ViewerViewportV1;
}>;

export type ViewerInspectorV1 = Readonly<{
  target: ViewerElementTargetV1;
  mode: "dock" | "modal";
}>;

type ViewerArtifactBindingV1 = Readonly<{
  artifactId: string;
  revisionId: string;
}>;

type ViewerHierarchyFrameV1 = Readonly<{
  viewport: ViewerViewportV1;
  occurrencePath: readonly string[];
  selection: readonly ViewerElementTargetV1[];
  netHighlight: ViewerNetTargetV1 | null;
  overlay: SyntheticOverlayEnvelopeV1 | null;
  inspector: ViewerInspectorV1 | null;
  panGesture: ViewerPanGestureV1 | null;
  announcement: string | null;
  focusTarget: "canvas";
  artifactBinding: ViewerArtifactBindingV1;
}>;

export type ViewerViewStateV1 = Readonly<{
  viewport: ViewerViewportV1;
  occurrencePath: readonly string[];
  selection: readonly ViewerElementTargetV1[];
  netHighlight: ViewerNetTargetV1 | null;
  overlay: SyntheticOverlayEnvelopeV1 | null;
  inspector: ViewerInspectorV1 | null;
  panGesture: ViewerPanGestureV1 | null;
  hierarchyStack: readonly ViewerHierarchyFrameV1[];
  announcement: string | null;
  focusTarget: "canvas";
  artifactBinding: ViewerArtifactBindingV1;
}>;

export type ViewerActionV1 =
  | Readonly<{ type: "fit" }>
  | Readonly<{ type: "set-viewport"; viewport: ViewerViewportV1 }>
  | Readonly<{
      type: "zoom";
      factor: number;
      anchorCss: ViewerCssPointV1;
      source: "ctrl-wheel" | "button";
    }>
  | Readonly<{ type: "keyboard-zoom"; direction: "in" | "out" }>
  | Readonly<{
      type: "pointer-down";
      pointerId: number;
      button: "primary" | "middle";
      pointCss: ViewerCssPointV1;
      spaceKey: boolean;
    }>
  | Readonly<{
      type: "pointer-move";
      pointerId: number;
      pointCss: ViewerCssPointV1;
    }>
  | Readonly<{ type: "pointer-up"; pointerId: number }>
  | Readonly<{
      type: "wheel-pan";
      deltaCssPx: number;
      shiftKey: boolean;
    }>
  | Readonly<{
      type: "keyboard-pan";
      direction: "left" | "right" | "up" | "down";
      largeStep: boolean;
    }>
  | Readonly<{
      type: "primary-select";
      target: ViewerElementTargetV1 | null;
      ctrlKey: boolean;
    }>
  | Readonly<{ type: "toggle-selection-net" }>
  | Readonly<{ type: "select-net"; target: ViewerNetTargetV1 }>
  | Readonly<{ type: "admit-overlay"; overlay: SyntheticOverlayEnvelopeV1 }>
  | Readonly<{ type: "clear-overlay" }>
  | Readonly<{ type: "open-inspector"; target: ViewerElementTargetV1 }>
  | Readonly<{ type: "close-inspector" }>
  | Readonly<{ type: "enter-hierarchy"; instanceId: string }>
  | Readonly<{ type: "back-hierarchy" }>
  | Readonly<{ type: "breadcrumb-hierarchy"; depth: number }>
  | Readonly<{ type: "escape" }>;

function fail(code: ViewerViewStateErrorCode, message: string): never {
  throw new ViewerViewStateError(code, message);
}

function finite(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    return fail("NON_FINITE_GEOMETRY", `${label} must be finite.`);
  }
  return value === 0 ? 0 : value;
}

function positive(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed <= 0) return fail("VIEWPORT_UNAVAILABLE", `${label} must be positive.`);
  return parsed;
}

function safeText(value: unknown, label: string, maxBytes = 4_096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return fail("INVALID_ACTION", `${label} is invalid.`);
  }
  return value;
}

function freezePoint(value: ViewerCssPointV1, label: string): ViewerCssPointV1 {
  return Object.freeze({
    x: finite(value.x, `${label}.x`),
    y: finite(value.y, `${label}.y`),
  });
}

function freezeViewport(value: ViewerViewportV1): ViewerViewportV1 {
  const zoom = finite(value.zoom, "viewport.zoom");
  if (
    zoom < VIEWER_INTERACTION_CONTRACT_V1.minZoom ||
    zoom > VIEWER_INTERACTION_CONTRACT_V1.maxZoom
  ) {
    return fail("VIEWPORT_UNAVAILABLE", "Viewport zoom is outside the contract.");
  }
  return Object.freeze({
    zoom,
    translateXCss: finite(value.translateXCss, "viewport.translateXCss"),
    translateYCss: finite(value.translateYCss, "viewport.translateYCss"),
    widthCss: positive(value.widthCss, "viewport.widthCss"),
    heightCss: positive(value.heightCss, "viewport.heightCss"),
  });
}

function freezePath(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > VIEWER_OCCURRENCE_DEPTH_LIMIT_V1) {
    return fail("OCCURRENCE_UNAVAILABLE", "Occurrence path is outside the contract.");
  }
  return Object.freeze(
    value.map((entry) => safeText(entry, "occurrencePath entry")),
  );
}

function freezeTarget(value: ViewerElementTargetV1): ViewerElementTargetV1 {
  if (
    value.elementKind !== "instance" &&
    value.elementKind !== "port" &&
    value.elementKind !== "pin" &&
    value.elementKind !== "wire" &&
    value.elementKind !== "label"
  ) {
    return fail("INVALID_TARGET", "Element kind is invalid.");
  }
  return Object.freeze({
    artifactId: safeText(value.artifactId, "artifactId", 128),
    revisionId: safeText(value.revisionId, "revisionId", 128),
    occurrencePath: freezePath(value.occurrencePath),
    definitionId: safeText(value.definitionId, "definitionId"),
    elementKind: value.elementKind,
    elementId: safeText(value.elementId, "elementId"),
  });
}

function freezeNetTarget(value: ViewerNetTargetV1): ViewerNetTargetV1 {
  return Object.freeze({
    artifactId: safeText(value.artifactId, "artifactId", 128),
    revisionId: safeText(value.revisionId, "revisionId", 128),
    occurrencePath: freezePath(value.occurrencePath),
    definitionId: safeText(value.definitionId, "definitionId"),
    netId: safeText(value.netId, "netId"),
  });
}

function bindingFromArtifactRef(
  value: ReviewedArtifactRefV1,
): ViewerArtifactBindingV1 {
  if (value.artifactKind !== "circuit_ir_reviewed") {
    return fail("REVISION_UNAVAILABLE", "Artifact kind is unavailable.");
  }
  return Object.freeze({
    artifactId: safeText(value.artifactId, "artifactId", 128),
    revisionId: safeText(value.revisionId, "revisionId", 128),
  });
}

function targetBinding(
  value: ViewerElementTargetV1 | ViewerNetTargetV1,
): ViewerArtifactBindingV1 {
  return Object.freeze({
    artifactId: value.artifactId,
    revisionId: value.revisionId,
  });
}

function bindArtifact(
  state: ViewerViewStateV1,
  requested: ViewerArtifactBindingV1,
): ViewerArtifactBindingV1 {
  const binding = state.artifactBinding as
    | ViewerArtifactBindingV1
    | null
    | undefined;
  if (
    binding === null ||
    binding === undefined ||
    binding.artifactId !== requested.artifactId ||
    binding.revisionId !== requested.revisionId
  ) {
    return fail("REVISION_UNAVAILABLE", "Exact artifact revision is unavailable.");
  }
  return binding;
}

export function fitViewerViewportV1(
  bounds: CircuitBoundsV1,
  size: ViewerCssSizeV1,
): ViewerViewportV1 {
  const minX = finite(bounds.minX, "bounds.minX");
  const minY = finite(bounds.minY, "bounds.minY");
  const maxX = finite(bounds.maxX, "bounds.maxX");
  const maxY = finite(bounds.maxY, "bounds.maxY");
  if (minX > maxX || minY > maxY) {
    return fail("VIEWPORT_UNAVAILABLE", "Bounds are invalid.");
  }
  const widthCss = positive(size.width, "viewport width");
  const heightCss = positive(size.height, "viewport height");
  const availableWidth = Math.max(
    0,
    widthCss - VIEWER_INTERACTION_CONTRACT_V1.fitPaddingCssPx * 2,
  );
  const availableHeight = Math.max(
    0,
    heightCss - VIEWER_INTERACTION_CONTRACT_V1.fitPaddingCssPx * 2,
  );
  const worldWidth = maxX - minX;
  const worldHeight = maxY - minY;
  const candidates: number[] = [];
  if (worldWidth > 0) candidates.push(availableWidth / worldWidth);
  if (worldHeight > 0) candidates.push(availableHeight / worldHeight);
  const rawZoom = candidates.length === 0 ? 1 : Math.min(...candidates);
  const zoom = Math.min(
    VIEWER_INTERACTION_CONTRACT_V1.maxZoom,
    Math.max(VIEWER_INTERACTION_CONTRACT_V1.minZoom, rawZoom),
  );
  const translateXCss =
    (widthCss - worldWidth * zoom) / 2 - minX * zoom;
  const translateYCss =
    (heightCss - worldHeight * zoom) / 2 - minY * zoom;
  return freezeViewport({
    zoom,
    translateXCss: translateXCss === 0 ? 0 : translateXCss,
    translateYCss: translateYCss === 0 ? 0 : translateYCss,
    widthCss,
    heightCss,
  });
}

export function viewerWorldToScreenV1(
  viewport: ViewerViewportV1,
  point: ViewerCssPointV1,
): ViewerCssPointV1 {
  const normalized = freezeViewport(viewport);
  const world = freezePoint(point, "world point");
  return freezePoint(
    {
      x: world.x * normalized.zoom + normalized.translateXCss,
      y: world.y * normalized.zoom + normalized.translateYCss,
    },
    "screen point",
  );
}

export function viewerScreenToWorldV1(
  viewport: ViewerViewportV1,
  point: ViewerCssPointV1,
): ViewerCssPointV1 {
  const normalized = freezeViewport(viewport);
  const screen = freezePoint(point, "screen point");
  return freezePoint(
    {
      x: (screen.x - normalized.translateXCss) / normalized.zoom,
      y: (screen.y - normalized.translateYCss) / normalized.zoom,
    },
    "world point",
  );
}

function zoomAt(
  viewport: ViewerViewportV1,
  factorValue: number,
  anchorValue: ViewerCssPointV1,
): ViewerViewportV1 {
  const factor = finite(factorValue, "zoom factor");
  if (factor <= 0) return fail("INVALID_ACTION", "Zoom factor must be positive.");
  const anchor = freezePoint(anchorValue, "zoom anchor");
  const worldAnchor = viewerScreenToWorldV1(viewport, anchor);
  const zoom = Math.min(
    VIEWER_INTERACTION_CONTRACT_V1.maxZoom,
    Math.max(VIEWER_INTERACTION_CONTRACT_V1.minZoom, viewport.zoom * factor),
  );
  return freezeViewport({
    ...viewport,
    zoom,
    translateXCss: anchor.x - worldAnchor.x * zoom,
    translateYCss: anchor.y - worldAnchor.y * zoom,
  });
}

function panViewport(
  viewport: ViewerViewportV1,
  deltaX: number,
  deltaY: number,
): ViewerViewportV1 {
  return freezeViewport({
    ...viewport,
    translateXCss:
      viewport.translateXCss + finite(deltaX, "pan deltaX") || 0,
    translateYCss:
      viewport.translateYCss + finite(deltaY, "pan deltaY") || 0,
  });
}

export function resolveViewerOccurrenceDefinitionV1(
  circuitIr: ReviewedCircuitIrV1,
  occurrencePath: readonly string[],
): CircuitDefinitionV1 {
  const path = freezePath(occurrencePath);
  const definitions = new Map(
    circuitIr.definitions.map((definition) => [definition.definitionId, definition]),
  );
  let definition = definitions.get(circuitIr.rootDefinitionId);
  if (definition === undefined) {
    return fail("OCCURRENCE_UNAVAILABLE", "Root occurrence is unavailable.");
  }
  for (const instanceId of path) {
    const instance = definition.instances.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (
      instance === undefined ||
      instance.blackbox === true ||
      instance.childDefinitionId === undefined
    ) {
      return fail("OCCURRENCE_UNAVAILABLE", "Occurrence is unavailable.");
    }
    const child = definitions.get(instance.childDefinitionId);
    if (child === undefined) {
      return fail("OCCURRENCE_UNAVAILABLE", "Occurrence child is unavailable.");
    }
    definition = child;
  }
  return definition;
}

export function resolveViewerElementTargetV1(
  circuitIr: ReviewedCircuitIrV1,
  targetValue: ViewerElementTargetV1,
): Readonly<{ target: ViewerElementTargetV1; definition: CircuitDefinitionV1; element: unknown }> {
  const target = freezeTarget(targetValue);
  const definition = resolveViewerOccurrenceDefinitionV1(
    circuitIr,
    target.occurrencePath,
  );
  if (definition.definitionId !== target.definitionId) {
    return fail("INVALID_TARGET", "Target definition does not match occurrence.");
  }
  const collection =
    target.elementKind === "instance"
      ? definition.instances
      : target.elementKind === "port"
        ? definition.ports
        : target.elementKind === "pin"
          ? definition.pins ?? []
          : target.elementKind === "wire"
            ? definition.wires
            : definition.labels;
  const idKey = `${target.elementKind}Id` as
    | "instanceId"
    | "portId"
    | "pinId"
    | "wireId"
    | "labelId";
  const element = collection.find(
    (candidate) => (candidate as unknown as Record<string, unknown>)[idKey] === target.elementId,
  );
  if (element === undefined) return fail("INVALID_TARGET", "Target is unavailable.");
  return Object.freeze({ target, definition, element });
}

export function resolveViewerNetTargetV1(
  circuitIr: ReviewedCircuitIrV1,
  targetValue: ViewerNetTargetV1,
): Readonly<{ target: ViewerNetTargetV1; definition: CircuitDefinitionV1 }> {
  const target = freezeNetTarget(targetValue);
  const definition = resolveViewerOccurrenceDefinitionV1(
    circuitIr,
    target.occurrencePath,
  );
  if (
    definition.definitionId !== target.definitionId ||
    !definition.nets.some((net) => net.netId === target.netId)
  ) {
    return fail("NET_UNAVAILABLE", "Net occurrence is unavailable.");
  }
  return Object.freeze({ target, definition });
}

function targetKey(target: ViewerElementTargetV1): string {
  return JSON.stringify([
    target.artifactId,
    target.revisionId,
    target.occurrencePath,
    target.definitionId,
    target.elementKind,
    target.elementId,
  ]);
}

function netForElement(
  definition: CircuitDefinitionV1,
  target: ViewerElementTargetV1,
): string | null {
  if (target.elementKind === "port") {
    return definition.ports.find((entry) => entry.portId === target.elementId)?.netId ?? null;
  }
  if (target.elementKind === "pin") {
    return (definition.pins ?? []).find((entry) => entry.pinId === target.elementId)?.netId ?? null;
  }
  if (target.elementKind === "wire") {
    return definition.wires.find((entry) => entry.wireId === target.elementId)?.netId ?? null;
  }
  if (target.elementKind === "label") {
    const label = definition.labels.find(
      (entry) => entry.labelId === target.elementId,
    );
    return label === undefined ? null : netForLabelTarget(definition, label);
  }
  const instanceNets = new Set(
    (definition.pins ?? [])
      .filter((pin) => pin.instanceId === target.elementId)
      .map((pin) => pin.netId),
  );
  return instanceNets.size === 1 ? [...instanceNets][0] ?? null : null;
}

function netForLabelTarget(
  definition: CircuitDefinitionV1,
  label: CircuitLabelV1,
): string | null {
  if (label.targetElementId === undefined) return null;
  return (
    definition.wires.find((entry) => entry.wireId === label.targetElementId)?.netId ??
    (definition.pins ?? []).find((entry) => entry.pinId === label.targetElementId)?.netId ??
    definition.ports.find((entry) => entry.portId === label.targetElementId)?.netId ??
    null
  );
}

function freezeOverlay(
  circuitIr: ReviewedCircuitIrV1,
  overlay: SyntheticOverlayEnvelopeV1,
): SyntheticOverlayEnvelopeV1 {
  if (overlay.contractVersion !== "aaw.synthetic-overlay/v1alpha1") {
    return fail("OVERLAY_REJECTED", "Overlay contract is invalid.");
  }
  const binding = bindingFromArtifactRef(overlay.artifactRef);
  safeText(overlay.overlayId, "overlayId", 512);
  if (
    !Array.isArray(overlay.targets) ||
    overlay.targets.length === 0 ||
    overlay.targets.length > VIEWER_OVERLAY_TARGET_LIMIT_V1
  ) {
    return fail("BUDGET_EXCEEDED", "Overlay target count is outside the contract.");
  }
  const targets = overlay.targets.map((entry) => {
    if (
      entry.styleToken !== "synthetic-accent" &&
      entry.styleToken !== "synthetic-warning" &&
      entry.styleToken !== "synthetic-muted"
    ) {
      return fail("OVERLAY_REJECTED", "Overlay style token is invalid.");
    }
    const resolved = resolveViewerElementTargetV1(circuitIr, entry.target);
    if (
      resolved.target.artifactId !== binding.artifactId ||
      resolved.target.revisionId !== binding.revisionId
    ) {
      return fail("REVISION_UNAVAILABLE", "Overlay revision is unavailable.");
    }
    return Object.freeze({
      target: resolved.target,
      styleToken: entry.styleToken,
    });
  });
  return Object.freeze({
    contractVersion: "aaw.synthetic-overlay/v1alpha1",
    overlayId: overlay.overlayId,
    artifactRef: Object.freeze({
      artifactId: binding.artifactId,
      revisionId: binding.revisionId,
      artifactKind: "circuit_ir_reviewed",
    }),
    targets: Object.freeze(targets),
  });
}

function freezeState(value: ViewerViewStateV1): ViewerViewStateV1 {
  return Object.freeze(value);
}

function updated(
  state: ViewerViewStateV1,
  patch: Partial<ViewerViewStateV1>,
): ViewerViewStateV1 {
  return freezeState({ ...state, ...patch });
}

export function createInitialViewerViewStateV1(
  circuitIr: ReviewedCircuitIrV1,
  size: ViewerCssSizeV1,
  artifactRef: ReviewedArtifactRefV1,
): ViewerViewStateV1 {
  return freezeState({
    viewport: fitViewerViewportV1(circuitIr.bounds, size),
    occurrencePath: Object.freeze([]),
    selection: Object.freeze([]),
    netHighlight: null,
    overlay: null,
    inspector: null,
    panGesture: null,
    hierarchyStack: Object.freeze([]),
    announcement: null,
    focusTarget: "canvas",
    artifactBinding: bindingFromArtifactRef(artifactRef),
  });
}

function hierarchyFrame(state: ViewerViewStateV1): ViewerHierarchyFrameV1 {
  return Object.freeze({
    viewport: state.viewport,
    occurrencePath: state.occurrencePath,
    selection: state.selection,
    netHighlight: state.netHighlight,
    overlay: state.overlay,
    inspector: state.inspector,
    panGesture: state.panGesture,
    announcement: state.announcement,
    focusTarget: state.focusTarget,
    artifactBinding: state.artifactBinding,
  });
}

function restoreFrame(
  state: ViewerViewStateV1,
  frame: ViewerHierarchyFrameV1,
  remaining: readonly ViewerHierarchyFrameV1[],
): ViewerViewStateV1 {
  return freezeState({
    ...frame,
    hierarchyStack: Object.freeze([...remaining]),
  });
}

export function reduceViewerViewStateV1(
  circuitIr: ReviewedCircuitIrV1,
  state: ViewerViewStateV1,
  action: ViewerActionV1,
): ViewerViewStateV1 {
  switch (action.type) {
    case "fit": {
      const definition = resolveViewerOccurrenceDefinitionV1(
        circuitIr,
        state.occurrencePath,
      );
      return updated(state, {
        viewport: fitViewerViewportV1(definition.bounds, {
          width: state.viewport.widthCss,
          height: state.viewport.heightCss,
        }),
        announcement: "Viewport fitted",
      });
    }
    case "set-viewport":
      return updated(state, { viewport: freezeViewport(action.viewport) });
    case "zoom":
      return updated(state, {
        viewport: zoomAt(state.viewport, action.factor, action.anchorCss),
        announcement: "Viewport zoom changed",
      });
    case "keyboard-zoom": {
      const center = Object.freeze({
        x: state.viewport.widthCss / 2,
        y: state.viewport.heightCss / 2,
      });
      const factor =
        action.direction === "in"
          ? VIEWER_INTERACTION_CONTRACT_V1.keyboardZoomFactor
          : 1 / VIEWER_INTERACTION_CONTRACT_V1.keyboardZoomFactor;
      return updated(state, {
        viewport: zoomAt(state.viewport, factor, center),
        announcement: "Viewport zoom changed",
      });
    }
    case "pointer-down": {
      if (
        action.button !== "middle" &&
        !(action.button === "primary" && action.spaceKey)
      ) {
        return state;
      }
      if (!Number.isSafeInteger(action.pointerId)) {
        return fail("INVALID_ACTION", "Pointer identity is invalid.");
      }
      const point = freezePoint(action.pointCss, "pointer point");
      return updated(state, {
        panGesture: Object.freeze({
          pointerId: action.pointerId,
          phase: "pending",
          startCss: point,
          lastCss: point,
          originViewport: state.viewport,
        }),
      });
    }
    case "pointer-move": {
      const gesture = state.panGesture;
      if (gesture === null || gesture.pointerId !== action.pointerId) return state;
      const point = freezePoint(action.pointCss, "pointer point");
      const deltaX = point.x - gesture.startCss.x;
      const deltaY = point.y - gesture.startCss.y;
      const active =
        gesture.phase === "active" ||
        Math.hypot(deltaX, deltaY) >
          VIEWER_INTERACTION_CONTRACT_V1.panDragThresholdCssPx;
      return updated(state, {
        viewport: active
          ? panViewport(gesture.originViewport, deltaX, deltaY)
          : state.viewport,
        panGesture: Object.freeze({
          ...gesture,
          phase: active ? "active" : "pending",
          lastCss: point,
        }),
      });
    }
    case "pointer-up":
      return state.panGesture?.pointerId === action.pointerId
        ? updated(state, { panGesture: null })
        : state;
    case "wheel-pan": {
      const delta = finite(action.deltaCssPx, "wheel delta");
      return updated(state, {
        viewport: panViewport(
          state.viewport,
          action.shiftKey ? -delta : 0,
          action.shiftKey ? 0 : -delta,
        ),
      });
    }
    case "keyboard-pan": {
      const step = action.largeStep
        ? VIEWER_INTERACTION_CONTRACT_V1.keyboardPanLargeStepCssPx
        : VIEWER_INTERACTION_CONTRACT_V1.keyboardPanStepCssPx;
      const deltaX = action.direction === "left" ? -step : action.direction === "right" ? step : 0;
      const deltaY = action.direction === "up" ? -step : action.direction === "down" ? step : 0;
      return updated(state, {
        viewport: panViewport(state.viewport, deltaX, deltaY),
      });
    }
    case "primary-select": {
      if (action.target === null) {
        return updated(state, {
          selection: Object.freeze([]),
          announcement: "Selection cleared",
        });
      }
      const resolved = resolveViewerElementTargetV1(circuitIr, action.target);
      const binding = bindArtifact(state, targetBinding(resolved.target));
      const key = targetKey(resolved.target);
      const existingIndex = state.selection.findIndex(
        (entry) => targetKey(entry) === key,
      );
      const selection = action.ctrlKey
        ? existingIndex >= 0
          ? state.selection.filter((_entry, index) => index !== existingIndex)
          : [...state.selection, resolved.target]
        : [resolved.target];
      return updated(state, {
        selection: Object.freeze(selection),
        artifactBinding: binding,
        announcement: selection.length === 0 ? "Selection cleared" : "Selection changed",
      });
    }
    case "toggle-selection-net": {
      const candidates = new Map<string, ViewerNetTargetV1>();
      for (const selected of state.selection) {
        const resolved = resolveViewerElementTargetV1(circuitIr, selected);
        const netId = netForElement(resolved.definition, resolved.target);
        if (netId !== null) {
          const net = freezeNetTarget({
            artifactId: selected.artifactId,
            revisionId: selected.revisionId,
            occurrencePath: selected.occurrencePath,
            definitionId: selected.definitionId,
            netId,
          });
          candidates.set(JSON.stringify([net.occurrencePath, net.definitionId, net.netId]), net);
        }
      }
      if (candidates.size !== 1) {
        return updated(state, {
          announcement: "Selection does not resolve to one net",
        });
      }
      const candidate = [...candidates.values()][0];
      if (candidate === undefined) return state;
      const same =
        state.netHighlight !== null &&
        JSON.stringify(state.netHighlight) === JSON.stringify(candidate);
      return updated(state, {
        netHighlight: same ? null : candidate,
        announcement: same ? "Net highlight cleared" : "Net highlight changed",
      });
    }
    case "select-net": {
      const resolved = resolveViewerNetTargetV1(circuitIr, action.target);
      const binding = bindArtifact(state, targetBinding(resolved.target));
      return updated(state, {
        netHighlight: resolved.target,
        artifactBinding: binding,
        announcement: "Net highlight changed",
      });
    }
    case "admit-overlay": {
      const overlay = freezeOverlay(circuitIr, action.overlay);
      const binding = bindArtifact(state, bindingFromArtifactRef(overlay.artifactRef));
      return updated(state, {
        overlay,
        artifactBinding: binding,
        announcement: "Synthetic overlay admitted",
      });
    }
    case "clear-overlay":
      return updated(state, { overlay: null, announcement: "Synthetic overlay cleared" });
    case "open-inspector": {
      const resolved = resolveViewerElementTargetV1(circuitIr, action.target);
      const binding = bindArtifact(state, targetBinding(resolved.target));
      return updated(state, {
        inspector: Object.freeze({
          target: resolved.target,
          mode: state.viewport.widthCss >= 720 ? "dock" : "modal",
        }),
        artifactBinding: binding,
      });
    }
    case "close-inspector":
      return updated(state, { inspector: null, focusTarget: "canvas" });
    case "enter-hierarchy": {
      const definition = resolveViewerOccurrenceDefinitionV1(
        circuitIr,
        state.occurrencePath,
      );
      const instance = definition.instances.find(
        (candidate) => candidate.instanceId === action.instanceId,
      );
      if (instance === undefined) {
        return fail("INVALID_TARGET", "Hierarchy instance is unavailable.");
      }
      if (instance.blackbox === true || instance.childDefinitionId === undefined) {
        return updated(state, { announcement: "Blackbox child unavailable" });
      }
      if (state.occurrencePath.length >= VIEWER_OCCURRENCE_DEPTH_LIMIT_V1) {
        return fail("HIERARCHY_DEPTH_EXCEEDED", "Hierarchy depth is exceeded.");
      }
      const nextPath = Object.freeze([...state.occurrencePath, instance.instanceId]);
      const child = resolveViewerOccurrenceDefinitionV1(circuitIr, nextPath);
      return freezeState({
        ...state,
        viewport: fitViewerViewportV1(child.bounds, {
          width: state.viewport.widthCss,
          height: state.viewport.heightCss,
        }),
        occurrencePath: nextPath,
        selection: Object.freeze([]),
        netHighlight: null,
        overlay: null,
        inspector: null,
        panGesture: null,
        hierarchyStack: Object.freeze([
          ...state.hierarchyStack,
          hierarchyFrame(state),
        ]),
        announcement: "Entered hierarchy",
        focusTarget: "canvas",
      });
    }
    case "back-hierarchy": {
      const frame = state.hierarchyStack[state.hierarchyStack.length - 1];
      if (frame === undefined) return state;
      return restoreFrame(state, frame, state.hierarchyStack.slice(0, -1));
    }
    case "breadcrumb-hierarchy": {
      if (
        !Number.isSafeInteger(action.depth) ||
        action.depth < 0 ||
        action.depth >= state.hierarchyStack.length
      ) {
        return fail("INVALID_ACTION", "Breadcrumb depth is invalid.");
      }
      const frame = state.hierarchyStack[action.depth];
      if (frame === undefined) return fail("INVALID_ACTION", "Breadcrumb is unavailable.");
      return restoreFrame(state, frame, state.hierarchyStack.slice(0, action.depth));
    }
    case "escape":
      if (state.inspector !== null) {
        return updated(state, { inspector: null, focusTarget: "canvas" });
      }
      if (state.overlay !== null) {
        return updated(state, { overlay: null, focusTarget: "canvas" });
      }
      if (state.netHighlight !== null) {
        return updated(state, { netHighlight: null, focusTarget: "canvas" });
      }
      if (state.selection.length > 0) {
        return updated(state, {
          selection: Object.freeze([]),
          focusTarget: "canvas",
        });
      }
      return state;
  }
}
