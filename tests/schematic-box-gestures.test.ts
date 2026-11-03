import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {admitCloudDemo} from '../packages/schematic-workbench/src/cloud-demo-admission';
import {buildSafeSvgSceneV1} from '../packages/schematic-workbench/src/viewer/svg-scene';
import {viewerScreenToWorldV1, viewerWorldToScreenV1} from '../packages/schematic-workbench/src/viewer/view-state';
import {CLOUD_SCHEMATIC_VERSION} from '../apps/desktop/src/shared/schematic/cloud-schematic';
import {createCloudSchematicTabs} from '../apps/desktop/src/renderer/schematic/cloud-schematic-tabs';
import {devicesInSchematicBox, schematicBoxZoomIn, schematicDragBox} from '../apps/desktop/src/renderer/schematic/schematic-box-gestures';

const fixture = admitCloudDemo(Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.manifest.json')), Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.json')));
async function setup() {
  const model = createCloudSchematicTabs({openSynthetic: async ({projectId}) => ({ok: true, value: {contractVersion: CLOUD_SCHEMATIC_VERSION, projectId, documentRef: fixture.documentRef, artifactRef: fixture.artifactRef, freshness: 'current', reviewedCircuitIr: fixture.circuitIr}})});
  model.setProject(randomUUID()); await model.open();
  const ready = () => {const tab = model.snapshot()[0]!; assert.ok(tab.status === 'ready'); return tab;};
  model.action(ready().key, {type: 'resize-css', width: 600, height: 500, fit: true});
  const scene = () => buildSafeSvgSceneV1({circuitIr: fixture.circuitIr, artifactRef: fixture.artifactRef, viewState: ready().viewState, renderState: {status: 'ready', freshness: 'current'}});
  const box = {x: 0, y: 0, width: 600, height: 500};
  return {model, ready, scene, box};
}

test('all four box drag directions select every contained device and exclude nets/pins/labels', async () => {
  const {model, ready, scene} = await setup();
  for (const [start, end] of [[{x: 0, y: 0}, {x: 600, y: 500}], [{x: 600, y: 500}, {x: 0, y: 0}], [{x: 600, y: 0}, {x: 0, y: 500}], [{x: 0, y: 500}, {x: 600, y: 0}]] as const) {
    const box = schematicDragBox(start, end, ready().viewState.viewport);
    assert.deepEqual(devicesInSchematicBox(scene(), box).map(target => target.elementId), ['device.left', 'device.right']);
  }
  model.dispose();
});

test('box selection uses current screen bounds after zoom and pan, with complete containment', async () => {
  const {model, ready, scene} = await setup();
  model.action(ready().key, {type: 'zoom-css', factor: 0.7, anchorCss: {x: 220, y: 190}});
  model.action(ready().key, {type: 'pan-css', deltaCss: {x: 36, y: -27}});
  const current = scene(); const hit = current.hitTargets.find(hit => hit.target.elementId === 'device.left')!;
  assert.ok(hit.shape.kind === 'rect'); const bounds = hit.shape;
  const exact = {x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY};
  assert.deepEqual(devicesInSchematicBox(current, exact).map(target => target.elementId), ['device.left']);
  assert.equal(devicesInSchematicBox(current, {...exact, width: exact.width - 1}).length, 0);
  assert.equal(devicesInSchematicBox({...current, geometryVisible: false}, exact).length, 0);
  model.dispose();
});

test('multi-device selection publishes once, Ctrl appends without duplicates and empty box clears', async () => {
  const {model, ready, scene, box} = await setup(); const targets = devicesInSchematicBox(scene(), box);
  let notifications = 0; const unsubscribe = model.subscribe(() => notifications++);
  model.action(ready().key, {type: 'marquee-select', targets, ctrlKey: false});
  assert.equal(notifications, 1); assert.equal(ready().viewState.selection.length, 2);
  model.action(ready().key, {type: 'marquee-select', targets: [targets[0]!], ctrlKey: false});
  model.action(ready().key, {type: 'marquee-select', targets: [targets[0]!, targets[1]!, targets[1]!], ctrlKey: true});
  assert.equal(ready().viewState.selection.length, 2);
  model.action(ready().key, {type: 'marquee-select', targets: [], ctrlKey: true}); assert.equal(ready().viewState.selection.length, 2);
  model.action(ready().key, {type: 'marquee-select', targets: [], ctrlKey: false}); assert.equal(ready().viewState.selection.length, 0);
  unsubscribe(); model.dispose();
});

test('invalid multi-selection rolls back the entire action without publishing partial selection', async () => {
  const {model, ready, scene, box} = await setup(); const targets = devicesInSchematicBox(scene(), box);
  const before = ready().viewState;
  model.action(ready().key, {type: 'marquee-select', targets: [targets[0]!, {...targets[1]!, elementId: 'missing-device'}], ctrlKey: false});
  assert.equal(ready().viewState, before);
  model.action(ready().key, {type: 'marquee-select', targets: [targets[0]!, {...targets[1]!, elementKind: 'wire'}], ctrlKey: false});
  assert.equal(ready().viewState, before); model.dispose();
});

test('drag clipping and minimum rectangle size prevent clicks and thin drags from zooming', () => {
  const viewport = {widthCss: 600, heightCss: 500, zoom: 1, translateXCss: 0, translateYCss: 0};
  assert.deepEqual(schematicDragBox({x: -200, y: -30}, {x: 900, y: 800}, viewport), {x: 0, y: 0, width: 600, height: 500});
  for (const box of [{x: 10, y: 10, width: 0, height: 0}, {x: 10, y: 10, width: 2, height: 300}, {x: 10, y: 10, width: 300, height: 2}, {x: 0, y: 0, width: 600, height: 500}, {x: NaN, y: 0, width: 30, height: 30}]) assert.equal(schematicBoxZoomIn(box, viewport), null);
});

test('right box enlarges and centers the enclosed region, with the existing maximum zoom', async () => {
  const {model, ready} = await setup(); const viewport = ready().viewState.viewport;
  const box = {x: 40, y: 100, width: 300, height: 250};
  const action = schematicBoxZoomIn(box, viewport)!;
  assert.equal(action.viewport.zoom, viewport.zoom * 2);
  const smaller = schematicBoxZoomIn({x: 150, y: 100, width: 60, height: 50}, viewport)!;
  assert.ok(smaller.viewport.zoom > action.viewport.zoom);
  const world = viewerScreenToWorldV1(viewport, {x: box.x + box.width / 2, y: box.y + box.height / 2}); model.action(ready().key, action);
  assert.equal(ready().viewState.viewport.zoom, viewport.zoom * 2);
  const screen = viewerWorldToScreenV1(ready().viewState.viewport, world);
  assert.ok(Math.abs(screen.x - viewport.widthCss / 2) < 1e-9 && Math.abs(screen.y - viewport.heightCss / 2) < 1e-9);
  for (const corner of [{x: box.x, y: box.y}, {x: box.x + box.width, y: box.y + box.height}]) {
    const p = viewerWorldToScreenV1(ready().viewState.viewport, viewerScreenToWorldV1(viewport, corner));
    assert.ok(p.x >= -1e-9 && p.y >= -1e-9 && p.x <= viewport.widthCss + 1e-9 && p.y <= viewport.heightCss + 1e-9);
  }
  model.action(ready().key, schematicBoxZoomIn({x: 30, y: 30, width: 3, height: 3}, ready().viewState.viewport)!);
  assert.equal(ready().viewState.viewport.zoom, 32);
  assert.equal(schematicBoxZoomIn(box, ready().viewState.viewport), null); model.dispose();
});

test('fit restores the complete scene after box zoom and preserves selected devices and IR', async () => {
  const {model, ready, scene, box} = await setup(); const initial = ready().viewState.viewport, original = JSON.stringify(fixture.circuitIr);
  model.action(ready().key, {type: 'marquee-select', targets: devicesInSchematicBox(scene(), box), ctrlKey: false});
  model.action(ready().key, schematicBoxZoomIn({x: 40, y: 60, width: 120, height: 100}, initial)!);
  model.action(ready().key, {type: 'pan-css', deltaCss: {x: 100, y: -30}});
  model.action(ready().key, {type: 'fit'});
  assert.deepEqual(ready().viewState.viewport, initial); assert.equal(ready().viewState.selection.length, 2);
  assert.equal(JSON.stringify(fixture.circuitIr), original); model.dispose();
});

test('inactive documents ignore marquee actions', async () => {
  const {model, ready, scene, box} = await setup(); const targets = devicesInSchematicBox(scene(), box), before = ready().viewState;
  model.selectText(); model.action(ready().key, {type: 'marquee-select', targets, ctrlKey: false}); assert.equal(ready().viewState, before); model.dispose();
});
