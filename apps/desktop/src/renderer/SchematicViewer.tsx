import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { bindSchematicWheel } from "./schematic/schematic-wheel";
import {fitSchematicVisibleBounds, measureSchematicTextBounds} from './schematic/schematic-visible-fit';
import {elementsInSchematicBox, schematicBoxZoomIn, schematicDragBox, type SchematicDragBox} from "./schematic/schematic-box-gestures";
import {schematicCanvasHitTargets, hitTestSchematicCanvas} from './schematic/schematic-canvas-hit';
import {
  SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1,
  SAFE_SVG_PRIMITIVE_ALLOWLIST_V1,
  buildSafeSvgSceneV1,
  hitTestSafeSvgSceneV1,
} from "../../../../packages/schematic-workbench/src/viewer/svg-scene";

export const SCHEMATIC_VIEWER_ACCESSIBILITY_CONTRACT_V1 = Object.freeze({
  canvasTabIndex: 0,
  entityTreeRole: "tree",
  netListRole: "listbox",
  liveRegionPoliteness: "polite",
  inspectorDockMinWidthCssPx: 720,
  inspectorModalMaxWidthRatio: 0.7,
  tabCycleKeys: Object.freeze(["Ctrl+Tab", "Ctrl+Shift+Tab"]),
  tabRovingKeys: Object.freeze([
    "ArrowLeft",
    "ArrowRight",
    "Enter",
    "Space",
  ]),
  canvasKeys: Object.freeze([
    "F",
    "+",
    "-",
    "ArrowKeys",
    "H",
    "Enter",
    "Alt+Left",
  ]),
  escapeOrder: Object.freeze(["inspector", "overlay", "net", "selection"]),
});

type SafeSceneInputV1 = Parameters<typeof buildSafeSvgSceneV1>[0];
type SafeSceneV1 = ReturnType<typeof buildSafeSvgSceneV1>;
type ViewerSceneV1 = Pick<SafeSceneV1, 'viewport' | 'hitTargets' | 'geometryVisible' | 'historicalWarningVisible' | 'overlayVisible' | 'overlayLocalErrorVisible'> & Readonly<{primitives: readonly PrimitiveSnapshotV1[]}>;
type HitTargetV1 = NonNullable<
  ReturnType<typeof hitTestSafeSvgSceneV1>
>["target"];

export type SchematicViewerActionV1 =
  | Readonly<{ type: "resize-css"; width: number; height: number; fit: boolean }>
  | Readonly<{ type: "fit"; viewport?: SafeSceneInputV1['viewState']['viewport'] }>
  | Readonly<{ type: 'zoom-box'; viewport: SafeSceneInputV1['viewState']['viewport'] }>
  | Readonly<{
      type: "zoom-css";
      factor: number;
      anchorCss: Readonly<{ x: number; y: number }>;
    }>
  | Readonly<{
      type: "pan-css";
      deltaCss: Readonly<{ x: number; y: number }>;
    }>
  | Readonly<{
      type: "primary-select";
      target: HitTargetV1 | null;
      ctrlKey: boolean;
    }>
  | Readonly<{ type: "open-inspector"; target: HitTargetV1 }>
  | Readonly<{ type: "marquee-select"; targets: readonly HitTargetV1[]; ctrlKey: boolean }>
  | Readonly<{ type: "toggle-selection-net" }>
  | Readonly<{ type: "enter-selection" }>
  | Readonly<{ type: "hierarchy-back" }>
  | Readonly<{ type: "hierarchy-breadcrumb"; depth: number }>
  | Readonly<{ type: "close-inspector" }>
  | Readonly<{ type: "escape-highest-priority" }>
  | Readonly<{
      type: "select-net-from-list";
      definitionId: string;
      occurrencePath: readonly string[];
      netId: string;
    }>;

export type SchematicViewerProps = Readonly<{
  reviewedPresentation?: Readonly<{
    title: string;
    scene: ViewerSceneV1;
    elementLabels: Readonly<Record<string, string>>;
    netLabels: Readonly<Record<string, string>>;
    inspector: ReactNode;
    toolbar?: ReactNode;
  }>;
  fitOnMount?: boolean;
  compact?: boolean;
  circuitIr: SafeSceneInputV1["circuitIr"];
  artifactRef: SafeSceneInputV1["artifactRef"];
  viewState: SafeSceneInputV1["viewState"];
  renderState: SafeSceneInputV1["renderState"];
  onAction: (action: SchematicViewerActionV1) => void;
}>;

type PrimitiveSnapshotV1 = Readonly<{
  tag: string;
  target?: HitTargetV1 | null;
  attributes: Readonly<Record<string, unknown>>;
  styleToken?: unknown;
  text?: unknown;
  textContent?: unknown;
}>;

type DragSnapshotV1 = {
  pointerId: number;
  button: number;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
  moved: boolean;
  ctrlKey: boolean;
};

const PERSISTENT_BANNER =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED";
const OVERLAY_BANNER = "SYNTHETIC OVERLAY · NO AGENT";
const DRAG_THRESHOLD_CSS_PX = 3;
const HIT_TOLERANCE_CSS_PX = 6;
const KEYBOARD_ZOOM_FACTOR = 1.2;
const KEYBOARD_PAN_CSS_PX = 40;
const KEYBOARD_PAN_LARGE_CSS_PX = 120;

function safePrimitiveAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean | undefined> {
  const result: Record<string, string | number | boolean | undefined> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (
      !SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1.includes(
        name as (typeof SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1)[number],
      )
    ) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      result[name] = value;
    }
  }
  return result;
}

function primitivePlainText(primitive: PrimitiveSnapshotV1): string | undefined {
  if (typeof primitive.text === "string") return primitive.text;
  if (typeof primitive.textContent === "string") return primitive.textContent;
  return undefined;
}

function primitiveStyleClass(styleToken: unknown): string | null {
  switch (styleToken) {
    case "base-instance":
    case "base-terminal":
    case "base-wire":
    case "base-label":
    case "net-highlight":
    case "synthetic-accent":
    case "synthetic-warning":
    case "synthetic-muted":
    case "selection-highlight":
    case "keyboard-focus":
      return `schematic-primitive schematic-primitive-${styleToken}`;
    default:
      return null;
  }
}

function applyNonScalingTextTransform(
  attributes: Record<string, string | number | boolean | undefined>,
  viewportZoom: number,
): boolean {
  const x = attributes.x;
  const y = attributes.y;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(viewportZoom) ||
    viewportZoom < 0.1 ||
    viewportZoom > 32
  ) {
    return false;
  }
  const inverseZoom = 1 / viewportZoom;
  const orientation = typeof attributes.transform === 'string' ? `${attributes.transform} ` : '';
  attributes.transform = `${orientation}translate(${x} ${y}) scale(${inverseZoom}) translate(${-x} ${-y})`;
  return true;
}

function renderPrimitive(
  primitive: PrimitiveSnapshotV1,
  key: string,
  viewportZoom: number,
  nonScalingText = true,
): ReactElement | null {
  const snapshot = primitive as PrimitiveSnapshotV1;
  if (
    !SAFE_SVG_PRIMITIVE_ALLOWLIST_V1.includes(
      snapshot.tag as (typeof SAFE_SVG_PRIMITIVE_ALLOWLIST_V1)[number],
    )
  ) {
    return null;
  }
  if (snapshot.tag === "svg") return null;
  const attributes = safePrimitiveAttributes(snapshot.attributes);
  const styleClass = primitiveStyleClass(snapshot.styleToken);
  if (styleClass === null) return null;
  attributes.className = snapshot.tag === 'text' && !nonScalingText ? `${styleClass} schematic-reviewed-text` : styleClass;
  const text = primitivePlainText(snapshot);
  if (
    snapshot.tag === "text" && nonScalingText &&
    !applyNonScalingTextTransform(attributes, viewportZoom)
  ) {
    return null;
  }

  switch (snapshot.tag) {
    case "circle":
      return <circle key={key} {...attributes} />;
    case "g":
      return <g key={key} {...attributes} />;
    case "line":
      return <line key={key} {...attributes} />;
    case "path":
      return <path key={key} {...attributes} />;
    case "polyline":
      return <polyline key={key} {...attributes} />;
    case "rect":
      return <rect key={key} {...attributes} />;
    case "text":
      return (
        <text key={key} {...attributes}>
          {text}
        </text>
      );
    default:
      return null;
  }
}

function statusText(renderState: SchematicViewerProps["renderState"], reviewed = false): string {
  switch (renderState.status) {
    case "loading":
      return reviewed ? "正在验证原理图导出版本；尚未显示原理图。" : "正在验证合成 fixture；尚未显示原理图。";
    case "ready":
      return renderState.freshness === "historical"
        ? "正在显示已验证的历史 revision；未连接 EDA。"
        : reviewed ? "正在显示已核验的当前原理图导出版本；仅可查看。" : "正在显示已验证的当前 synthetic revision；仅可查看。";
    case "unverified":
      return "无法验证 reviewed 身份；内容未显示。";
    case "error":
      return "原理图无法安全显示；未执行文件或 EDA 操作。";
    case "revoked":
      return "此 reviewed revision 已撤销；内容未显示。";
    case "quarantined":
      return "此 reviewed revision 已隔离；内容未显示。";
  }
}

function occurrencePathFromViewState(viewState: unknown): readonly string[] {
  if (viewState === null || typeof viewState !== "object") return [];
  const value = (viewState as { occurrencePath?: unknown }).occurrencePath;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function currentDefinition(
  circuitIr: SchematicViewerProps["circuitIr"],
  occurrencePath: readonly string[],
) {
  const definitions = new Map(
    circuitIr.definitions.map((definition) => [definition.definitionId, definition]),
  );
  let definition = definitions.get(circuitIr.rootDefinitionId);
  if (definition === undefined) return undefined;
  for (const instanceId of occurrencePath) {
    const instance = definition.instances.find(
      (candidate) => candidate.instanceId === instanceId,
    );
    if (
      instance === undefined ||
      instance.blackbox === true ||
      instance.childDefinitionId === undefined
    ) {
      return undefined;
    }
    definition = definitions.get(instance.childDefinitionId);
    if (definition === undefined) return undefined;
  }
  return definition;
}

function elementRows(
  definition: NonNullable<ReturnType<typeof currentDefinition>>,
  artifactRef: SchematicViewerProps["artifactRef"],
  occurrencePath: readonly string[],
): readonly Readonly<{
  key: string;
  label: string;
  target: HitTargetV1;
}>[] {
  const base = {
    artifactId: artifactRef.artifactId,
    revisionId: artifactRef.revisionId,
    occurrencePath,
    definitionId: definition.definitionId,
  } as const;
  return [
    ...definition.ports.map((port) => ({
      key: `port-${port.portId}`,
      label: `Port ${port.portId}`,
      target: { ...base, elementKind: "port" as const, elementId: port.portId },
    })),
    ...(definition.pins ?? []).map((pin) => ({
      key: `pin-${pin.pinId}`,
      label: `Pin ${pin.pinId}`,
      target: { ...base, elementKind: "pin" as const, elementId: pin.pinId },
    })),
    ...definition.instances.map((instance) => ({
      key: `instance-${instance.instanceId}`,
      label: instance.blackbox === true
        ? `Instance ${instance.instanceId} · Blackbox unavailable`
        : `Instance ${instance.instanceId}`,
      target: {
        ...base,
        elementKind: "instance" as const,
        elementId: instance.instanceId,
      },
    })),
    ...definition.wires.map((wire) => ({
      key: `wire-${wire.wireId}`,
      label: `Wire ${wire.wireId}`,
      target: { ...base, elementKind: "wire" as const, elementId: wire.wireId },
    })),
    ...definition.labels.map((label) => ({
      key: `label-${label.labelId}`,
      label: `Label ${label.text}`,
      target: { ...base, elementKind: "label" as const, elementId: label.labelId },
    })),
  ];
}

function viewportCenter(event: KeyboardEvent<SVGSVGElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: bounds.width / 2, y: bounds.height / 2 };
}

function sameOccurrencePath(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function sameElementTarget(
  left: HitTargetV1,
  right: HitTargetV1,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.revisionId === right.revisionId &&
    sameOccurrencePath(left.occurrencePath, right.occurrencePath) &&
    left.definitionId === right.definitionId &&
    left.elementKind === right.elementKind &&
    left.elementId === right.elementId
  );
}

export function SchematicViewer({
  circuitIr,
  artifactRef,
  viewState,
  renderState,
  onAction: emitAction,
  fitOnMount = true,
  compact = false,
  reviewedPresentation,
}: SchematicViewerProps): ReactElement {
  const liveRegionId = useId();
  const inspectorId = useId();
  const [entityFocusIndex, setEntityFocusIndex] = useState(0);
  const [netFocusIndex, setNetFocusIndex] = useState(0);
  const [dragBox, setDragBox] = useState<(SchematicDragBox & {mode: 'select' | 'zoom-in'}) | null>(null);
  const [contextMenu, setContextMenu] = useState<{x: number; y: number} | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const entityItemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const netItemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const fittedView = useRef(fitOnMount);
  const onAction = (action: SchematicViewerActionV1) => {
    if (action.type === 'zoom-css' || action.type === 'pan-css' || action.type === 'zoom-box') fittedView.current = false;
    if (action.type === 'fit') fittedView.current = true;
    emitAction(action);
  };
  const actionRef = useRef(onAction); actionRef.current = onAction;
  const fitRef = useRef<(size?: {width: number; height: number}) => void>(() => {});
  const fitOnMountRef = useRef(fitOnMount);
  const viewerRef = useRef<HTMLElement | null>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement | null>(null);
  const inspectorCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [emptyInspectorOpen, setEmptyInspectorOpen] = useState(false);
  const inspectorVisible = viewState.inspector !== null || emptyInspectorOpen;
  const restoreInspectorToggleFocus = useRef(false);
  const [inspectorLayoutMode, setInspectorLayoutMode] = useState<"dock" | "modal">(
    compact || viewState.viewport.widthCss >=
      SCHEMATIC_VIEWER_ACCESSIBILITY_CONTRACT_V1.inspectorDockMinWidthCssPx
      ? "dock"
      : "modal",
  );
  const spaceHeld = useRef(false);
  const drag = useRef<DragSnapshotV1 | null>(null);
  const scene = useMemo(
    () =>
      reviewedPresentation?.scene ?? buildSafeSvgSceneV1({
        circuitIr,
        artifactRef,
        viewState,
        renderState,
      }),
    [artifactRef, circuitIr, renderState, viewState, reviewedPresentation?.scene],
  );
  const symbolHitTargets = useMemo(() => schematicCanvasHitTargets(scene, !!reviewedPresentation), [scene, !!reviewedPresentation]);
  const occurrencePath = occurrencePathFromViewState(viewState);
  const definition = currentDefinition(circuitIr, occurrencePath);
  const rows =
    definition === undefined
      ? []
      : elementRows(definition, artifactRef, occurrencePath);
  const nets = definition?.nets ?? [];
  const activeEntityFocusIndex =
    rows.length === 0 ? 0 : Math.min(entityFocusIndex, rows.length - 1);
  const activeNetFocusIndex =
    nets.length === 0 ? 0 : Math.min(netFocusIndex, nets.length - 1);
  const toolbarZoomAnchor = {
    x: viewState.viewport.widthCss / 2,
    y: viewState.viewport.heightCss / 2,
  };
  const geometryVisible = scene.geometryVisible === true;
  useEffect(() => {
    if (!contextMenu) return;
    const menu = contextMenuRef.current;
    if (menu) {
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(6, Math.min(contextMenu.x, window.innerWidth - bounds.width - 6))}px`;
      menu.style.top = `${Math.max(6, Math.min(contextMenu.y, window.innerHeight - bounds.height - 6))}px`;
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    const outside = (event: globalThis.PointerEvent) => {if (!menu?.contains(event.target as Node)) setContextMenu(null);};
    const close = () => setContextMenu(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('blur', close); window.addEventListener('resize', close);
    return () => {document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', close); window.removeEventListener('resize', close);};
  }, [contextMenu]);
  fitRef.current = size => {
    const canvas = canvasRef.current;
    if (reviewedPresentation && geometryVisible && definition && canvas) {
      const rect = canvas.getBoundingClientRect();
      const viewport = fitSchematicVisibleBounds(definition.bounds, measureSchematicTextBounds(canvas, scene.viewport), size ?? {width: rect.width, height: rect.height});
      if (viewport) {onAction({type: 'fit', viewport}); return;}
    }
    onAction({type: 'fit'});
  };
  const reviewedRef = useRef(!!reviewedPresentation); reviewedRef.current = !!reviewedPresentation;
  const identityLabel = reviewedPresentation ? `${reviewedPresentation.title} · 只读` : compact ? '合成原理图 · 只读' : PERSISTENT_BANNER;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geometryVisible) return;
    return bindSchematicWheel(canvas, (factor, anchorCss) => {
      drag.current = null;
      setDragBox(null);
      actionRef.current({type: 'zoom-css', factor, anchorCss});
    });
  }, [geometryVisible]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !geometryVisible) return;
    let measured = false, previousWidth = 0, previousHeight = 0;
    const measure = () => {
      const {width,height} = canvas.getBoundingClientRect();
      if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height) || (width === previousWidth && height === previousHeight)) return;
      previousWidth = width; previousHeight = height;
      const fitVisible = reviewedRef.current && fittedView.current;
      actionRef.current({type:'resize-css',width,height,fit:!fitVisible && !measured && fitOnMountRef.current});
      if (fitVisible) fitRef.current({width, height});
      measured = true;
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(canvas);
    return () => observer.disconnect();
  }, [geometryVisible]);
  const overlayStatusVisible =
    scene.overlayVisible === true || scene.overlayLocalErrorVisible === true;
  const highlightedWireId = viewState.netHighlight
    ? definition?.wires.find(wire => wire.netId === viewState.netHighlight?.netId)?.wireId : undefined;
  const inspectorOpenTarget = viewState.selection[0]
    ?? rows.find(row => row.target.elementKind === 'wire' && row.target.elementId === highlightedWireId)?.target
    ?? rows[0]?.target;

  useEffect(() => {
    if (viewState.focusTarget === "canvas") {
      canvasRef.current?.focus({ preventScroll: true });
    }
  }, [viewState.focusTarget]);

  useEffect(() => {
    const node = viewerRef.current;
    if (node === null) return;
    const updateMode = (): void => {
      const width = node.getBoundingClientRect().width;
      if (!Number.isFinite(width) || width <= 0) return;
      setInspectorLayoutMode(
        !compact && width <
          SCHEMATIC_VIEWER_ACCESSIBILITY_CONTRACT_V1.inspectorDockMinWidthCssPx
          ? "modal"
          : "dock",
      );
    };
    updateMode();
    const observer = new ResizeObserver(updateMode);
    observer.observe(node);
    return () => observer.disconnect();
  }, [compact]);

  useEffect(() => {
    if (inspectorVisible || !restoreInspectorToggleFocus.current) {
      return;
    }
    restoreInspectorToggleFocus.current = false;
    (inspectorToggleRef.current ?? canvasRef.current)?.focus({ preventScroll: true });
  }, [inspectorVisible]);

  useEffect(() => {
    if (!inspectorVisible || inspectorLayoutMode !== "modal") return;
    const inspector = inspectorRef.current;
    if (inspector === null) return;
    const background: Array<Readonly<{ node: Element; wasInert: boolean }>> = [];
    let branch: Element = inspector;
    while (branch.parentElement !== null) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch) continue;
        background.push({ node: sibling, wasInert: sibling.hasAttribute("inert") });
        sibling.setAttribute("inert", "");
      }
      if (parent === document.body) break;
      branch = parent;
    }
    const keepFocusInside = (event: FocusEvent): void => {
      if (event.target instanceof Node && !inspector.contains(event.target)) {
        inspectorCloseButtonRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    inspectorCloseButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("focusin", keepFocusInside);
      for (const { node, wasInert } of background) {
        if (!wasInert) node.removeAttribute("inert");
      }
    };
  }, [inspectorLayoutMode, inspectorVisible]);

  useEffect(() => {
    setEmptyInspectorOpen(false);
    setContextMenu(null);
    drag.current = null;
    setDragBox(null);
  }, [artifactRef.artifactId, artifactRef.revisionId, geometryVisible]);

  const closeInspector = (): void => {
    if (!inspectorVisible) return;
    restoreInspectorToggleFocus.current = true;
    setEmptyInspectorOpen(false);
    if (viewState.inspector !== null) onAction({ type: "close-inspector" });
  };
  const toggleInspector = (): void => {
    if (inspectorVisible) {closeInspector(); return;}
    if (inspectorOpenTarget !== undefined) onAction({type: 'open-inspector', target: inspectorOpenTarget});
    else setEmptyInspectorOpen(true);
  };

  const pointInCanvas = (
    clientX: number,
    clientY: number,
    node: SVGSVGElement,
  ) => {
    const bounds = node.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  };

  const handleCanvasKeyDown = (event: KeyboardEvent<SVGSVGElement>): void => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
    ) {
      return;
    }
    if (compact && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect();
      setContextMenu({x: bounds.left + 16, y: bounds.top + 16}); return;
    }
    if (event.key === " ") {
      spaceHeld.current = true;
      event.preventDefault();
      return;
    }
    if (event.key.toLowerCase() === "f" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      drag.current = null;
      setDragBox(null);
      fitRef.current();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      onAction({
        type: "zoom-css",
        factor: KEYBOARD_ZOOM_FACTOR,
        anchorCss: viewportCenter(event),
      });
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      onAction({
        type: "zoom-css",
        factor: 1 / KEYBOARD_ZOOM_FACTOR,
        anchorCss: viewportCenter(event),
      });
      return;
    }
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      onAction({ type: "hierarchy-back" });
      return;
    }
    if (event.key.startsWith("Arrow")) {
      const amount = event.shiftKey
        ? KEYBOARD_PAN_LARGE_CSS_PX
        : KEYBOARD_PAN_CSS_PX;
      const delta =
        event.key === "ArrowLeft"
          ? { x: amount, y: 0 }
          : event.key === "ArrowRight"
            ? { x: -amount, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: amount }
              : { x: 0, y: -amount };
      event.preventDefault();
      onAction({ type: "pan-css", deltaCss: delta });
      return;
    }
    if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      onAction({ type: "toggle-selection-net" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onAction({ type: "enter-selection" });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (drag.current !== null) {
        drag.current = null;
        setDragBox(null);
        return;
      }
      if (inspectorVisible) {
        closeInspector();
        return;
      }
      onAction({ type: "escape-highest-priority" });
    }
  };

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    const panButton = event.button === 1 || (event.button === 0 && spaceHeld.current);
    if (!panButton && event.button !== 0 && event.button !== 2) return;
    if (drag.current !== null) return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll: true});
    setContextMenu(null);
    setDragBox(null);
    drag.current = {
      pointerId: event.pointerId,
      button: event.button,
      originX: event.clientX,
      originY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      panning: panButton,
      moved: false,
      ctrlKey: event.ctrlKey,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - current.originX,
      event.clientY - current.originY,
    );
    current.moved ||= distance > DRAG_THRESHOLD_CSS_PX;
    if (current.panning && current.moved) {
      const delta = {
        x: event.clientX - current.lastX,
        y: event.clientY - current.lastY,
      };
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      onAction({ type: "pan-css", deltaCss: delta });
    } else if (current.moved) {
      const box = schematicDragBox(
        pointInCanvas(current.originX, current.originY, event.currentTarget),
        pointInCanvas(event.clientX, event.clientY, event.currentTarget),
        scene.viewport,
      );
      setDragBox({...box, mode: current.button === 2 ? 'zoom-in' : 'select'});
    }
  };

  const handlePointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragBox(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (
      current.panning
    ) {
      return;
    }
    const distance = Math.hypot(
      event.clientX - current.originX,
      event.clientY - current.originY,
    );
    if (current.moved || distance > DRAG_THRESHOLD_CSS_PX) {
      const box = schematicDragBox(
        pointInCanvas(current.originX, current.originY, event.currentTarget),
        pointInCanvas(event.clientX, event.clientY, event.currentTarget),
        scene.viewport,
      );
      if (box.width < DRAG_THRESHOLD_CSS_PX || box.height < DRAG_THRESHOLD_CSS_PX) return;
      if (current.button === 2) {
        const action = schematicBoxZoomIn(box, scene.viewport);
        if (action) onAction(action);
      } else {
        onAction({type: 'marquee-select', targets: elementsInSchematicBox({...scene, hitTargets: symbolHitTargets}, box), ctrlKey: current.ctrlKey});
      }
      return;
    }
    if (current.button === 2 && compact) {setContextMenu({x: event.clientX, y: event.clientY}); return;}
    if (current.button !== 0) return;
    const hit = hitTestSchematicCanvas({...scene, hitTargets: symbolHitTargets}, pointInCanvas(
        event.clientX,
        event.clientY,
        event.currentTarget,
      ), HIT_TOLERANCE_CSS_PX, !!reviewedPresentation);
    onAction({
      type: "primary-select",
      target: hit?.target ?? null,
      ctrlKey: current.ctrlKey,
    });
  };

  const moveRovingFocus = (
    event: KeyboardEvent<HTMLElement>,
    currentIndex: number,
    count: number,
    update: (index: number) => void,
    itemRefs: Readonly<{ current: Array<HTMLLIElement | null> }>,
  ): void => {
    if (count === 0) return;
    const direction =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    const nextIndex = (currentIndex + direction + count) % count;
    update(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  };

  return (
    <section
      aria-label="只读原理图内容"
      className={`schematic-viewer${compact?' schematic-viewer-compact':''}`}
      data-view-zoom={viewState.viewport.zoom}
      data-selection-count={viewState.selection.length}
      data-net-id={viewState.netHighlight?.netId??''}
      ref={viewerRef}
    >
      <p className="schematic-viewer-identity">
        {identityLabel}
        {overlayStatusVisible ? ` · ${OVERLAY_BANNER}` : ""}
        {scene.historicalWarningVisible === true ? (
          <span className="schematic-historical-warning">Historical revision · 只读历史快照</span>
        ) : null}
        {compact && geometryVisible && <button type="button" className="schematic-details-toggle"
          aria-label="原理图详情" aria-controls={inspectorId} aria-expanded={inspectorVisible}
          ref={inspectorToggleRef} onClick={toggleInspector}>详情</button>}
      </p>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="schematic-viewer-a11y-status"
        id={liveRegionId}
      >
        {identityLabel}. {overlayStatusVisible ? `${OVERLAY_BANNER}. ` : ""}
        {scene.historicalWarningVisible === true
          ? "Historical revision · 只读历史快照. "
          : ""}
        {statusText(renderState, !!reviewedPresentation)}
        {viewState.announcement === null ? "" : ` ${viewState.announcement}`}
      </p>

      {geometryVisible ? (
        <div
          className={`schematic-viewer-ready${
            !inspectorVisible
              ? ""
              : " schematic-viewer-ready-with-inspector"
          }`}
        >
          {(!compact || contextMenu) && <div aria-label={compact ? '原理图右键菜单' : '只读原理图操作'}
            role={compact ? 'dialog' : undefined} ref={contextMenuRef}
            className={compact ? 'schematic-context-menu' : 'schematic-viewer-toolbar'}
            style={compact && contextMenu ? {left: contextMenu.x, top: contextMenu.y} : undefined}
            onClick={event => {if (compact && (event.target as HTMLElement).closest('button:not(:disabled)')) {setContextMenu(null); canvasRef.current?.focus({preventScroll: true});}}}
            onKeyDown={event => {
              if (!compact) return;
              if (event.key === 'Escape') {event.preventDefault(); setContextMenu(null); canvasRef.current?.focus();}
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
              }
            }}>
            <button onClick={() => fitRef.current()} type="button">
              适合窗口
            </button>
            <button
              onClick={() =>
                onAction({
                  type: "zoom-css",
                  factor: 1 / KEYBOARD_ZOOM_FACTOR,
                  anchorCss: toolbarZoomAnchor,
                })
              }
              type="button"
            >
              缩小
            </button>
            <button
              onClick={() =>
                onAction({
                  type: "zoom-css",
                  factor: KEYBOARD_ZOOM_FACTOR,
                  anchorCss: toolbarZoomAnchor,
                })
              }
              type="button"
            >
              放大
            </button>
            <button
              aria-controls={inspectorId}
              aria-expanded={inspectorVisible}
              className="schematic-inspector-toggle"
              onClick={toggleInspector}
              ref={compact ? undefined : inspectorToggleRef}
              title={
                inspectorVisible
                  ? "关闭检查器"
                  : inspectorOpenTarget === undefined
                    ? "查看只读定义与网络信息"
                    : "打开只读检查器"
              }
              type="button"
            >
              详情
            </button>
            {reviewedPresentation?.toolbar}
            <nav aria-label="原理图层次" className="schematic-breadcrumb">
              <button
                aria-current={occurrencePath.length === 0 ? "location" : undefined}
                disabled={occurrencePath.length === 0}
                onClick={() => onAction({ type: "hierarchy-breadcrumb", depth: 0 })}
                type="button"
              >
                Root
              </button>
              {occurrencePath.map((segment, index) => (
                <button
                  aria-current={
                    index === occurrencePath.length - 1 ? "location" : undefined
                  }
                  disabled={index === occurrencePath.length - 1}
                  key={`breadcrumb-${index}`}
                  onClick={() =>
                    onAction({ type: "hierarchy-breadcrumb", depth: index + 1 })
                  }
                  type="button"
                >
                  {segment}
                </button>
              ))}
            </nav>
          </div>}

          <svg
            aria-describedby={liveRegionId}
            aria-label={reviewedPresentation ? `${reviewedPresentation.title} 原理图画布` : "Synthetic reviewed schematic canvas"}
            data-schematic-canvas="true"
            height="100%"
            onKeyDown={handleCanvasKeyDown}
            onKeyUp={(event) => {
              if (event.key === " ") spaceHeld.current = false;
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragBox(null);
            }}
            onLostPointerCapture={() => {drag.current = null; setDragBox(null);}}
            onBlur={() => {spaceHeld.current = false; drag.current = null; setDragBox(null);}}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            role="img"
            ref={canvasRef}
            tabIndex={SCHEMATIC_VIEWER_ACCESSIBILITY_CONTRACT_V1.canvasTabIndex}
            width="100%"
          >
            {compact && <title>右键打开操作菜单；左键框选器件、导线和网名；右键拖框放大；F 全图</title>}
            <g
              transform={`matrix(${scene.viewport.zoom} 0 0 ${scene.viewport.zoom} ${scene.viewport.translateXCss} ${scene.viewport.translateYCss})`}
            >
              {scene.primitives.map((primitive, index) =>
                renderPrimitive(
                  primitive,
                  `primitive-${index}`,
                  scene.viewport.zoom,
                  !reviewedPresentation,
                ),
              )}
            </g>
            {dragBox ? <rect
              data-schematic-drag-box={dragBox.mode}
              x={dragBox.x} y={dragBox.y} width={dragBox.width} height={dragBox.height}
              fill="rgba(110, 110, 110, 0.08)" stroke="#777" strokeWidth={1}
              strokeDasharray={dragBox.mode === 'zoom-in' ? '5 3' : undefined}
              pointerEvents="none" aria-hidden="true"
            /> : null}
          </svg>

          {inspectorVisible ? (
          <aside
            aria-modal={
              inspectorLayoutMode === "modal"
                ? true
                : undefined
            }
            aria-label="只读 Inspector"
            className={`schematic-inspector${
              inspectorLayoutMode === "modal"
                ? " schematic-inspector-modal"
                : ""
            }`}
            data-inspector-mode={
              inspectorLayoutMode
            }
            id={inspectorId}
            ref={inspectorRef}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeInspector();
                return;
              }
              if (event.key === "Tab" && inspectorLayoutMode === "modal") {
                const candidates = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), summary, [tabindex]"))
                  .filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0);
                const first = candidates[0];
                const last = candidates[candidates.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus({ preventScroll: true });
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus({ preventScroll: true });
                }
              }
            }}
            role={
              inspectorLayoutMode === "modal"
                ? "dialog"
                : undefined
            }
          >
            <div className="schematic-inspector-heading">
              <h3>对象详情 · 只读</h3>
              <button
                aria-label="关闭 Inspector"
                onClick={closeInspector}
                ref={inspectorCloseButtonRef}
                type="button"
              >
                关闭
              </button>
            </div>
            {inspectorLayoutMode === "modal" ? (
              <p className="schematic-inspector-identity">
                {identityLabel}
                {scene.historicalWarningVisible === true ? (
                  <span className="schematic-historical-warning">Historical revision · 只读历史快照</span>
                ) : null}
              </p>
            ) : null}
            <p>Definition: {definition?.definitionId ?? "unavailable"}</p>
            <p>Revision: {artifactRef.revisionId}</p>
            {reviewedPresentation?.inspector}
            <details open={reviewedPresentation ? undefined : true}>
            <summary>器件与网络列表</summary>
            <ul aria-label="Occurrence entities" aria-readonly="true" role="tree">
              {rows.map((row, index) => {
                const selected = viewState.selection.some((target) =>
                  sameElementTarget(target, row.target),
                );
                return (
                  <li
                    aria-selected={selected}
                    key={`entity-${index}`}
                    onClick={() =>
                      onAction({
                        type: "primary-select",
                        target: row.target,
                        ctrlKey: false,
                      })
                    }
                    onFocus={() => setEntityFocusIndex(index)}
                    onKeyDown={(event) => {
                      moveRovingFocus(
                        event,
                        activeEntityFocusIndex,
                        rows.length,
                        setEntityFocusIndex,
                        entityItemRefs,
                      );
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onAction({
                          type: "primary-select",
                          target: row.target,
                          ctrlKey: event.ctrlKey,
                        });
                      }
                    }}
                    ref={(node) => {
                      entityItemRefs.current[index] = node;
                    }}
                    role="treeitem"
                    tabIndex={activeEntityFocusIndex === index ? 0 : -1}
                  >
                    {reviewedPresentation?.elementLabels[row.target.elementId] ?? row.label}
                  </li>
                );
              })}
            </ul>
            <ul aria-label="Occurrence nets" aria-readonly="true" role="listbox">
              {nets.map((net, index) => {
                const highlighted =
                  viewState.netHighlight !== null &&
                  viewState.netHighlight.artifactId === artifactRef.artifactId &&
                  viewState.netHighlight.revisionId === artifactRef.revisionId &&
                  sameOccurrencePath(
                    viewState.netHighlight.occurrencePath,
                    occurrencePath,
                  ) &&
                  viewState.netHighlight.definitionId === definition?.definitionId &&
                  viewState.netHighlight.netId === net.netId;
                return (
                  <li
                    aria-selected={highlighted}
                    key={`net-${index}`}
                    onClick={() =>
                      onAction({
                        type: "select-net-from-list",
                        definitionId: definition?.definitionId ?? "unavailable",
                        occurrencePath,
                        netId: net.netId,
                      })
                    }
                    onFocus={() => setNetFocusIndex(index)}
                    onKeyDown={(event) => {
                      moveRovingFocus(
                        event,
                        activeNetFocusIndex,
                        nets.length,
                        setNetFocusIndex,
                        netItemRefs,
                      );
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onAction({
                          type: "select-net-from-list",
                          definitionId: definition?.definitionId ?? "unavailable",
                          occurrencePath,
                          netId: net.netId,
                        });
                      }
                    }}
                    ref={(node) => {
                      netItemRefs.current[index] = node;
                    }}
                    role="option"
                    tabIndex={activeNetFocusIndex === index ? 0 : -1}
                  >
                    {reviewedPresentation?.netLabels[net.netId] ?? `Net ${net.netId}`}
                  </li>
                );
              })}
            </ul>
            </details>
          </aside>
          ) : null}
        </div>
      ) : (
        <section aria-label="Schematic unavailable" role="status">
          <h3>原理图内容未显示</h3>
          <p>{statusText(renderState, !!reviewedPresentation)}</p>
        </section>
      )}
    </section>
  );
}
