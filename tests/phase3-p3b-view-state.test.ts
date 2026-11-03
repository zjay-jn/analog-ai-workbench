import assert from "node:assert/strict";
import test from "node:test";
import {
  VIEWER_INTERACTION_CONTRACT_V1,
  ViewerViewStateError,
  createInitialViewerViewStateV1,
  fitViewerViewportV1,
  reduceViewerViewStateV1,
  viewerScreenToWorldV1,
  type SyntheticOverlayEnvelopeV1,
  type ViewerActionV1,
  type ViewerElementTargetV1,
  type ViewerViewStateErrorCode,
  type ViewerViewStateV1,
} from "../packages/schematic-workbench/src/viewer/view-state";
import type { ReviewedCircuitIrV1 } from "../packages/schematic-workbench/src/reviewed-circuit-ir";
import {
  admitP3bFixtureV1,
  canonicalPayloadDigestV1,
} from "./phase3-p3b-test-support";

const viewportCssSize = Object.freeze({ width: 800, height: 600 });

function viewStateError(
  code: ViewerViewStateErrorCode,
): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ViewerViewStateError);
    assert.equal(error.code, code);
    return true;
  };
}

function reduceWithImmutableIrOracle(
  circuitIr: ReviewedCircuitIrV1,
  state: ViewerViewStateV1,
  action: ViewerActionV1,
): ViewerViewStateV1 {
  const before = canonicalPayloadDigestV1(circuitIr);
  const next = reduceViewerViewStateV1(circuitIr, state, action);
  assert.equal(canonicalPayloadDigestV1(circuitIr), before);
  assert.equal(Object.isFrozen(circuitIr), true);
  assert.equal(Object.isFrozen(next), true);
  return next;
}

function elementTarget(
  artifactId: string,
  revisionId: string,
  definitionId: string,
  elementKind: "instance" | "port" | "pin" | "wire" | "label",
  elementId: string,
  occurrencePath: readonly string[] = [],
): ViewerElementTargetV1 {
  return {
    artifactId,
    revisionId,
    occurrencePath,
    definitionId,
    elementKind,
    elementId,
  };
}

function overlayFor(
  artifactId: string,
  revisionId: string,
  target: ViewerElementTargetV1,
): SyntheticOverlayEnvelopeV1 {
  return {
    contractVersion: "aaw.synthetic-overlay/v1alpha1",
    overlayId: "overlay.synthetic.qa.v1",
    artifactRef: {
      artifactId,
      revisionId,
      artifactKind: "circuit_ir_reviewed",
    },
    targets: [{ target, styleToken: "synthetic-accent" }],
  };
}

test("P3-B view state is ephemeral and fit is deterministic with 24 CSS px padding", () => {
  assert.deepEqual(VIEWER_INTERACTION_CONTRACT_V1, {
    fitPaddingCssPx: 24,
    minZoom: 0.1,
    maxZoom: 32,
    keyboardZoomFactor: 1.2,
    panDragThresholdCssPx: 3,
    keyboardPanStepCssPx: 40,
    keyboardPanLargeStepCssPx: 120,
    hitToleranceCssPx: 6,
  });
  const admitted = admitP3bFixtureV1("repeated-hierarchy");
  const before = canonicalPayloadDigestV1(admitted.circuitIr);
  const fitted = fitViewerViewportV1(admitted.circuitIr.bounds, viewportCssSize);
  const expectedZoom = (viewportCssSize.width - 2 * 24) / 30;
  assert.equal(fitted.zoom, expectedZoom);
  assert.equal(fitted.translateXCss, 24);
  assert.equal(
    fitted.translateYCss,
    (viewportCssSize.height - 20 * expectedZoom) / 2,
  );
  assert.equal(fitted.widthCss, viewportCssSize.width);
  assert.equal(fitted.heightCss, viewportCssSize.height);
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  assert.deepEqual(state.viewport, fitted);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "keyboard-zoom",
    direction: "out",
  });
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "keyboard-pan",
    direction: "right",
    largeStep: false,
  });
  assert.equal(canonicalPayloadDigestV1(admitted.circuitIr), before);
  assert.equal(admitted.providerState.dirty, false);
});

test("P3-B zoom clamps to 0.1–32 and preserves pointer or viewport-center anchors", () => {
  const admitted = admitP3bFixtureV1("same-label-different-net");
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "set-viewport",
    viewport: {
      zoom: 2,
      translateXCss: 100,
      translateYCss: 50,
      widthCss: 800,
      heightCss: 600,
    },
  });
  const pointer = { x: 123, y: 234 };
  const pointerWorldBefore = viewerScreenToWorldV1(state.viewport, pointer);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "zoom",
    factor: 2,
    anchorCss: pointer,
    source: "ctrl-wheel",
  });
  const pointerWorldAfter = viewerScreenToWorldV1(state.viewport, pointer);
  assert.ok(
    Math.abs(pointerWorldAfter.x - pointerWorldBefore.x) * state.viewport.zoom <=
      0.5,
  );
  assert.ok(
    Math.abs(pointerWorldAfter.y - pointerWorldBefore.y) * state.viewport.zoom <=
      0.5,
  );

  const viewportCenter = { x: 400, y: 300 };
  const centerWorldBefore = viewerScreenToWorldV1(
    state.viewport,
    viewportCenter,
  );
  const zoomBefore = state.viewport.zoom;
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "keyboard-zoom",
    direction: "in",
  });
  assert.equal(state.viewport.zoom, zoomBefore * 1.2);
  const centerWorldAfter = viewerScreenToWorldV1(
    state.viewport,
    viewportCenter,
  );
  assert.ok(
    Math.abs(centerWorldAfter.x - centerWorldBefore.x) * state.viewport.zoom <=
      0.5,
  );
  assert.ok(
    Math.abs(centerWorldAfter.y - centerWorldBefore.y) * state.viewport.zoom <=
      0.5,
  );

  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "zoom",
    factor: 1e9,
    anchorCss: pointer,
    source: "ctrl-wheel",
  });
  assert.equal(state.viewport.zoom, 32);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "zoom",
    factor: 1e-12,
    anchorCss: pointer,
    source: "ctrl-wheel",
  });
  assert.equal(state.viewport.zoom, 0.1);
});

test("P3-B pan honors gesture threshold, wheel axes and 40/120 CSS px keyboard steps", () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  const initialViewport = state.viewport;
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "pointer-down",
    pointerId: 1,
    button: "primary",
    pointCss: { x: 10, y: 10 },
    spaceKey: true,
  });
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "pointer-move",
    pointerId: 1,
    pointCss: { x: 13, y: 10 },
  });
  assert.equal(state.panGesture?.phase, "pending");
  assert.deepEqual(state.viewport, initialViewport);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "pointer-move",
    pointerId: 1,
    pointCss: { x: 14, y: 10 },
  });
  assert.equal(state.panGesture?.phase, "active");
  assert.equal(state.viewport.translateXCss, initialViewport.translateXCss + 4);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "pointer-up",
    pointerId: 1,
  });
  assert.equal(state.panGesture, null);

  const beforeWheel = state.viewport;
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "wheel-pan",
    deltaCssPx: 17,
    shiftKey: false,
  });
  assert.equal(state.viewport.translateYCss, beforeWheel.translateYCss - 17);
  const beforeShiftWheel = state.viewport;
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "wheel-pan",
    deltaCssPx: 19,
    shiftKey: true,
  });
  assert.equal(
    state.viewport.translateXCss,
    beforeShiftWheel.translateXCss - 19,
  );
  const beforeKey = state.viewport;
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "keyboard-pan",
    direction: "right",
    largeStep: false,
  });
  assert.equal(state.viewport.translateXCss, beforeKey.translateXCss + 40);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "keyboard-pan",
    direction: "down",
    largeStep: true,
  });
  assert.equal(state.viewport.translateYCss, beforeKey.translateYCss + 120);

  const middleStart = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "pointer-down",
    pointerId: 2,
    button: "middle",
    pointCss: { x: 30, y: 30 },
    spaceKey: false,
  });
  assert.equal(middleStart.panGesture?.phase, "pending");
});

test("P3-B selection and net highlight remain occurrence-aware and never infer by label", () => {
  const admitted = admitP3bFixtureV1("same-label-different-net");
  const artifact = admitted.receipt.artifactRef;
  const left = elementTarget(
    artifact.artifactId,
    artifact.revisionId,
    "definition.names",
    "label",
    "label.left",
  );
  const right = elementTarget(
    artifact.artifactId,
    artifact.revisionId,
    "definition.names",
    "label",
    "label.right",
  );
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "primary-select",
    target: left,
    ctrlKey: false,
  });
  assert.deepEqual(state.selection, [left]);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "toggle-selection-net",
  });
  assert.deepEqual(state.netHighlight, {
    artifactId: artifact.artifactId,
    revisionId: artifact.revisionId,
    occurrencePath: [],
    definitionId: "definition.names",
    netId: "net.left",
  });
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "primary-select",
    target: right,
    ctrlKey: false,
  });
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "toggle-selection-net",
  });
  assert.equal(state.netHighlight?.netId, "net.right");
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "primary-select",
    target: right,
    ctrlKey: true,
  });
  assert.deepEqual(state.selection, []);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "primary-select",
    target: left,
    ctrlKey: false,
  });
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "primary-select",
    target: null,
    ctrlKey: false,
  });
  assert.deepEqual(state.selection, []);

  const repeated = admitP3bFixtureV1("repeated-hierarchy");
  const repeatedArtifact = repeated.receipt.artifactRef;
  const leftNet = {
    artifactId: repeatedArtifact.artifactId,
    revisionId: repeatedArtifact.revisionId,
    occurrencePath: ["instance.left"],
    definitionId: "definition.child",
    netId: "net.reused",
  } as const;
  const rightNet = {
    ...leftNet,
    occurrencePath: ["instance.right"],
  } as const;
  let repeatedState = createInitialViewerViewStateV1(
    repeated.circuitIr,
    viewportCssSize,
    repeated.receipt.artifactRef,
  );
  repeatedState = reduceWithImmutableIrOracle(repeated.circuitIr, repeatedState, {
    type: "select-net",
    target: leftNet,
  });
  assert.deepEqual(repeatedState.netHighlight, leftNet);
  repeatedState = reduceWithImmutableIrOracle(repeated.circuitIr, repeatedState, {
    type: "select-net",
    target: rightNet,
  });
  assert.deepEqual(repeatedState.netHighlight, rightNet);
  assert.notDeepEqual(leftNet.occurrencePath, rightNet.occurrencePath);
});

test("P3-B hierarchy enter fits and clears channels while back restores one atomic snapshot", () => {
  const admitted = admitP3bFixtureV1("repeated-hierarchy");
  const artifact = admitted.receipt.artifactRef;
  const leftInstance = elementTarget(
    artifact.artifactId,
    artifact.revisionId,
    "definition.root",
    "instance",
    "instance.left",
  );
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "primary-select",
    target: leftInstance,
    ctrlKey: false,
  });
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "admit-overlay",
    overlay: overlayFor(
      artifact.artifactId,
      artifact.revisionId,
      leftInstance,
    ),
  });
  const rootSnapshot = state;
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "enter-hierarchy",
    instanceId: "instance.left",
  });
  assert.deepEqual(state.occurrencePath, ["instance.left"]);
  assert.deepEqual(state.selection, []);
  assert.equal(state.netHighlight, null);
  assert.equal(state.overlay, null);
  assert.deepEqual(
    state.viewport,
    fitViewerViewportV1(
      admitted.circuitIr.definitions[1]!.bounds,
      viewportCssSize,
    ),
  );
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "back-hierarchy",
  });
  assert.deepEqual(state, rootSnapshot);
});

test("P3-B blackbox navigation is unavailable without guessing a child", () => {
  const admitted = admitP3bFixtureV1("blackbox-child");
  const initial = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  const next = reduceWithImmutableIrOracle(admitted.circuitIr, initial, {
    type: "enter-hierarchy",
    instanceId: "instance.unavailable",
  });
  assert.deepEqual(next.occurrencePath, []);
  assert.deepEqual(next.viewport, initial.viewport);
  assert.equal(next.announcement, "Blackbox child unavailable");
});

test("P3-B overlay admission binds exact revision and rejects unknown targets atomically", () => {
  const admitted = admitP3bFixtureV1("same-label-different-net");
  const artifact = admitted.receipt.artifactRef;
  const target = elementTarget(
    artifact.artifactId,
    artifact.revisionId,
    "definition.names",
    "wire",
    "wire.left",
  );
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  const validOverlay = overlayFor(
    artifact.artifactId,
    artifact.revisionId,
    target,
  );
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "admit-overlay",
    overlay: validOverlay,
  });
  assert.deepEqual(state.overlay?.targets, validOverlay.targets);

  const beforeReject = canonicalPayloadDigestV1(state);
  const staleRevision = {
    ...validOverlay,
    artifactRef: { ...validOverlay.artifactRef, revisionId: "rev-stale" },
  };
  assert.throws(
    () =>
      reduceViewerViewStateV1(admitted.circuitIr, state, {
        type: "admit-overlay",
        overlay: staleRevision,
      }),
    viewStateError("REVISION_UNAVAILABLE"),
  );
  assert.equal(canonicalPayloadDigestV1(state), beforeReject);

  const unknownTarget = {
    ...target,
    elementId: "wire.unknown",
  };
  assert.throws(
    () =>
      reduceViewerViewStateV1(admitted.circuitIr, state, {
        type: "admit-overlay",
        overlay: {
          ...validOverlay,
          targets: [
            validOverlay.targets[0]!,
            { target: unknownTarget, styleToken: "synthetic-accent" },
          ],
        },
      }),
    viewStateError("INVALID_TARGET"),
  );
  assert.equal(canonicalPayloadDigestV1(state), beforeReject);
});

test("P3-B Esc clears one channel per press in the frozen priority and restores canvas focus", () => {
  const admitted = admitP3bFixtureV1("same-label-different-net");
  const artifact = admitted.receipt.artifactRef;
  const left = elementTarget(
    artifact.artifactId,
    artifact.revisionId,
    "definition.names",
    "label",
    "label.left",
  );
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    { width: 600, height: 600 },
    admitted.receipt.artifactRef,
  );
  for (const action of [
    { type: "primary-select", target: left, ctrlKey: false },
    { type: "toggle-selection-net" },
    {
      type: "admit-overlay",
      overlay: overlayFor(artifact.artifactId, artifact.revisionId, left),
    },
    { type: "open-inspector", target: left },
  ] as const satisfies readonly ViewerActionV1[]) {
    state = reduceWithImmutableIrOracle(admitted.circuitIr, state, action);
  }
  assert.equal(state.inspector?.mode, "modal");

  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "escape",
  });
  assert.equal(state.inspector, null);
  assert.ok(state.overlay);
  assert.equal(state.focusTarget, "canvas");
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "escape",
  });
  assert.equal(state.overlay, null);
  assert.ok(state.netHighlight);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "escape",
  });
  assert.equal(state.netHighlight, null);
  assert.equal(state.selection.length, 1);
  state = reduceWithImmutableIrOracle(admitted.circuitIr, state, {
    type: "escape",
  });
  assert.deepEqual(state.selection, []);
  assert.equal(state.focusTarget, "canvas");
});
