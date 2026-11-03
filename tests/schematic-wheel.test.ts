import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {bindSchematicWheel, schematicWheelFactor} from '../apps/desktop/src/renderer/schematic/schematic-wheel';
import {admitCloudDemo} from '../packages/schematic-workbench/src/cloud-demo-admission';
import {createCloudSchematicTabs} from '../apps/desktop/src/renderer/schematic/cloud-schematic-tabs';
import {CLOUD_SCHEMATIC_VERSION} from '../apps/desktop/src/shared/schematic/cloud-schematic';
import {viewerScreenToWorldV1, viewerWorldToScreenV1} from '../packages/schematic-workbench/src/viewer/view-state';

function near(actual: number, expected: number): void {assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);}
const factor = (deltaY: number, deltaMode = 0) => schematicWheelFactor({deltaY, deltaMode}, 500)!;

test('wheel direction uses visual scale, with smooth reciprocal trackpad steps', () => {
  near(factor(-100), 1.12); near(factor(100), 1 / 1.12);
  assert.ok(factor(-1) > 1 && factor(-1) < factor(-100));
  near(factor(-1) ** 100, factor(-100)); near(factor(35) * factor(-35), 1);
});

test('pixel, line and page deltas normalize consistently and bound a single extreme event', () => {
  near(factor(32), factor(2, 1)); near(factor(100), factor(0.2, 2));
  near(factor(1e300), factor(240)); near(factor(-1e300), factor(-240));
  assert.ok(factor(1e300) > 0 && Number.isFinite(factor(-1e300)));
});

test('zero, horizontal-only and invalid wheel values do not zoom', () => {
  for (const deltaY of [0, -0, NaN, Infinity, -Infinity]) assert.equal(schematicWheelFactor({deltaY, deltaMode: 0}, 500), null);
  assert.equal(schematicWheelFactor({deltaY: 1, deltaMode: 3}, 500), null);
  assert.equal(schematicWheelFactor({deltaY: 1, deltaMode: 2}, 0), null);
});

function fakeCanvas() {
  const events = new EventTarget();
  const canvas = {
    isConnected: true,
    rect: {left: 30, top: 50, width: 600, height: 500},
    options: undefined as AddEventListenerOptions | undefined,
    getBoundingClientRect() {return this.rect;},
    addEventListener(type: string, listener: EventListener, options: AddEventListenerOptions) {this.options = options; events.addEventListener(type, listener);},
    removeEventListener(type: string, listener: EventListener) {events.removeEventListener(type, listener);},
    dispatch(deltaY: number, extras: Record<string, unknown> = {}) {
      const event = new Event('wheel', {cancelable: true, bubbles: true});
      Object.assign(event, {deltaY, deltaMode: 0, clientX: 180, clientY: 250, ...extras});
      let stopped = false; const stop = event.stopPropagation.bind(event);
      event.stopPropagation = () => {stopped = true; stop();};
      events.dispatchEvent(event); return {event, stopped};
    },
  };
  return canvas;
}

test('native visible-canvas listener consumes default/Ctrl/Shift wheels and keeps cursor anchor', () => {
  const canvas = fakeCanvas(), calls: {factor: number; anchor: {x: number; y: number}}[] = [];
  const cleanup = bindSchematicWheel(canvas as unknown as SVGSVGElement, (factor, anchor) => calls.push({factor, anchor}));
  assert.equal(canvas.options?.passive, false);
  for (const extras of [{}, {ctrlKey: true}, {shiftKey: true}]) {
    const {event, stopped} = canvas.dispatch(-100, extras);
    assert.equal(event.defaultPrevented, true); assert.equal(stopped, true);
  }
  assert.equal(calls.length, 3);
  for (const call of calls) {near(call.factor, 1.12); assert.deepEqual(call.anchor, {x: 150, y: 200});}
  const zero = canvas.dispatch(0, {deltaX: 50}); assert.equal(zero.event.defaultPrevented, true); assert.equal(calls.length, 3);
  cleanup(); const after = canvas.dispatch(-100);
  assert.equal(after.event.defaultPrevented, false); assert.equal(after.stopped, false); assert.equal(calls.length, 3);
});

test('detached/hidden canvas ignores wheel; separate surfaces are never bound', () => {
  const canvas = fakeCanvas(), outside = fakeCanvas(); let calls = 0;
  const cleanup = bindSchematicWheel(canvas as unknown as SVGSVGElement, () => calls++);
  assert.equal(outside.dispatch(-100).event.defaultPrevented, false);
  canvas.isConnected = false; assert.equal(canvas.dispatch(-100).event.defaultPrevented, false);
  canvas.isConnected = true; canvas.rect.width = 0; assert.equal(canvas.dispatch(-100).event.defaultPrevented, false);
  canvas.rect.width = 600; canvas.rect.height = 0; assert.equal(canvas.dispatch(-100).event.defaultPrevented, false);
  assert.equal(calls, 0); cleanup();
});

test('rebound listener dispatches once and clamps a cursor outside its current bounds', () => {
  const canvas = fakeCanvas(); let calls = 0; let anchor: unknown;
  bindSchematicWheel(canvas as unknown as SVGSVGElement, () => calls++)();
  const cleanup = bindSchematicWheel(canvas as unknown as SVGSVGElement, (_factor, point) => {calls++; anchor = point;});
  canvas.dispatch(-100, {clientX: -100, clientY: 10000});
  assert.equal(calls, 1); assert.deepEqual(anchor, {x: 0, y: 500}); cleanup();
});

test('wheel through the real controller preserves off-center world anchor and zoom bounds', async () => {
  const fixture = admitCloudDemo(Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.manifest.json')), Uint8Array.from(readFileSync('packages/schematic-workbench/fixtures/cloud-demo.json')));
  const original = JSON.stringify(fixture.circuitIr);
  const model = createCloudSchematicTabs({openSynthetic: async ({projectId}) => ({ok: true, value: {contractVersion: CLOUD_SCHEMATIC_VERSION, projectId, documentRef: fixture.documentRef, artifactRef: fixture.artifactRef, freshness: 'current', reviewedCircuitIr: fixture.circuitIr}})});
  model.setProject(randomUUID()); await model.open();
  const ready = () => {const tab = model.snapshot()[0]!; assert.ok(tab.status === 'ready'); return tab;};
  model.action(ready().key, {type: 'resize-css', width: 600, height: 500, fit: true});
  const canvas = fakeCanvas(); const anchor = {x: 150, y: 200};
  const world = viewerScreenToWorldV1(ready().viewState.viewport, anchor);
  const cleanup = bindSchematicWheel(canvas as unknown as SVGSVGElement, (factor, anchorCss) => model.action(ready().key, {type: 'zoom-css', factor, anchorCss}));
  for (const deltaY of [-100, 100, -0.5, 5]) {
    canvas.dispatch(deltaY); const point = viewerWorldToScreenV1(ready().viewState.viewport, world);
    near(point.x, anchor.x); near(point.y, anchor.y);
  }
  for (let i = 0; i < 100; i++) canvas.dispatch(-10000);
  near(ready().viewState.viewport.zoom, 32);
  for (let i = 0; i < 100; i++) canvas.dispatch(10000);
  near(ready().viewState.viewport.zoom, 0.1);
  const point = viewerWorldToScreenV1(ready().viewState.viewport, world); near(point.x, anchor.x); near(point.y, anchor.y);
  assert.equal(JSON.stringify(fixture.circuitIr), original);
  const before = ready().viewState; model.selectText(); canvas.dispatch(-100); assert.equal(ready().viewState, before);
  cleanup(); model.dispose();
});
