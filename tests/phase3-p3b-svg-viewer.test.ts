import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {applySchematicViewerAction} from "../apps/desktop/src/renderer/schematic/viewer-actions";
import {
  SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1,
  SAFE_SVG_PRIMITIVE_ALLOWLIST_V1,
  SVG_LAYER_ORDER_V1,
  buildSafeSvgSceneV1,
  hitTestSafeSvgSceneV1,
} from "../packages/schematic-workbench/src/viewer/svg-scene";
import {
  ViewerViewStateError,
  createInitialViewerViewStateV1,
  reduceViewerViewStateV1,
  viewerWorldToScreenV1,
  type ViewerElementTargetV1,
  type ViewerViewStateV1,
} from "../packages/schematic-workbench/src/viewer/view-state";
import {
  SCHEMATIC_VIEWER_ACCESSIBILITY_CONTRACT_V1,
  SchematicViewer,
} from "../apps/desktop/src/renderer/SchematicViewer";
import {
  admitP3bFixtureV1,
  validateSyntheticViewerVectorThroughRawV1,
} from "./phase3-p3b-test-support";

const viewportCssSize = Object.freeze({ width: 800, height: 600 });
const persistentBanner =
  "SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED";
const overlayBanner = "SYNTHETIC OVERLAY · NO AGENT";

function targetFor(
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

test("P3-B safe scene uses an exact SVG primitive/attribute allowlist and fixed z-order", () => {
  assert.deepEqual(SAFE_SVG_PRIMITIVE_ALLOWLIST_V1, [
    "circle",
    "g",
    "line",
    "path",
    "polyline",
    "rect",
    "svg",
    "text",
  ]);
  assert.deepEqual(SVG_LAYER_ORDER_V1, [
    "base",
    "net",
    "overlay",
    "selection",
    "keyboard-focus",
  ]);
  const forbiddenAttributes = new Set([
    "dangerouslySetInnerHTML",
    "href",
    "xlink:href",
    "xlinkHref",
    "src",
    "style",
    "onload",
    "onclick",
    "filter",
    "mask",
    "id",
  ]);
  assert.equal(
    SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1.some((name: string) =>
      forbiddenAttributes.has(name),
    ),
    false,
  );

  const admitted = admitP3bFixtureV1("same-label-different-net");
  const artifact = admitted.receipt.artifactRef;
  const selection = targetFor(
    artifact.artifactId,
    artifact.revisionId,
    "definition.names",
    "wire",
    "wire.left",
  );
  let viewState = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    artifact,
  );
  viewState = reduceViewerViewStateV1(admitted.circuitIr, viewState, {
    type: "primary-select",
    target: selection,
    ctrlKey: false,
  });
  viewState = reduceViewerViewStateV1(admitted.circuitIr, viewState, {
    type: "toggle-selection-net",
  });
  viewState = reduceViewerViewStateV1(admitted.circuitIr, viewState, {
    type: "admit-overlay",
    overlay: {
      contractVersion: "aaw.synthetic-overlay/v1alpha1",
      overlayId: "overlay.synthetic.scene.v1",
      artifactRef: artifact,
      targets: [{ target: selection, styleToken: "synthetic-accent" }],
    },
  });
  const scene = buildSafeSvgSceneV1({
    circuitIr: admitted.circuitIr,
    artifactRef: artifact,
    viewState,
    renderState: { status: "ready", freshness: "current" },
  });
  assert.deepEqual(
    scene.layers.map((layer: { kind: string }) => layer.kind),
    SVG_LAYER_ORDER_V1,
  );
  for (const primitive of scene.primitives) {
    assert.equal(
      SAFE_SVG_PRIMITIVE_ALLOWLIST_V1.includes(primitive.tag),
      true,
      primitive.tag,
    );
    for (const attributeName of Object.keys(primitive.attributes)) {
      assert.equal(
        SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1.includes(attributeName),
        true,
        `${primitive.tag}.${attributeName}`,
      );
    }
    assert.doesNotMatch(JSON.stringify(primitive), /(?:data|blob|https?|file):/iu);
  }
});

test("P3-B rendered SVG applies the exact safe viewport matrix for fit, zoom and pan", () => {
  assert.equal(SAFE_SVG_PRIMITIVE_ALLOWLIST_V1.includes("g"), true);
  assert.equal(SAFE_SVG_ATTRIBUTE_ALLOWLIST_V1.includes("transform"), true);
  const admitted = admitP3bFixtureV1("same-label-different-net");
  const artifact = admitted.receipt.artifactRef;
  let fitState = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    artifact,
  );
  fitState = reduceViewerViewStateV1(admitted.circuitIr, fitState, {
    type: "fit",
  });
  const zoomState = reduceViewerViewStateV1(admitted.circuitIr, fitState, {
    type: "keyboard-zoom",
    direction: "out",
  });
  const panState = reduceViewerViewStateV1(admitted.circuitIr, zoomState, {
    type: "keyboard-pan",
    direction: "right",
    largeStep: false,
  });
  const states = [fitState, zoomState, panState] as const;
  const matrices: string[] = [];

  for (const viewState of states) {
    const scene = buildSafeSvgSceneV1({
      circuitIr: admitted.circuitIr,
      artifactRef: artifact,
      viewState,
      renderState: { status: "ready", freshness: "current" },
    });
    assert.deepEqual(scene.viewport, viewState.viewport);
    const viewport = scene.viewport;
    const matrix = `matrix(${viewport.zoom} 0 0 ${viewport.zoom} ${viewport.translateXCss} ${viewport.translateYCss})`;
    matrices.push(matrix);
    const markup = renderToStaticMarkup(
      createElement(SchematicViewer, {
        circuitIr: admitted.circuitIr,
        artifactRef: artifact,
        viewState,
        renderState: { status: "ready", freshness: "current" },
        onAction: () => undefined,
      }),
    );
    const matchingViewportGroups = (markup.match(/<g\b[^>]*>/gu) ?? []).filter(
      (tag) => tag.includes(`transform="${matrix}"`),
    );
    assert.equal(
      matchingViewportGroups.length,
      1,
      `rendered SVG must contain one exact viewport group for ${matrix}`,
    );
    const viewportGroup = matchingViewportGroups[0]!;
    assert.doesNotMatch(
      viewportGroup,
      /\s(?:style|href|src|xlink:href)=|url\s*\(|(?:data|blob|https?|file):/iu,
    );

    const worldPoint = { x: 4, y: 5 } as const;
    const expectedScreenPoint = {
      x: worldPoint.x * viewport.zoom + viewport.translateXCss,
      y: worldPoint.y * viewport.zoom + viewport.translateYCss,
    };
    assert.deepEqual(
      viewerWorldToScreenV1(viewport, worldPoint),
      expectedScreenPoint,
      "render matrix and hit-test coordinate conversion must use the same formula",
    );
    assert.equal(
      hitTestSafeSvgSceneV1(scene, {
        pointCss: expectedScreenPoint,
        toleranceCssPx: 6,
      })?.target.elementId,
      "wire.left",
    );
  }

  assert.notEqual(matrices[0], matrices[1], "zoom must change the SVG matrix");
  assert.notEqual(matrices[1], matrices[2], "pan must change the SVG matrix");
});

test("P3-B hit-test fixes 6 CSS px tolerance and port/pin over instance priority", () => {
  const mapped = admitP3bFixtureV1("explicit-port-mapping");
  const mappedState = createInitialViewerViewStateV1(
    mapped.circuitIr,
    viewportCssSize,
    mapped.receipt.artifactRef,
  );
  const mappedScene = buildSafeSvgSceneV1({
    circuitIr: mapped.circuitIr,
    artifactRef: mapped.receipt.artifactRef,
    viewState: mappedState,
    renderState: { status: "ready", freshness: "current" },
  });
  const pinPoint = viewerWorldToScreenV1(mappedState.viewport, { x: 5, y: 6 });
  const pinHit = hitTestSafeSvgSceneV1(mappedScene, {
    pointCss: pinPoint,
    toleranceCssPx: 6,
  });
  assert.equal(pinHit?.target.elementKind, "pin");
  assert.equal(pinHit?.target.elementId, "pin.parent");

  const wires = admitP3bFixtureV1("same-label-different-net");
  const wireState = createInitialViewerViewStateV1(
    wires.circuitIr,
    viewportCssSize,
    wires.receipt.artifactRef,
  );
  const wireScene = buildSafeSvgSceneV1({
    circuitIr: wires.circuitIr,
    artifactRef: wires.receipt.artifactRef,
    viewState: wireState,
    renderState: { status: "ready", freshness: "current" },
  });
  const wirePoint = viewerWorldToScreenV1(wireState.viewport, { x: 4, y: 5 });
  assert.equal(
    hitTestSafeSvgSceneV1(wireScene, {
      pointCss: { x: wirePoint.x, y: wirePoint.y + 6 },
      toleranceCssPx: 6,
    })?.target.elementId,
    "wire.left",
  );
  assert.equal(
    hitTestSafeSvgSceneV1(wireScene, {
      pointCss: { x: wirePoint.x, y: wirePoint.y + 6.01 },
      toleranceCssPx: 6,
    }),
    null,
  );
});

test("P3-B scene never projects stale revision selection or net state onto the current artifact", () => {
  const admitted = admitP3bFixtureV1("same-label-different-net");
  const artifact = admitted.receipt.artifactRef;
  const initial = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    artifact,
  );
  const currentWire = targetFor(
    artifact.artifactId,
    artifact.revisionId,
    "definition.names",
    "wire",
    "wire.left",
  );
  const staleRevisionId = `${artifact.revisionId}.stale`;

  const staleNetState = Object.freeze({
    ...initial,
    netHighlight: Object.freeze({
      artifactId: artifact.artifactId,
      revisionId: staleRevisionId,
      occurrencePath: Object.freeze([]),
      definitionId: "definition.names",
      netId: "net.left",
    }),
  }) satisfies ViewerViewStateV1;
  assert.throws(
    () =>
      buildSafeSvgSceneV1({
        circuitIr: admitted.circuitIr,
        artifactRef: artifact,
        viewState: staleNetState,
        renderState: { status: "ready", freshness: "current" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ViewerViewStateError);
      assert.equal(error.code, "REVISION_UNAVAILABLE");
      return true;
    },
    "a stale net target must fail before scene or primitive delivery",
  );

  const staleSelectionState = Object.freeze({
    ...initial,
    selection: Object.freeze([
      Object.freeze({ ...currentWire, revisionId: staleRevisionId }),
    ]),
  }) satisfies ViewerViewStateV1;
  assert.throws(
    () =>
      buildSafeSvgSceneV1({
        circuitIr: admitted.circuitIr,
        artifactRef: artifact,
        viewState: staleSelectionState,
        renderState: { status: "ready", freshness: "current" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ViewerViewStateError);
      assert.equal(error.code, "REVISION_UNAVAILABLE");
      return true;
    },
    "a stale selection must fail before scene or primitive delivery",
  );

  const manuallyMismatchedRevisionState = Object.freeze({
    ...initial,
    artifactBinding: Object.freeze({
      artifactId: artifact.artifactId,
      revisionId: staleRevisionId,
    }),
  }) satisfies ViewerViewStateV1;
  assert.throws(
    () =>
      buildSafeSvgSceneV1({
        circuitIr: admitted.circuitIr,
        artifactRef: artifact,
        viewState: manuallyMismatchedRevisionState,
        renderState: { status: "ready", freshness: "current" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ViewerViewStateError);
      assert.equal(error.code, "REVISION_UNAVAILABLE");
      return true;
    },
    "a revision switch must fail closed instead of reusing manually inconsistent state",
  );
});

test("P3-B render states fail closed and historical remains distinct from revocation", () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  const state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  const cases = [
    {
      renderState: { status: "loading" } as const,
      geometryVisible: false,
      deliveryAllowed: false,
      cancelDelivery: false,
    },
    {
      renderState: { status: "ready", freshness: "current" } as const,
      geometryVisible: true,
      deliveryAllowed: true,
      cancelDelivery: false,
    },
    {
      renderState: { status: "ready", freshness: "historical" } as const,
      geometryVisible: true,
      deliveryAllowed: true,
      cancelDelivery: false,
    },
    {
      renderState: { status: "unverified" } as const,
      geometryVisible: false,
      deliveryAllowed: false,
      cancelDelivery: false,
    },
    {
      renderState: { status: "error", safeCode: "INTERNAL" } as const,
      geometryVisible: false,
      deliveryAllowed: false,
      cancelDelivery: false,
    },
    {
      renderState: { status: "revoked" } as const,
      geometryVisible: false,
      deliveryAllowed: false,
      cancelDelivery: true,
    },
    {
      renderState: { status: "quarantined" } as const,
      geometryVisible: false,
      deliveryAllowed: false,
      cancelDelivery: true,
    },
  ];
  for (const expected of cases) {
    const scene = buildSafeSvgSceneV1({
      circuitIr: admitted.circuitIr,
      artifactRef: admitted.receipt.artifactRef,
      viewState: state,
      renderState: expected.renderState,
    });
    assert.equal(scene.geometryVisible, expected.geometryVisible);
    assert.equal(scene.deliveryAllowed, expected.deliveryAllowed);
    assert.equal(scene.cancelDelivery, expected.cancelDelivery);
    assert.equal(scene.persistentBanner, persistentBanner);
    if (!expected.geometryVisible) assert.deepEqual(scene.hitTargets, []);
    if (
      expected.renderState.status === "ready" &&
      expected.renderState.freshness === "historical"
    ) {
      assert.equal(scene.historicalWarningVisible, true);
    }
  }
});

test("P3-B overlay-local failure removes the full overlay layer but preserves base Viewer", () => {
  const admitted = admitP3bFixtureV1("flat-basic");
  const artifact = admitted.receipt.artifactRef;
  const target = targetFor(
    artifact.artifactId,
    artifact.revisionId,
    "definition.flat",
    "wire",
    "wire.nonexistent-for-local-failure",
  );
  const viewState = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    artifact,
  );
  const scene = buildSafeSvgSceneV1({
    circuitIr: admitted.circuitIr,
    artifactRef: artifact,
    viewState,
    renderState: { status: "ready", freshness: "current" },
    overlayFailure: {
      overlayId: "overlay.synthetic.failed.v1",
      failedTarget: target,
      safeCode: "INVALID_TARGET",
    },
  });
  assert.equal(scene.geometryVisible, true);
  assert.equal(scene.overlayVisible, false);
  assert.equal(scene.overlayLocalErrorVisible, true);
  assert.equal(scene.overlayBanner, overlayBanner);
  assert.ok(
    scene.layers.find((layer: { kind: string }) => layer.kind === "base"),
  );
  assert.equal(
    scene.layers.find((layer: { kind: string; primitives: readonly unknown[] }) =>
      layer.kind === "overlay",
    )?.primitives.length,
    0,
  );
});

test("P3-B component keeps Inspector closed until an explicit selected-target action", () => {
  assert.deepEqual(SCHEMATIC_VIEWER_ACCESSIBILITY_CONTRACT_V1, {
    canvasTabIndex: 0,
    entityTreeRole: "tree",
    netListRole: "listbox",
    liveRegionPoliteness: "polite",
    inspectorDockMinWidthCssPx: 720,
    inspectorModalMaxWidthRatio: 0.7,
    tabCycleKeys: ["Ctrl+Tab", "Ctrl+Shift+Tab"],
    tabRovingKeys: ["ArrowLeft", "ArrowRight", "Enter", "Space"],
    canvasKeys: ["F", "+", "-", "ArrowKeys", "H", "Enter", "Alt+Left"],
    escapeOrder: ["inspector", "overlay", "net", "selection"],
  });
  const admitted = admitP3bFixtureV1("unicode-labels");
  let state = createInitialViewerViewStateV1(
    admitted.circuitIr,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  const markup = renderToStaticMarkup(
    createElement(SchematicViewer, {
      circuitIr: admitted.circuitIr,
      artifactRef: admitted.receipt.artifactRef,
      viewState: state,
      renderState: { status: "ready", freshness: "current" },
      onAction: () => undefined,
    }),
  );
  assert.match(markup, /SYNTHETIC REVIEWED FIXTURE · READ-ONLY · EDA DISCONNECTED/u);
  const canvasTag = markup.match(/<[^>]*data-schematic-canvas="true"[^>]*>/u)?.[0];
  assert.ok(canvasTag);
  assert.match(canvasTag, /tabindex="0"/u);
  assert.match(markup, /aria-expanded="false"[^>]*title="打开只读检查器"[^>]*>检查器</u);
  assert.doesNotMatch(markup, /aria-label="只读 Inspector"|role="tree"|role="listbox"/u);
  assert.match(markup, /aria-live="polite"/u);
  assert.match(markup, /合成节点✨/u);
  assert.doesNotMatch(markup, /contenteditable|<input|<textarea/iu);

  const root = admitted.circuitIr.definitions.find(
    (definition) => definition.definitionId === admitted.circuitIr.rootDefinitionId,
  );
  assert.ok(root);
  const label = root.labels[0];
  assert.ok(label);
  const target = targetFor(
    admitted.receipt.artifactRef.artifactId,
    admitted.receipt.artifactRef.revisionId,
    root.definitionId,
    "label",
    label.labelId,
  );
  state = reduceViewerViewStateV1(admitted.circuitIr, state, {
    type: "primary-select",
    target,
    ctrlKey: false,
  });
  const selectedMarkup = renderToStaticMarkup(
    createElement(SchematicViewer, {
      circuitIr: admitted.circuitIr,
      artifactRef: admitted.receipt.artifactRef,
      viewState: state,
      renderState: { status: "ready", freshness: "current" },
      onAction: () => undefined,
    }),
  );
  assert.match(selectedMarkup, /aria-expanded="false"[^>]*>检查器</u);
  assert.doesNotMatch(selectedMarkup, /aria-label="只读 Inspector"/u);

  state = reduceViewerViewStateV1(admitted.circuitIr, state, {
    type: "open-inspector",
    target,
  });
  const openMarkup = renderToStaticMarkup(
    createElement(SchematicViewer, {
      circuitIr: admitted.circuitIr,
      artifactRef: admitted.receipt.artifactRef,
      viewState: state,
      renderState: { status: "ready", freshness: "current" },
      onAction: () => undefined,
    }),
  );
  assert.match(openMarkup, /aria-expanded="true"[^>]*>检查器</u);
  assert.match(openMarkup, /aria-label="关闭 Inspector"/u);
  assert.match(openMarkup, /aria-label="只读 Inspector"/u);
  assert.match(openMarkup, /role="tree"/u);
  assert.match(openMarkup, /role="listbox"/u);
});

test("P3-B Inspector trigger, Escape close and focus return remain explicit", () => {
  const viewerSource = readFileSync(
    "apps/desktop/src/renderer/SchematicViewer.tsx",
    "utf8",
  );
  const workspaceSource = readFileSync(
    "apps/desktop/src/renderer/schematic/SchematicWorkspace.tsx",
    "utf8",
  );
  const actionsSource = readFileSync(
    "apps/desktop/src/renderer/schematic/viewer-actions.ts",
    "utf8",
  );
  assert.match(viewerSource, /aria-expanded=\{inspectorVisible\}/u);
  assert.match(viewerSource, /onAction\(\{\s*type: "open-inspector",\s*target: inspectorOpenTarget/u);
  assert.match(viewerSource, /event\.key === "Escape"[\s\S]*?closeInspector\(\)/u);
  assert.match(viewerSource, /inspectorToggleRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(workspaceSource, /import\s*\{\s*applySchematicViewerAction\s*\}\s*from\s*"\.\/viewer-actions"/u);
  assert.match(workspaceSource, /return applySchematicViewerAction\(delivery,\s*current,\s*action\)/u);
  assert.match(actionsSource, /case "open-inspector":\s*return action;/u);
  assert.doesNotMatch(
    actionsSource,
    /action\.type === "primary-select"[\s\S]*?type: "open-inspector"/u,
  );
  const admitted = admitP3bFixtureV1("unicode-labels");
  const artifactRef = admitted.receipt.artifactRef;
  const root = admitted.circuitIr.definitions.find(
    definition => definition.definitionId === admitted.circuitIr.rootDefinitionId,
  );
  assert.ok(root?.labels[0]);
  const target = targetFor(artifactRef.artifactId, artifactRef.revisionId, root.definitionId, "label", root.labels[0].labelId);
  const delivery = {artifactRef, reviewedCircuitIr: admitted.circuitIr};
  const initial = createInitialViewerViewStateV1(admitted.circuitIr, viewportCssSize, artifactRef);
  const selected = applySchematicViewerAction(delivery, initial, {type:"primary-select", target, ctrlKey:false});
  assert.equal(selected.inspector, null, "selection alone must not open Inspector");
  const opened = applySchematicViewerAction(delivery, selected, {type:"open-inspector", target});
  assert.deepEqual(opened.inspector?.target, target);
  const closed = applySchematicViewerAction(delivery, opened, {type:"close-inspector"});
  assert.equal(closed.inspector, null);
  assert.equal(closed.focusTarget, "canvas");
  const escaped = applySchematicViewerAction(delivery, opened, {type:"escape-highest-priority"});
  assert.equal(escaped.inspector, null);
  assert.deepEqual(escaped.selection, selected.selection, "first Escape closes Inspector before selection");
  assert.equal(escaped.focusTarget, "canvas");
});

test("P3-B hostile label remains escaped text and never creates a DOM/resource capability", () => {
  const admitted = admitP3bFixtureV1("unicode-labels");
  const mutable = JSON.parse(JSON.stringify(admitted.circuitIr)) as {
    definitions: Array<{ labels: Array<{ text: string }> }>;
  };
  const hostileText =
    '<script src="file:///secret"><foreignObject>runSimulation</foreignObject></script>';
  mutable.definitions[0]!.labels[0]!.text = hostileText;
  const validated = validateSyntheticViewerVectorThroughRawV1(mutable);
  const state = createInitialViewerViewStateV1(
    validated,
    viewportCssSize,
    admitted.receipt.artifactRef,
  );
  const markup = renderToStaticMarkup(
    createElement(SchematicViewer, {
      circuitIr: validated,
      artifactRef: admitted.receipt.artifactRef,
      viewState: state,
      renderState: { status: "ready", freshness: "current" },
      onAction: () => undefined,
    }),
  );
  assert.match(
    markup,
    /&lt;script src=&quot;file:\/\/\/secret&quot;&gt;&lt;foreignObject&gt;runSimulation&lt;\/foreignObject&gt;&lt;\/script&gt;/u,
  );
  assert.doesNotMatch(
    markup,
    /<(?:script|foreignObject)\b|<[A-Za-z][^>]*\s(?:href|src)\s*=/iu,
  );
});

test("P3-B renderer source has no raw DOM, privileged import or resource seam", () => {
  const componentPath = "apps/desktop/src/renderer/SchematicViewer.tsx";
  const source = readFileSync(componentPath, "utf8");
  const sourceFile = ts.createSourceFile(
    componentPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const forbiddenTags = new Set([
    "script",
    "foreignObject",
    "use",
    "image",
    "iframe",
    "object",
    "embed",
    "style",
  ]);
  const forbiddenAttributes = new Set([
    "dangerouslySetInnerHTML",
    "href",
    "xlinkHref",
    "src",
    "style",
  ]);
  const forbiddenCalls = new Set([
    "eval",
    "Function",
    "DOMParser",
    "Path2D",
    "drawImage",
    "insertAdjacentHTML",
  ]);
  const forbiddenProperties = new Set([
    "innerHTML",
    "outerHTML",
    "dangerouslySetInnerHTML",
  ]);
  const inspect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      assert.doesNotMatch(
        node.moduleSpecifier.text,
        /^(?:node:)?(?:fs|child_process|http|https|net|tls)$|^electron$/u,
      );
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      assert.equal(forbiddenTags.has(tagName), false, tagName);
      for (const property of node.attributes.properties) {
        if (ts.isJsxAttribute(property)) {
          assert.equal(
            forbiddenAttributes.has(property.name.getText(sourceFile)),
            false,
            property.name.getText(sourceFile),
          );
        }
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      if (name !== undefined) assert.equal(forbiddenCalls.has(name), false, name);
    }
    if (ts.isPropertyAccessExpression(node)) {
      assert.equal(forbiddenProperties.has(node.name.text), false, node.name.text);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  assert.doesNotMatch(source, /(?:data|blob|https?|file):|url\s*\(/iu);
});

test("P3-B Viewer remains behind the P3-C host and has no renderer fixture or admission bypass", () => {
  const parse = (path: string, scriptKind: ts.ScriptKind): ts.SourceFile =>
    ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
  const appPath = "apps/desktop/src/renderer/App.tsx";
  const entryPath = "apps/desktop/src/renderer/main.tsx";
  const hostPath = "apps/desktop/src/renderer/schematic/SchematicWorkspace.tsx";
  const appSource = parse(appPath, ts.ScriptKind.TSX);
  const entrySource = parse(entryPath, ts.ScriptKind.TSX);
  const hostSource = parse(hostPath, ts.ScriptKind.TSX);

  for (const sourceFile of [appSource, entrySource, hostSource]) {
    const forbiddenReferences: string[] = [];
    const inspectProductionRenderer = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /(?:fixtures|synthetic-admission|strict-source-frame|approved-synthetic)/u.test(
          node.moduleSpecifier.text,
        )
      ) {
        forbiddenReferences.push(node.moduleSpecifier.text);
      }
      if (
        sourceFile === appSource &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /(?:^|\/)SchematicViewer$/u.test(node.moduleSpecifier.text)
      ) {
        forbiddenReferences.push(node.moduleSpecifier.text);
      }
      if (
        sourceFile === appSource &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(sourceFile) === "SchematicViewer"
      ) {
        forbiddenReferences.push(node.tagName.getText(sourceFile));
      }
      ts.forEachChild(node, inspectProductionRenderer);
    };
    inspectProductionRenderer(sourceFile);
    assert.deepEqual(
      forbiddenReferences,
      [],
      `${sourceFile.fileName} must use only the typed P3-C host boundary`,
    );
  }
  assert.match(readFileSync(hostPath, "utf8"), /<SchematicViewer/u);
});

test("P3-B component keyboard, toolbar and roving-focus seams match the frozen GUI contract", () => {
  const componentPath = "apps/desktop/src/renderer/SchematicViewer.tsx";
  const source = readFileSync(componentPath, "utf8");
  const sourceFile = ts.createSourceFile(
    componentPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  let canvasHandler: ts.ArrowFunction | undefined;
  const namedFunctions = new Map<string, ts.Node>();
  const inspectDeclarations = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      namedFunctions.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer !== undefined) namedFunctions.set(node.name.text, node.initializer);
      if (
        node.name.text === "handleCanvasKeyDown" &&
        node.initializer !== undefined &&
        ts.isArrowFunction(node.initializer)
      ) {
        canvasHandler = node.initializer;
      }
    }
    ts.forEachChild(node, inspectDeclarations);
  };
  inspectDeclarations(sourceFile);
  const resolvedCanvasHandler = canvasHandler;
  assert.ok(resolvedCanvasHandler !== undefined);
  const canvasBody = resolvedCanvasHandler.body;
  assert.ok(ts.isBlock(canvasBody));
  const canvasStatements = canvasBody.statements.map((statement) =>
    statement.getText(sourceFile),
  );
  const altBackIndex = canvasStatements.findIndex(
    (statement) => /event\.altKey/u.test(statement) && /ArrowLeft/u.test(statement),
  );
  const genericArrowIndex = canvasStatements.findIndex((statement) =>
    /startsWith\(["']Arrow["']\)/u.test(statement),
  );
  assert.ok(altBackIndex >= 0, "Alt+Left hierarchy-back branch must exist");
  assert.ok(genericArrowIndex >= 0, "generic Arrow pan branch must exist");
  assert.ok(
    altBackIndex < genericArrowIndex,
    "Alt+Left must be reduced before the generic Arrow pan branch",
  );

  const toolbarZoomHandlers: string[] = [];
  const ariaSelectedExpressions: string[] = [];
  const rovingTabIndexExpressions: string[] = [];
  let domFocusCallCount = 0;
  const inspectComponent = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sourceFile) === "button") {
      const label = node.children.map((child) => child.getText(sourceFile)).join("");
      if (/缩小|放大/u.test(label)) {
        const onClick = node.openingElement.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) &&
            property.name.getText(sourceFile) === "onClick",
        );
        assert.ok(onClick?.initializer !== undefined);
        toolbarZoomHandlers.push(onClick.initializer.getText(sourceFile));
      }
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (
        name === "aria-selected" &&
        node.initializer !== undefined &&
        ts.isJsxExpression(node.initializer)
      ) {
        ariaSelectedExpressions.push(node.initializer.expression?.getText(sourceFile) ?? "");
      }
      if (
        name === "tabIndex" &&
        node.initializer !== undefined &&
        ts.isJsxExpression(node.initializer)
      ) {
        const expression = node.initializer.expression?.getText(sourceFile) ?? "";
        if (/FocusIndex/u.test(expression)) rovingTabIndexExpressions.push(expression);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "focus"
    ) {
      domFocusCallCount += 1;
    }
    ts.forEachChild(node, inspectComponent);
  };
  inspectComponent(sourceFile);

  assert.equal(toolbarZoomHandlers.length, 2);
  for (const handlerText of toolbarZoomHandlers) {
    assert.doesNotMatch(handlerText, /anchorCss\s*:\s*\{\s*x\s*:\s*0\s*,\s*y\s*:\s*0\s*\}/u);
    const inlineCenter =
      /widthCss\s*\/\s*2/u.test(handlerText) &&
      /heightCss\s*\/\s*2/u.test(handlerText);
    const helperName = handlerText.match(/anchorCss\s*:\s*([A-Za-z_$][\w$]*)\b/u)?.[1];
    const helperText = helperName === undefined
      ? ""
      : namedFunctions.get(helperName)?.getText(sourceFile) ?? "";
    const helperCenter =
      /widthCss\s*\/\s*2/u.test(helperText) &&
      /heightCss\s*\/\s*2/u.test(helperText);
    assert.equal(
      inlineCenter || helperCenter,
      true,
      "toolbar zoom must derive both axes from the current viewport center",
    );
  }

  assert.equal(rovingTabIndexExpressions.length, 2);
  assert.equal(ariaSelectedExpressions.length, 2);
  for (const expression of ariaSelectedExpressions) {
    assert.doesNotMatch(
      expression,
      /FocusIndex/u,
      "selection state must remain independent from the roving focus index",
    );
    assert.match(
      expression,
      /selection|selected|highlighted|netHighlight/iu,
      "aria-selected must be derived from semantic selection or net state",
    );
  }
  assert.ok(
    domFocusCallCount > 0,
    "Arrow-key roving must include an actual DOM focus seam, not only tabIndex mutation",
  );
});
