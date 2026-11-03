import { useEffect, useState, type ReactElement } from "react";
import {applySchematicViewerAction} from "./viewer-actions";
import {
  createInitialViewerViewStateV1,
  type ViewerViewStateV1,
} from "../../../../../packages/schematic-workbench/src/viewer/view-state";
import {
  SchematicViewer,
  type SchematicViewerActionV1,
} from "../SchematicViewer";
import {
  createReviewedArtifactHostControllerV1,
  type RendererReviewedArtifactDeliveryV1,
  type ReviewedArtifactHostStateV1,
} from "./reviewed-artifact-host";
import type { ResolveReviewedArtifactRequestV1 } from "../../shared/schematic/reviewed-artifact-resolve";

const PERSISTENT_BANNER =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED";

export const DEFAULT_SYNTHETIC_SCHEMATIC_REQUEST_V1 = Object.freeze({
  contractVersion: "workbench.schematic.resolveReviewedArtifact.v1",
  documentRef: Object.freeze({
    documentId: "synthetic.schematic.flat-basic",
    revisionId: "rev-1",
    documentKind: "schematic_reviewed",
  }),
  artifactRef: Object.freeze({
    artifactId: "synthetic.circuit-ir.flat-basic",
    revisionId: "rev-1",
    artifactKind: "circuit_ir_reviewed",
  }),
  intent: "render",
}) satisfies ResolveReviewedArtifactRequestV1;

function ReadySchematic({
  delivery,
}: Readonly<{ delivery: RendererReviewedArtifactDeliveryV1 }>): ReactElement {
  const [viewState, setViewState] = useState<ViewerViewStateV1>(() =>
    createInitialViewerViewStateV1(
      delivery.reviewedCircuitIr,
      { width: 720, height: 520 },
      delivery.artifactRef,
    ),
  );

  const onAction = (action: SchematicViewerActionV1): void => {
    setViewState((current) => {
      return applySchematicViewerAction(delivery,current,action);
    });
  };

  return (
    <SchematicViewer
      artifactRef={delivery.artifactRef}
      circuitIr={delivery.reviewedCircuitIr}
      onAction={onAction}
      renderState={{ status: "ready", freshness: delivery.freshness }}
      viewState={viewState}
    />
  );
}

function hostStatus(state: ReviewedArtifactHostStateV1): string {
  switch (state.status) {
    case "idle":
      return "Synthetic reviewed host 已关闭；没有 payload。";
    case "loading":
      return "正在通过 typed preload 验证 synthetic reviewed artifact…";
    case "ready":
      return state.delivery.freshness === "historical"
        ? "已验证历史 revision；只读显示。"
        : "已验证当前 synthetic revision；只读显示。";
    case "error":
      return `原理图未交付（${state.safeCode}）；没有渲染 geometry。`;
  }
}

export type SchematicWorkspacePropsV1 = Readonly<{
  request?: ResolveReviewedArtifactRequestV1;
}>;

export function SchematicWorkspace({
  request = DEFAULT_SYNTHETIC_SCHEMATIC_REQUEST_V1,
}: SchematicWorkspacePropsV1 = {}): ReactElement {
  const [hostState, setHostState] =
    useState<ReviewedArtifactHostStateV1>(() =>
      Object.freeze({ status: "loading", request }),
    );

  useEffect(() => {
    let active = true;
    setHostState(Object.freeze({ status: "loading", request }));
    const host = createReviewedArtifactHostControllerV1({
      resolveReviewedArtifact: (request) =>
        window.workbench.resolveReviewedArtifact(request),
    });
    const completion = host.mount(request);
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
      host.unmount();
    };
  }, [request]);

  return (
    <section
      aria-label="Synthetic reviewed schematic workspace"
      className="schematic-workspace-host"
      data-schematic-workspace="true"
    >
      <p
        aria-atomic="true"
        aria-live="polite"
        className="schematic-workspace-a11y-status"
        role="status"
      >
        {PERSISTENT_BANNER}. {hostStatus(hostState)}
      </p>
      {hostState.status === "ready" ? (
        <ReadySchematic
          delivery={hostState.delivery}
          key={`${hostState.delivery.artifactRef.artifactId}:${hostState.delivery.artifactRef.revisionId}`}
        />
      ) : (
        <section aria-live="polite" className="schematic-workspace-empty">
          <h2>原理图内容未显示</h2>
          <p>{hostStatus(hostState)}</p>
        </section>
      )}
    </section>
  );
}
