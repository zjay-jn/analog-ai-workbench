import { useEffect, useState, type ReactElement } from "react";
import type { ReviewedCircuitIrV1 } from "../packages/schematic-workbench/src/reviewed-circuit-ir";
import {
  createInitialViewerViewStateV1,
  reduceViewerViewStateV1,
  type ViewerActionV1,
  type ViewerElementTargetV1,
  type ViewerViewStateV1,
} from "../packages/schematic-workbench/src/viewer/view-state";
import type { SchematicViewerRenderStateV1 } from "../packages/schematic-workbench/src/viewer/svg-scene";
import {
  SchematicViewer,
  type SchematicViewerActionV1,
} from "../apps/desktop/src/renderer/SchematicViewer";
import {
  createReviewedArtifactHostControllerV1,
  type RendererReviewedArtifactDeliveryV1,
  type ReviewedArtifactHostStateV1,
} from "../apps/desktop/src/renderer/schematic/reviewed-artifact-host";
import type { ResolveReviewedArtifactRequestV1 } from "../apps/desktop/src/shared/schematic/reviewed-artifact-resolve";

const PERSISTENT_BANNER =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED";

function exactScenario() {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "__AAW_P3D_SCENARIO__",
  );
  if (
    descriptor === undefined ||
    descriptor.configurable !== false ||
    descriptor.writable !== false ||
    descriptor.value === null ||
    typeof descriptor.value !== "object"
  ) {
    throw new Error("The immutable P3-D renderer scenario is unavailable.");
  }
  return descriptor.value as Window["__AAW_P3D_SCENARIO__"];
}

function targetFor(
  circuitIr: ReviewedCircuitIrV1,
  delivery: RendererReviewedArtifactDeliveryV1,
  preferred: "instance" | "wire" | "any",
): ViewerElementTargetV1 | null {
  const definition = circuitIr.definitions.find(
    (entry) => entry.definitionId === circuitIr.rootDefinitionId,
  );
  if (definition === undefined) return null;
  const candidates: Array<
    Readonly<{ elementKind: ViewerElementTargetV1["elementKind"]; elementId: string }>
  > = [];
  if (preferred !== "wire") {
    for (const instance of definition.instances) {
      candidates.push({ elementKind: "instance", elementId: instance.instanceId });
    }
  }
  if (preferred !== "instance") {
    for (const wire of definition.wires) {
      candidates.push({ elementKind: "wire", elementId: wire.wireId });
    }
  }
  for (const port of definition.ports) {
    candidates.push({ elementKind: "port", elementId: port.portId });
  }
  for (const label of definition.labels) {
    candidates.push({ elementKind: "label", elementId: label.labelId });
  }
  const selected = candidates[0];
  return selected === undefined
    ? null
    : Object.freeze({
        artifactId: delivery.artifactRef.artifactId,
        revisionId: delivery.artifactRef.revisionId,
        occurrencePath: Object.freeze([]),
        definitionId: definition.definitionId,
        elementKind: selected.elementKind,
        elementId: selected.elementId,
      });
}

function mapViewerAction(
  delivery: RendererReviewedArtifactDeliveryV1,
  state: ViewerViewStateV1,
  action: SchematicViewerActionV1,
): ViewerActionV1 | null {
  switch (action.type) {
    case "fit":
      return action;
    case "zoom-css":
      return {
        type: "zoom",
        factor: action.factor,
        anchorCss: action.anchorCss,
        source: "button",
      };
    case "pan-css":
      return {
        type: "set-viewport",
        viewport: {
          ...state.viewport,
          translateXCss: state.viewport.translateXCss + action.deltaCss.x,
          translateYCss: state.viewport.translateYCss + action.deltaCss.y,
        },
      };
    case "primary-select":
    case "toggle-selection-net":
      return action;
    case "enter-selection": {
      const selected = state.selection.length === 1 ? state.selection[0] : undefined;
      return selected?.elementKind === "instance"
        ? { type: "enter-hierarchy", instanceId: selected.elementId }
        : null;
    }
    case "hierarchy-back":
      return { type: "back-hierarchy" };
    case "hierarchy-breadcrumb":
      return { type: "breadcrumb-hierarchy", depth: action.depth };
    case "close-inspector":
      return { type: "close-inspector" };
    case "escape-highest-priority":
      return { type: "escape" };
    case "select-net-from-list":
      return {
        type: "select-net",
        target: {
          artifactId: delivery.artifactRef.artifactId,
          revisionId: delivery.artifactRef.revisionId,
          occurrencePath: action.occurrencePath,
          definitionId: action.definitionId,
          netId: action.netId,
        },
      };
  }
}

function initialScenarioState(
  delivery: RendererReviewedArtifactDeliveryV1,
): ViewerViewStateV1 {
  const scenario = exactScenario();
  let state = createInitialViewerViewStateV1(
    delivery.reviewedCircuitIr,
    { width: 720, height: 520 },
    delivery.artifactRef,
  );
  const target = targetFor(
    delivery.reviewedCircuitIr,
    delivery,
    scenario.presentation === "selection-net" ? "wire" : "instance",
  );
  if (target !== null && scenario.presentation === "selection-net") {
    state = reduceViewerViewStateV1(delivery.reviewedCircuitIr, state, {
      type: "primary-select",
      target,
      ctrlKey: false,
    });
    state = reduceViewerViewStateV1(delivery.reviewedCircuitIr, state, {
      type: "toggle-selection-net",
    });
  }
  if (target !== null && scenario.presentation === "inspector-hierarchy") {
    state = reduceViewerViewStateV1(delivery.reviewedCircuitIr, state, {
      type: "primary-select",
      target,
      ctrlKey: false,
    });
    state = reduceViewerViewStateV1(delivery.reviewedCircuitIr, state, {
      type: "open-inspector",
      target,
    });
  }
  if (target !== null && scenario.presentation === "overlay") {
    state = reduceViewerViewStateV1(delivery.reviewedCircuitIr, state, {
      type: "admit-overlay",
      overlay: Object.freeze({
        contractVersion: "aaw.synthetic-overlay/v1alpha1",
        overlayId: "overlay.p3d.synthetic.v1",
        artifactRef: delivery.artifactRef,
        targets: Object.freeze([
          Object.freeze({ target, styleToken: "synthetic-accent" as const }),
        ]),
      }),
    });
  }
  return state;
}

function ReadySchematic({
  delivery,
}: Readonly<{ delivery: RendererReviewedArtifactDeliveryV1 }>): ReactElement {
  const scenario = exactScenario();
  const [viewState, setViewState] = useState<ViewerViewStateV1>(() =>
    initialScenarioState(delivery),
  );
  const renderState: SchematicViewerRenderStateV1 = Object.freeze({
    status: "ready" as const,
    freshness: delivery.freshness,
  });
  return (
    <div
      data-p3d-artifact-id={delivery.artifactRef.artifactId}
      data-p3d-case-id={scenario.caseId}
      data-p3d-freshness={delivery.freshness}
      data-p3d-inspector-mode={viewState.inspector?.mode ?? "none"}
      data-p3d-terminal-state="ready"
    >
      <SchematicViewer
        artifactRef={delivery.artifactRef}
        circuitIr={delivery.reviewedCircuitIr}
        onAction={(action) => {
          setViewState((current) => {
            const reducerAction = mapViewerAction(delivery, current, action);
            if (reducerAction === null) return current;
            const next = reduceViewerViewStateV1(
              delivery.reviewedCircuitIr,
              current,
              reducerAction,
            );
            return action.type === "primary-select" && action.target !== null
              ? reduceViewerViewStateV1(
                  delivery.reviewedCircuitIr,
                  next,
                  { type: "open-inspector", target: action.target },
                )
              : next;
          });
        }}
        renderState={renderState}
        viewState={viewState}
      />
    </div>
  );
}

function hostText(state: ReviewedArtifactHostStateV1): string {
  switch (state.status) {
    case "idle":
      return "Synthetic reviewed host 已关闭；没有 payload。";
    case "loading":
      return "正在通过 typed preload 验证 synthetic reviewed artifact…";
    case "ready":
      return "已验证当前 synthetic revision；只读显示。";
    case "error":
      return `原理图未交付（${state.safeCode}）；没有渲染 geometry。`;
  }
}

export function SchematicWorkspace({
  request,
}: Readonly<{ request?: ResolveReviewedArtifactRequestV1 }> = {}): ReactElement {
  const scenario = exactScenario();
  if (request === undefined || request !== scenario.request) {
    throw new Error("The renderer-entry exact reviewed identity binding drifted.");
  }
  const initialState = Object.freeze({
    status: "loading" as const,
    request: scenario.request,
  });
  const [hostState, setHostState] =
    useState<ReviewedArtifactHostStateV1>(initialState);

  useEffect(() => {
    let active = true;
    const host = createReviewedArtifactHostControllerV1({
      resolveReviewedArtifact: (request) =>
        window.workbench.resolveReviewedArtifact(request),
    });
    const completion = host.mount(scenario.request);
    const forceUnmount = (): void => {
      active = false;
      host.unmount();
      setHostState(Object.freeze({ status: "idle", request: scenario.request }));
    };
    window.addEventListener("aaw-p3d-unmount", forceUnmount, { once: true });
    setHostState(host.getState());
    completion
      .then(() => {
        if (active) setHostState(host.getState());
      })
      .catch(() => {
        if (active) setHostState(host.getState());
      });
    return () => {
      active = false;
      window.removeEventListener("aaw-p3d-unmount", forceUnmount);
      host.unmount();
    };
  }, [scenario]);

  const terminalState =
    scenario.presentation === "unverified" && hostState.status === "error"
      ? "unverified"
      : hostState.status;
  return (
    <section
      aria-label="Synthetic reviewed schematic workspace"
      className="schematic-workspace-host"
      data-p3d-case-id={scenario.caseId}
      data-p3d-terminal-state={terminalState}
      data-schematic-workspace="true"
    >
      <header className="schematic-workspace-status">
        <strong role="status">{PERSISTENT_BANNER}</strong>
        <span>{hostText(hostState)}</span>
      </header>
      {hostState.status === "ready" ? (
        <ReadySchematic
          delivery={hostState.delivery}
          key={`${hostState.delivery.artifactRef.artifactId}:${hostState.delivery.artifactRef.revisionId}`}
        />
      ) : (
        <section
          aria-live="polite"
          className="schematic-workspace-empty"
          data-p3d-geometry-count="0"
        >
          <h2>原理图内容未显示</h2>
          <p>{hostText(hostState)}</p>
        </section>
      )}
    </section>
  );
}
