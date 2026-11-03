import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FOLDED_SOURCE_FILES, type FoldedSourceFiles} from '../packages/schematic-workbench/src/folded-source-profile';
import {adaptFoldedReviewedSources} from '../packages/schematic-workbench/src/folded-adapter';
import {buildReviewedSvgSceneV1} from '../packages/schematic-workbench/src/viewer/reviewed-svg-scene';
import {REVIEWED_SCHEMATIC_VERSION, REVIEWED_SCHEMATIC_DATASET, buildSchematicContext,
  type OpenReviewedValue, type ReviewedSchematicDescriptor, type SchematicReference, type WorkbenchReviewedSchematicApi} from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import {createReviewedSchematicTabs, reviewedDocumentKey} from '../apps/desktop/src/renderer/schematic/reviewed-schematic-tabs';
import {ReviewedSchematicInspector, reviewedElementLabels, reviewedSelectionTargets} from '../apps/desktop/src/renderer/schematic/ReviewedSchematicInspector';
import {SchematicViewer} from '../apps/desktop/src/renderer/SchematicViewer';
import {SchematicContextPreview} from '../apps/desktop/src/renderer/schematic/SchematicContextPreview';
import {planSchematicAttachment, updateDraftText, isCurrentSchematicPreview} from '../apps/desktop/src/renderer/schematic/schematic-draft';
import {acceptFileDraft} from '../apps/desktop/src/renderer/agent/file-draft';
import {planFileAttachments} from '../apps/desktop/src/renderer/documents/attachment-plan';
import {emptyDraft} from '../apps/desktop/src/shared/agent/chat-drafts';
import {messageContextFits, schematicCitations} from '../apps/desktop/src/shared/schematic/schematic-context';
import {fitSchematicVisibleBounds, measureSchematicTextBounds, type SchematicTextBounds} from '../apps/desktop/src/renderer/schematic/schematic-visible-fit';
import {schematicCanvasHitTargets, hitTestSchematicCanvas} from '../apps/desktop/src/renderer/schematic/schematic-canvas-hit';
import {hitTestSafeSvgSceneV1} from '../packages/schematic-workbench/src/viewer/svg-scene';
import {devicesInSchematicBox, elementsInSchematicBox, schematicDragBox} from '../apps/desktop/src/renderer/schematic/schematic-box-gestures';

// Product-local, precisely admitted copies only. This is a UI fixture, not an independent mapping oracle.
const sources = Object.fromEntries(Object.keys(FOLDED_SOURCE_FILES).map(name => [name, readFileSync('.local/reviewed-schematic/folded-v1/' + name, 'utf8')])) as FoldedSourceFiles;
const envelope = adaptFoldedReviewedSources(sources);
function value(projectId: string): OpenReviewedValue {return {...envelope, contractVersion: REVIEWED_SCHEMATIC_VERSION, projectId, datasetId: REVIEWED_SCHEMATIC_DATASET, documentRef: envelope.display.documentRef, artifactRef: envelope.display.artifactRef, sourceDigest: envelope.display.sourceDigest, adaptedDigest: envelope.display.adaptedDigest, freshness: 'current'};}
const descriptor: ReviewedSchematicDescriptor = {datasetId: REVIEWED_SCHEMATIC_DATASET, displayName: 'FOLDED_CASCODE', kind: 'reviewed', documentRef: envelope.display.documentRef, artifactRef: envelope.display.artifactRef, sourceDigest: envelope.display.sourceDigest, adaptedDigest: envelope.display.adaptedDigest, availability: 'available'};
const api: WorkbenchReviewedSchematicApi = {
  list: async () => ({ok: true, value: [descriptor]}),
  openReviewed: async request => ({ok: true, value: value(request.projectId)}),
  previewSelection: async request => ({ok: true, value: buildSchematicContext(envelope, {kind: 'schematic_reference', projectId: request.projectId, datasetId: request.datasetId, documentRef: request.documentRef, artifactRef: request.artifactRef, sourceDigest: request.sourceDigest, adaptedDigest: request.adaptedDigest, targets: request.targets})}),
  resolveReference: async request => ({ok: true, value: {document: value(request.projectId), reference: request.reference}}),
};
function ready(model: ReturnType<typeof createReviewedSchematicTabs>, projectId: string) {const tab = model.snapshot().tabs.find(tab => tab.projectId === projectId); assert.ok(tab?.status === 'ready'); return tab;}
async function setup(overrides: Partial<WorkbenchReviewedSchematicApi> = {}) {const model = createReviewedSchematicTabs({...api, ...overrides}), projectId = randomUUID(); model.setProject(projectId); model.setSession(randomUUID()); await model.open(); return {model, projectId};}
function selectDevice(model: ReturnType<typeof createReviewedSchematicTabs>, projectId: string, index = 0) {
  const tab = ready(model, projectId), device = envelope.display.devices[index]!;
  model.action(tab.key, {type: 'primary-select', target: {artifactId: tab.delivery.artifactRef.artifactId, revisionId: tab.delivery.artifactRef.revisionId, occurrencePath: [], definitionId: envelope.display.definitionId, elementKind: 'instance', elementId: device.id}, ctrlKey: false});
}
function reference(model: ReturnType<typeof createReviewedSchematicTabs>, projectId: string): SchematicReference {const tab = ready(model, projectId); return {kind: 'schematic_reference', projectId, datasetId: REVIEWED_SCHEMATIC_DATASET, documentRef: tab.delivery.documentRef, artifactRef: tab.delivery.artifactRef, sourceDigest: tab.delivery.sourceDigest, adaptedDigest: tab.delivery.adaptedDigest, targets: reviewedSelectionTargets(tab.delivery, tab.viewState, 'instances')};}

test('reviewed opens explicitly, binds complete version identity, and keeps project view states independent', async () => {
  let calls = 0; const model = createReviewedSchematicTabs({...api, openReviewed: async request => {calls++; return api.openReviewed(request);}}), a = randomUUID(), b = randomUUID();
  model.setProject(a); assert.equal(calls, 0); await model.open(); await model.open(); assert.equal(calls, 1);
  const first = ready(model, a); assert.equal(first.key, reviewedDocumentKey(first.delivery)); assert.ok(first.key.includes(first.delivery.adaptedDigest));
  model.action(first.key, {type: 'pan-css', deltaCss: {x: 42, y: -20}}); const saved = ready(model, a).viewState;
  model.setProject(b); await model.open(); assert.notEqual(ready(model, b).key, first.key); model.setProject(a); assert.equal(ready(model, a).viewState, saved); model.dispose();
});

test('real scene has only known hit targets, decorative primitives stay non-electrical, and fit shows full source bounds', async () => {
  const {model, projectId} = await setup(); const tab = ready(model, projectId);
  model.action(tab.key, {type: 'resize-css', width: 600, height: 500, fit: true});
  const current = ready(model, projectId), scene = buildReviewedSvgSceneV1({envelope, artifactRef: current.delivery.artifactRef, viewState: current.viewState, renderState: {status: 'ready', freshness: 'current'}});
  assert.equal(scene.hitTargets.filter(hit => hit.target.elementKind === 'instance').length, 33);
  assert.equal(scene.hitTargets.some(hit => hit.target.elementKind === 'pin' || hit.target.elementKind === 'port'), false);
  assert.ok(scene.primitives.some(primitive => primitive.target === null));
  for (const hit of scene.hitTargets) if (hit.shape.kind === 'rect') {assert.ok(hit.shape.minX >= 0 && hit.shape.maxX <= 600); assert.ok(hit.shape.minY >= 0 && hit.shape.maxY <= 500);}
  model.dispose();
});

test('Renderer identifies the real circuit and Inspector preserves raw parameter literals and explicit unknowns', async () => {
  const {model, projectId} = await setup(); const index = envelope.display.devices.findIndex(device => device.parameters.length > 0); selectDevice(model, projectId, index);
  const tab = ready(model, projectId), labels = reviewedElementLabels(tab.delivery), device = envelope.display.devices[index]!;
  const inspector = createElement(ReviewedSchematicInspector, {document: tab.delivery, viewState: tab.viewState});
  const html = renderToStaticMarkup(inspector);
  assert.ok(html.includes('端子角色、电气位置：未知')); assert.ok(html.includes(device.id)); assert.ok(!html.includes('有效W'));
  for (const parameter of device.parameters) assert.ok(html.includes(parameter.valueText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')));
  const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}});
  const props: Parameters<typeof SchematicViewer>[0] = {compact: true, circuitIr: tab.delivery.reviewedCircuitIr, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}, onAction: () => {}, reviewedPresentation: {title: 'FOLDED_CASCODE', scene, elementLabels: labels.elements, netLabels: labels.nets, inspector}};
  const viewer = renderToStaticMarkup(createElement(SchematicViewer, props));
  assert.ok(viewer.includes('FOLDED_CASCODE · 只读')); assert.ok(!viewer.includes('SYNTHETIC REVIEWED FIXTURE') && !viewer.includes('合成原理图 · 只读'));
  assert.ok(viewer.includes('当前原理图导出版本')); assert.ok(!viewer.includes('synthetic revision'));
  assert.ok(!/<text[^>]*scale\(/.test(viewer), 'reviewed text must scale with its geometry');
  const textTags = viewer.match(/<text\b[^>]*>/g) ?? [];
  assert.ok(textTags.length > 0 && textTags.every(tag => tag.includes('schematic-reviewed-text')));
  assert.ok(textTags.some(tag => tag.includes('schematic-primitive-selection-highlight')), 'selected text keeps the same reviewed font class');
  const rotated = scene.primitives.find(primitive => primitive.tag === 'text' && typeof primitive.attributes.transform === 'string');
  assert.ok(rotated); assert.ok(viewer.includes(String(rotated.attributes.transform)), 'source text rotation is preserved');
  const loading = renderToStaticMarkup(createElement(SchematicViewer, {...props, renderState: {status: 'loading'}}));
  assert.ok(loading.includes('正在验证原理图导出版本')); assert.ok(!loading.includes('合成 fixture'));
  model.dispose();
});

test('selection preview is exact, does not send, and refuses a target that is no longer selected', async () => {
  let previews = 0; const {model, projectId} = await setup({previewSelection: async request => {previews++; return api.previewSelection(request);}});
  selectDevice(model, projectId); const selected = ready(model, projectId); const targets = reviewedSelectionTargets(selected.delivery, selected.viewState, 'instances');
  await model.previewSelection(targets); const preview = model.snapshot().preview; assert.ok(preview?.status === 'ready');
  assert.equal(previews, 1); assert.equal(preview.context.excerpt.devices[0]?.id, envelope.display.devices[0]!.id);
  const html = renderToStaticMarkup(createElement(SchematicContextPreview, {context: preview.context, onClose: () => {}, onConfirm: () => {}}));
  assert.ok(html.includes(preview.context.previewDigest)); assert.ok(html.includes('加入草稿不会发送'));
  selectDevice(model, projectId, 1); assert.equal(model.snapshot().preview, null); await model.previewSelection(targets); assert.equal(previews, 1); assert.equal(model.snapshot().preview?.status, 'error'); model.dispose();
});

test('late preview cannot survive a session switch and never changes another session', async () => {
  let release!: (result: Awaited<ReturnType<WorkbenchReviewedSchematicApi['previewSelection']>>) => void;
  let pendingRequest!: Parameters<WorkbenchReviewedSchematicApi['previewSelection']>[0];
  const {model, projectId} = await setup({previewSelection: request => {pendingRequest = request; return new Promise(resolve => {release = resolve;});}});
  selectDevice(model, projectId); const tab = ready(model, projectId); const pending = model.previewSelection(reviewedSelectionTargets(tab.delivery, tab.viewState, 'instances'));
  assert.equal(model.snapshot().preview?.status, 'loading'); model.setSession(randomUUID()); release(await api.previewSelection(pendingRequest)); await pending; assert.equal(model.snapshot().preview, null); model.dispose();
});

test('late open does not revive closed tabs or activate a hidden reviewed tab', async () => {
  let release!: (result: Awaited<ReturnType<WorkbenchReviewedSchematicApi['openReviewed']>>) => void;
  const model = createReviewedSchematicTabs({...api, openReviewed: () => new Promise(resolve => {release = resolve;})}), projectId = randomUUID(); model.setProject(projectId);
  const hidden = model.open(); model.selectText(); release({ok: true, value: value(projectId)}); await hidden; assert.equal(ready(model, projectId).active, false);
  const closed = model.open(true); model.close(); release({ok: true, value: value(projectId)}); await closed; assert.equal(model.snapshot().tabs.length, 0); model.dispose();
});

test('wrong project or changed digest is rejected without displaying fallback geometry', async () => {
  for (const make of [(id: string) => value(randomUUID()), (id: string) => ({...value(id), adaptedDigest: '0'.repeat(64)})]) {
    const {model, projectId} = await setup({openReviewed: async request => ({ok: true, value: make(request.projectId)})});
    assert.equal(model.snapshot().tabs.find(tab => tab.projectId === projectId)?.status, 'error'); model.dispose();
  }
});

test('same-version reference restores the exact devices; cross-project and missing revision do not silently rebind', async () => {
  let resolutions = 0; const {model, projectId} = await setup({resolveReference: async request => {resolutions++; return api.resolveReference(request);}});
  selectDevice(model, projectId); const ref = reference(model, projectId); model.close(); await model.locate(ref);
  assert.equal(ready(model, projectId).viewState.selection[0]?.elementId, envelope.display.devices[0]!.id); assert.equal(ready(model, projectId).delivery.artifactRef.revisionId, ref.artifactRef.revisionId);
  model.setProject(randomUUID()); await model.locate(ref); assert.equal(resolutions, 1); assert.ok(model.snapshot().notice.includes('其他项目')); model.dispose();
  const unavailable = await setup({resolveReference: async () => ({ok: false, error: {code: 'REVISION_UNAVAILABLE'}})});
  selectDevice(unavailable.model, unavailable.projectId); const old = reference(unavailable.model, unavailable.projectId); await unavailable.model.locate(old); assert.equal(unavailable.model.snapshot().tabs[0]?.status, 'error'); unavailable.model.dispose();
});

function contextFor(projectId: string, index: number) {
  const doc = value(projectId), device = envelope.display.devices.filter(device => device.parameters.length > 0)[index]!;
  return buildSchematicContext(envelope, {kind: 'schematic_reference', projectId, datasetId: REVIEWED_SCHEMATIC_DATASET, documentRef: doc.documentRef, artifactRef: doc.artifactRef, sourceDigest: doc.sourceDigest, adaptedDigest: doc.adaptedDigest, targets: [{kind: 'instance', occurrencePath: [], definitionId: envelope.display.definitionId, elementId: device.id}]});
}

test('network preview keeps every explicit member and citation locate highlights without opening details or selecting devices', async () => {
  const {model, projectId} = await setup(), tab = ready(model, projectId);
  const net = [...envelope.display.nets].sort((a, b) => b.memberIds.length - a.memberIds.length)[0]!;
  model.action(tab.key, {type: 'select-net-from-list', occurrencePath: [], definitionId: envelope.display.definitionId, netId: net.id});
  await model.previewSelection(reviewedSelectionTargets(tab.delivery, ready(model, projectId).viewState, 'net'));
  const preview = model.snapshot().preview; assert.ok(preview?.status === 'ready');
  assert.equal(preview.context.excerpt.nets[0]!.members.length, net.memberIds.length);
  assert.equal(preview.context.excerpt.nets[0]!.truncated, false);
  await model.locate(preview.context.reference);
  const located = ready(model, projectId);
  assert.equal(located.viewState.netHighlight?.netId, net.id); assert.equal(located.viewState.selection.length, 0);
  assert.equal(located.viewState.inspector, null);
  const html = renderToStaticMarkup(createElement(ReviewedSchematicInspector, {document: located.delivery, viewState: located.viewState}));
  for (const id of net.memberIds) assert.ok(html.includes(id));
  model.dispose();
});

test('adding a schematic keeps current text/files, rejects duplicates and wrong project without mutating the draft', () => {
  const projectId = randomUUID(), context = contextFor(projectId, 0), draft = {...emptyDraft(), text: '刚输入的下一条问题', revision: 8};
  const before = JSON.stringify(draft), result = planSchematicAttachment(draft, context, projectId);
  assert.ok(result.ok); assert.equal(result.draft.text, draft.text); assert.equal(result.draft.revision, 9); assert.deepEqual(result.draft.schematics, [context]); assert.equal(JSON.stringify(draft), before);
  assert.equal(planSchematicAttachment(result.draft, context, projectId).ok, false);
  assert.equal(planSchematicAttachment(draft, context, randomUUID()).ok, false);
});

test('two-context limit and combined file/text/schematic budget are enforced in either attachment order', () => {
  const projectId = randomUUID(), contexts = [contextFor(projectId, 0), contextFor(projectId, 1)], text = 'x'.repeat(1000);
  const file = {id: randomUUID(), name: 'synthetic.txt', text: 'y'.repeat(12000), startLine: 1, endLine: 1, totalLines: 1};
  assert.equal(messageContextFits(text, [file], []), true);
  assert.equal(messageContextFits(text, [file], contexts), false);
  const draft = {...emptyDraft(), text, files: [file], schematics: [contexts[0]!]};
  assert.equal(planSchematicAttachment(draft, contexts[1]!, projectId).ok, false);
  assert.equal(planFileAttachments({...emptyDraft(), text, schematics: contexts}, [file]).ok, false);
  assert.equal(planSchematicAttachment({...emptyDraft(), schematics: contexts}, contextFor(projectId, 2), projectId).ok, false);
});

test('accepted local snapshot removes only its matching attachment while later text and new context survive', () => {
  const projectId = randomUUID(), first = contextFor(projectId, 0), later = contextFor(projectId, 1);
  const submitted = {...emptyDraft(), text: '先前问题', revision: 4, schematics: [first]};
  const latest = {...submitted, text: '稍后输入的内容', revision: 5, schematics: [first, later]};
  const accepted = acceptFileDraft(latest, submitted);
  assert.equal(accepted.text, latest.text); assert.deepEqual(accepted.schematics, [later]); assert.equal(latest.schematics.length, 2);
});

test('citation links come only from the provided turn contexts, never arbitrary names or out-of-range indices', () => {
  const context = contextFor(randomUUID(), 0);
  const citations = schematicCitations('[原理图1] [原理图2] [原理图99] FOLDED_CASCODE [原理图1]', [context]);
  assert.equal(citations.length, 1); assert.equal(citations[0]?.label, '[原理图1]'); assert.equal(citations[0]?.context, context);
});

test('editing the question after attaching or recovering a history excerpt keeps all attachments', () => {
  const projectId = randomUUID(), context = contextFor(projectId, 0);
  const recovered = planSchematicAttachment({...emptyDraft(), text: '下一条问题'}, context, projectId);
  assert.ok(recovered.ok);
  const edited = updateDraftText(recovered.draft, '请说明选中器件的参数');
  assert.deepEqual(edited.schematics, [context]);
  assert.equal(edited.files, recovered.draft.files); assert.equal(edited.images, recovered.draft.images);
  assert.equal(edited.revision, recovered.draft.revision + 1);
  assert.equal(recovered.draft.text, '下一条问题');
  assert.deepEqual(updateDraftText(edited, '').schematics, [context]);
});

test('history preview opened in session A cannot confirm into session B before effect cleanup', () => {
  const projectId = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID();
  const preview = {projectId, sessionId: sessionA, context: contextFor(projectId, 0)};
  assert.equal(isCurrentSchematicPreview(preview, projectId, sessionA), true);
  assert.equal(isCurrentSchematicPreview(preview, projectId, sessionB), false);
  assert.equal(isCurrentSchematicPreview(preview, randomUUID(), sessionA), false);
  assert.equal(isCurrentSchematicPreview(preview, projectId, ''), false);
  assert.equal(preview.sessionId, sessionA);
});

test('fit includes full left/right parameters and rotated labels in wide and narrow canvases', async () => {
  const {model, projectId} = await setup(); selectDevice(model, projectId);
  const tab = ready(model, projectId), bounds = tab.delivery.reviewedCircuitIr.definitions[0]!.bounds;
  const texts: SchematicTextBounds[] = [
    {minX: bounds.minX - 78, maxX: bounds.minX, minY: bounds.minY - 10, maxY: bounds.minY + 2},
    {minX: bounds.maxX, maxX: bounds.maxX + 78, minY: bounds.maxY - 10, maxY: bounds.maxY + 2},
    {minX: bounds.minX, maxX: bounds.minX + 10, minY: bounds.minY - 68, maxY: bounds.minY},
  ];
  for (const size of [{width: 670, height: 869}, {width: 420, height: 640}, {width: 320, height: 520}]) {
    const viewport = fitSchematicVisibleBounds(bounds, texts, size); assert.ok(viewport);
    model.action(tab.key, {type: 'fit', viewport});
    const fitted = ready(model, projectId); assert.equal(fitted.viewState.selection.length, 1);
    for (const text of texts) {
      assert.ok(text.minX * viewport.zoom + viewport.translateXCss >= 24 - 1e-6 && text.maxX * viewport.zoom + viewport.translateXCss <= size.width - 24 + 1e-6);
      assert.ok(text.minY * viewport.zoom + viewport.translateYCss >= 24 - 1e-6 && text.maxY * viewport.zoom + viewport.translateYCss <= size.height - 24 + 1e-6);
    }
    assert.equal(fitted.delivery, tab.delivery); assert.deepEqual(fitted.viewState.viewport, viewport);
  }
  model.dispose();
});

test('actual scaled SVG text rectangles map back to the same world bounds at every zoom', () => {
  for (const zoom of [0.2, 0.7, 4]) {
    const viewport = {zoom, translateXCss: 37, translateYCss: -19, widthCss: 670, heightCss: 869};
    const left = 930, top = 131;
    const node = {getBoundingClientRect: () => ({left: left + 822 * zoom + 37, right: left + 900 * zoom + 37, top: top - 130 * zoom - 19, bottom: top - 118 * zoom - 19})};
    const canvas = {getBoundingClientRect: () => ({left, top}), querySelectorAll: () => [node]} as unknown as SVGSVGElement;
    const actual = measureSchematicTextBounds(canvas, viewport)[0]!;
    for (const [key, expected] of Object.entries({minX: 822, maxX: 900, minY: -130, maxY: -118})) assert.ok(Math.abs(actual[key as keyof SchematicTextBounds] - expected) < 1e-8);
  }
});

test('visible fit keeps the existing minimum zoom and refuses invalid sizes', () => {
  const bounds = {minX: 0, minY: 0, maxX: 1000, maxY: 600};
  const texts = [{minX: 1000, maxX: 1100, minY: 590, maxY: 600}];
  assert.equal(fitSchematicVisibleBounds(bounds, texts, {width: 120, height: 500}), null);
  assert.equal(fitSchematicVisibleBounds(bounds, texts, {width: NaN, height: 500}), null);
});

test('real MOS body clicks resolve their own identity despite overlapping source annotation bounds', async () => {
  const {model, projectId} = await setup();
  let originalMisses = 0;
  for (const width of [320, 670, 1200]) {
    const originalTab = ready(model, projectId);
    model.action(originalTab.key, {type: 'resize-css', width, height: 700, fit: true});
    const tab = ready(model, projectId);
    const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}});
    const corrected = {...scene, hitTargets: schematicCanvasHitTargets(scene, true)};
    assert.equal(corrected.hitTargets.length, scene.hitTargets.length);
    assert.deepEqual(corrected.hitTargets.map(hit => hit.target), scene.hitTargets.map(hit => hit.target));
    for (const device of envelope.display.devices.filter(device => device.displayKind !== 'placeholder')) {
      // Read actual admitted drawing coordinates, not hit rectangles or Inspector rows.
      const points = envelope.display.primitives.flatMap(primitive => primitive.sourceId === device.id && primitive.sourceKind === 'instance' && primitive.tag === 'polyline' ? primitive.points : []);
      const world = {x: (Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))) / 2,
        y: (Math.min(...points.map(point => point.y)) + Math.max(...points.map(point => point.y))) / 2};
      const point = {x: world.x * scene.viewport.zoom + scene.viewport.translateXCss, y: world.y * scene.viewport.zoom + scene.viewport.translateYCss};
      if (hitTestSafeSvgSceneV1(scene, {pointCss: point, toleranceCssPx: 6})?.target.elementId !== device.id) originalMisses++;
      const hit = hitTestSchematicCanvas(corrected, point, 6, true);
      assert.equal(hit?.target.elementId, device.id, width + 'px: ' + device.name);
      model.action(tab.key, {type: 'primary-select', target: hit!.target, ctrlKey: false});
      assert.equal(ready(model, projectId).viewState.selection[0]?.elementId, device.id);
    }
  }
  assert.ok(originalMisses >= 2, 'the original hit path must reproduce the reported neighboring-device errors');
  model.dispose();
});

test('body selection stays stable under highlights, Ctrl toggles, and empty canvas clears without mutating source bounds', async () => {
  const {model, projectId} = await setup(); const tab = ready(model, projectId);
  const makeScene = () => buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: ready(model, projectId).viewState, renderState: {status: 'ready', freshness: 'current'}});
  const first = makeScene(), originalBounds = JSON.stringify(first.hitTargets);
  const bodyHits = schematicCanvasHitTargets(first, true).filter(hit => hit.target.elementKind === 'instance' && hit.shape.kind === 'rect');
  for (const body of bodyHits.slice(0, 2)) {
    assert.equal(body.shape.kind, 'rect'); if (body.shape.kind !== 'rect') throw new Error('Expected body');
    const scene = makeScene(), hits = schematicCanvasHitTargets(scene, true);
    const point = {x: (body.shape.minX + body.shape.maxX) / 2, y: (body.shape.minY + body.shape.maxY) / 2};
    const hit = hitTestSchematicCanvas({...scene, hitTargets: hits}, point, 6, true)!;
    model.action(tab.key, {type: 'primary-select', target: hit.target, ctrlKey: true});
  }
  assert.equal(ready(model, projectId).viewState.selection.length, 2);
  const selected = makeScene(); assert.deepEqual(schematicCanvasHitTargets(selected, true), schematicCanvasHitTargets(first, true));
  model.action(tab.key, {type: 'select-net-from-list', occurrencePath: [], definitionId: envelope.display.definitionId, netId: envelope.display.nets[0]!.id});
  assert.deepEqual(schematicCanvasHitTargets(makeScene(), true), schematicCanvasHitTargets(first, true), 'net overlay must not change or duplicate body targets');
  model.action(tab.key, {type: 'primary-select', target: ready(model, projectId).viewState.selection[0]!, ctrlKey: true});
  assert.equal(ready(model, projectId).viewState.selection.length, 1);
  const empty = hitTestSchematicCanvas({...selected, hitTargets: schematicCanvasHitTargets(selected, true)}, {x: -1000, y: -1000}, 6, true);
  assert.equal(empty, null); model.action(tab.key, {type: 'primary-select', target: empty, ctrlKey: false});
  assert.equal(ready(model, projectId).viewState.selection.length, 0);
  assert.equal(JSON.stringify(first.hitTargets), originalBounds); assert.equal(schematicCanvasHitTargets(first, false), first.hitTargets);
  assert.equal(hitTestSchematicCanvas({...selected, geometryVisible: false}, {x: 0, y: 0}, 6, true), null);
  model.dispose();
});

test('MB2-1 marquee needs only its displayed symbol and endpoints in every drag direction after zoom and pan', async () => {
  const {model, projectId} = await setup(), tab = ready(model, projectId);
  const device = envelope.display.devices.find(device => device.name === 'MB2-1')!;
  let oldMisses = 0;
  for (const transform of [{factor: 1, x: 0, y: 0}, {factor: 1.8, x: 51, y: -37}, {factor: 0.5, x: -28, y: 42}]) {
    model.action(tab.key, {type: 'zoom-css', factor: transform.factor, anchorCss: {x: 360, y: 260}});
    model.action(tab.key, {type: 'pan-css', deltaCss: {x: transform.x, y: transform.y}});
    const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: ready(model, projectId).viewState, renderState: {status: 'ready', freshness: 'current'}});
    const symbols = {...scene, hitTargets: schematicCanvasHitTargets(scene, true)};
    // Source nontext geometry supplies both visible body and display endpoints;
    // this does not invent electrical terminal anchors.
    const points = envelope.display.primitives.flatMap(primitive => primitive.sourceId === device.id && primitive.sourceKind === 'instance' && primitive.tag === 'polyline' ? primitive.points : []);
    const v = scene.viewport, x1 = Math.min(...points.map(p => p.x)) * v.zoom + v.translateXCss - 1;
    const x2 = Math.max(...points.map(p => p.x)) * v.zoom + v.translateXCss + 1;
    const y1 = Math.min(...points.map(p => p.y)) * v.zoom + v.translateYCss - 1;
    const y2 = Math.max(...points.map(p => p.y)) * v.zoom + v.translateYCss + 1;
    for (const [start, end] of [[{x: x1, y: y1}, {x: x2, y: y2}], [{x: x2, y: y2}, {x: x1, y: y1}], [{x: x2, y: y1}, {x: x1, y: y2}], [{x: x1, y: y2}, {x: x2, y: y1}]] as const) {
      const box = schematicDragBox(start, end, v);
      if (!devicesInSchematicBox(scene, box).some(target => target.elementId === device.id)) oldMisses++;
      const selected = devicesInSchematicBox(symbols, box);
      assert.deepEqual(selected.map(target => target.elementId), [device.id]);
      model.action(tab.key, {type: 'marquee-select', targets: selected, ctrlKey: false});
      assert.deepEqual(ready(model, projectId).viewState.selection.map(target => target.elementId), [device.id]);
    }
    assert.equal(devicesInSchematicBox(symbols, {x: x1, y: y1, width: (x2 - x1) / 2, height: y2 - y1}).length, 0, 'partial body coverage is not full containment');
    const text = scene.primitives.find(primitive => primitive.tag === 'text' && primitive.target?.elementId === device.id && primitive.text === device.name)!;
    const textX = Number(text.attributes.x) * v.zoom + v.translateXCss, textY = Number(text.attributes.y) * v.zoom + v.translateYCss;
    const textOnly = {x: textX - 20 * v.zoom, y: textY - 10 * v.zoom, width: 20 * v.zoom, height: 10 * v.zoom};
    assert.equal(devicesInSchematicBox(symbols, textOnly).length, 0, 'name text alone never selects the device');
  }
  assert.equal(oldMisses, 12, 'old exported bounds reproduce the oversized marquee failure');
  model.dispose();
});

test('symbol marquee appends only enclosed neighbors with Ctrl and keeps source bounds immutable', async () => {
  const {model, projectId} = await setup(), tab = ready(model, projectId);
  const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}});
  const original = JSON.stringify(scene.hitTargets), symbols = {...scene, hitTargets: schematicCanvasHitTargets(scene, true)};
  for (const name of ['MB2-1', 'MB2-2', 'MB2-1']) {
    const id = envelope.display.devices.find(device => device.name === name)!.id;
    const body = symbols.hitTargets.find(hit => hit.target.elementId === id)!; assert.ok(body.shape.kind === 'rect');
    const b = body.shape, selected = devicesInSchematicBox(symbols, {x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY});
    assert.deepEqual(selected.map(target => target.elementId), [id]);
    model.action(tab.key, {type: 'marquee-select', targets: selected, ctrlKey: true});
  }
  assert.equal(ready(model, projectId).viewState.selection.length, 2);
  assert.equal(JSON.stringify(scene.hitTargets), original);
  assert.equal(envelope.display.terminals.every(terminal => terminal.positionStatus === 'unavailable_in_current_view' && terminal.position === null), true);
  model.dispose();
});

test('mixed marquee selects the M39 loop wires and VDDA label locally without selecting distant same-net elements', async () => {
  const {model, projectId} = await setup(); const tab = ready(model, projectId), before = JSON.stringify(envelope);
  const build = () => buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: ready(model, projectId).viewState, renderState: {status: 'ready', freshness: 'current'}});
  const scene = build(), symbols = {...scene, hitTargets: schematicCanvasHitTargets(scene, true)}, v = scene.viewport;
  const corners = [{x: 260 * v.zoom + v.translateXCss, y: -245 * v.zoom + v.translateYCss}, {x: 345 * v.zoom + v.translateXCss, y: -155 * v.zoom + v.translateYCss}];
  const box = {x: corners[0]!.x, y: corners[0]!.y, width: corners[1]!.x - corners[0]!.x, height: corners[1]!.y - corners[0]!.y};
  const targets = elementsInSchematicBox(symbols, box);
  assert.deepEqual(targets.filter(t => t.elementKind === 'instance').map(t => t.elementId), ['instance:5:M39']);
  assert.deepEqual(targets.filter(t => t.elementKind === 'wire').map(t => t.elementId), Array.from({length: 10}, (_, n) => 'wire:' + (127 + n)));
  assert(targets.some(t => t.elementKind === 'label' && envelope.display.labels.find(l => l.id === t.elementId)?.text === 'VDDA'));
  let emissions = 0; const off = model.subscribe(() => emissions++);
  model.action(tab.key, {type: 'marquee-select', targets, ctrlKey: false}); assert.equal(emissions, 1); off();
  const selected = ready(model, projectId), highlighted = build().layers.find(l => l.kind === 'selection')!.primitives;
  for (const target of targets) assert(highlighted.some(p => p.target?.elementId === target.elementId));
  assert.equal(selected.viewState.netHighlight, null);
  const remote = envelope.display.primitives.find(p => p.sourceKind === 'wire' && p.netId === 'net:13:VDDA' && !targets.some(t => t.elementId === p.sourceId))!;
  assert(remote); assert(!highlighted.some(p => p.target?.elementId === remote.sourceId));
  assert.deepEqual(reviewedSelectionTargets(tab.delivery, selected.viewState, 'net'), [{kind: 'net', occurrencePath: [], definitionId: envelope.display.definitionId, netId: 'net:13:VDDA'}]);
  const html = renderToStaticMarkup(createElement(ReviewedSchematicInspector, {document: tab.delivery, viewState: selected.viewState}));
  assert(html.includes('已选线段 10')); assert(html.includes('VDDA')); assert(html.includes('仅选中局部元素'));
  assert.equal(JSON.stringify(envelope), before); model.dispose();
});

test('mixed marquee supports wire-only and label-only selection, Ctrl append, exact network preview and invalidation', async () => {
  const {model, projectId} = await setup(); const tab = ready(model, projectId);
  const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}});
  const wire = scene.hitTargets.find(h => h.target.elementId === 'wire:127')!.target;
  const labelId = envelope.display.labels.find(l => l.targetKind === 'net' && l.targetId === 'net:13:VDDA')!.id;
  const label = scene.hitTargets.find(h => h.target.elementId === labelId)!.target;
  model.action(tab.key, {type: 'marquee-select', targets: [wire], ctrlKey: false});
  assert.equal(ready(model, projectId).viewState.selection[0]?.elementKind, 'wire');
  await model.previewSelection(reviewedSelectionTargets(tab.delivery, ready(model, projectId).viewState, 'net'));
  assert.equal(model.snapshot().preview?.status, 'ready');
  model.action(tab.key, {type: 'marquee-select', targets: [label, wire], ctrlKey: true});
  assert.equal(ready(model, projectId).viewState.selection.length, 2); assert.equal(model.snapshot().preview, null);
  model.action(tab.key, {type: 'marquee-select', targets: [label], ctrlKey: false});
  assert.equal(ready(model, projectId).viewState.selection[0]?.elementKind, 'label');
  assert.equal(reviewedSelectionTargets(tab.delivery, ready(model, projectId).viewState, 'net').length, 1);
  const prior = ready(model, projectId).viewState;
  model.action(tab.key, {type: 'marquee-select', targets: [wire, {...label, revisionId: 'wrong'}], ctrlKey: false}); assert.equal(ready(model, projectId).viewState, prior);
  model.action(tab.key, {type: 'select-net-from-list', definitionId: envelope.display.definitionId, occurrencePath: [], netId: 'net:13:VDDA'});
  assert(ready(model, projectId).viewState.netHighlight);
  model.action(tab.key, {type: 'marquee-select', targets: [], ctrlKey: false});
  assert.equal(ready(model, projectId).viewState.selection.length, 0); assert.equal(ready(model, projectId).viewState.netHighlight, null);
  model.dispose();
});

test('mixed marquee requires entire wire geometry, ignores crossing-only wires and does not invent pin targets', async () => {
  const {model, projectId} = await setup(); const tab = ready(model, projectId);
  const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}});
  const wire = scene.hitTargets.find(h => h.target.elementId === 'wire:127')!; assert(wire.shape.kind === 'polyline');
  const a = wire.shape.points[0]!, b = wire.shape.points[1]!;
  const box = {x: Math.min(a.x, b.x) - 1, y: a.y - 3, width: Math.abs(a.x - b.x) + 2, height: 6};
  assert(elementsInSchematicBox(scene, box).some(t => t.elementId === wire.target.elementId));
  assert(!elementsInSchematicBox(scene, {...box, x: box.x + box.width / 2, width: box.width / 2}).some(t => t.elementId === wire.target.elementId));
  assert(!elementsInSchematicBox(scene, box).some(t => t.elementKind === 'pin' || t.elementKind === 'port'));
  assert.deepEqual(elementsInSchematicBox({...scene, geometryVisible: false}, box), []);
  assert.deepEqual(elementsInSchematicBox(scene, {...box, x: NaN}), []);
  assert.deepEqual(elementsInSchematicBox(scene, {...box, height: 2}), []);
  model.dispose();
});

test('compact schematic gives the toolbar row back to the canvas and advertises the context menu', async () => {
  const {model, projectId} = await setup(); const tab = ready(model, projectId);
  const scene = buildReviewedSvgSceneV1({envelope, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}});
  const labels = reviewedElementLabels(tab.delivery);
  const html = renderToStaticMarkup(createElement(SchematicViewer, {compact: true, circuitIr: envelope.reviewedCircuitIr, artifactRef: tab.delivery.artifactRef, viewState: tab.viewState, renderState: {status: 'ready', freshness: 'current'}, onAction: () => {}, reviewedPresentation: {title: 'FOLDED_CASCODE', scene, elementLabels: labels.elements, netLabels: labels.nets, inspector: null}}));
  assert(!html.includes('schematic-viewer-toolbar')); assert(!html.includes('适合窗口</button>'));
  assert(html.includes('右键打开操作菜单')); assert(html.includes('data-schematic-canvas="true"'));
  model.dispose();
});
