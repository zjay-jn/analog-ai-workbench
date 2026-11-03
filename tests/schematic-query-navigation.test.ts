import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createElement, isValidElement, type ReactNode, type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {OaReadToolValue} from '../apps/desktop/src/shared/agent/oa-read';
import type {ChatTurnActivity} from '../apps/desktop/src/shared/agent/chat-turns';
import type {SessionTurn} from '../apps/desktop/src/shared/agent/chat-sessions';
import {REVIEWED_SCHEMATIC_VERSION, REVIEWED_SCHEMATIC_DATASET, type OpenReviewedValue, type SchematicReference,
  type WorkbenchReviewedSchematicApi} from '../apps/desktop/src/shared/schematic/reviewed-schematic';
import {FOLDED_SOURCE_FILES, type FoldedSourceFiles} from '../packages/schematic-workbench/src/folded-source-profile';
import {adaptFoldedReviewedSources} from '../packages/schematic-workbench/src/folded-adapter';
import {schematicQueryLinks, relatedSchematicQueries, schematicAnswerEvidence, schematicAnswerReferences, appendSchematicQuestion,
  FOLDED_QUERY_PROMPT, oaDisplayReferences, schematicAnswerText} from '../apps/desktop/src/renderer/schematic/schematic-query-links';
import {SchematicRelatedQueries} from '../apps/desktop/src/renderer/schematic/SchematicRelatedQueries';
import {createReviewedSchematicTabs} from '../apps/desktop/src/renderer/schematic/reviewed-schematic-tabs';
import {reviewedSelectionTargets} from '../apps/desktop/src/renderer/schematic/ReviewedSchematicInspector';
import {OaReadResults} from '../apps/desktop/src/renderer/agent/OaReadResults';
import {ChatAgentParts} from '../apps/desktop/src/renderer/agent/ChatAgentParts';

Object.defineProperty(globalThis, 'window', {configurable: true, value: {matchMedia: () => ({matches: true})}});

// Only existing admitted product-local display files; OA and cloud calls are synthetic.
const sources = Object.fromEntries(Object.keys(FOLDED_SOURCE_FILES).map(name => [name, readFileSync('.local/reviewed-schematic/folded-v1/' + name, 'utf8')])) as FoldedSourceFiles;
const envelope = adaptFoldedReviewedSources(sources);
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId = 'session-test', turnId = 'turn-test';
const document: OpenReviewedValue = {...envelope, contractVersion: REVIEWED_SCHEMATIC_VERSION, projectId,
  datasetId: REVIEWED_SCHEMATIC_DATASET, documentRef: envelope.display.documentRef, artifactRef: envelope.display.artifactRef,
  sourceDigest: envelope.display.sourceDigest, adaptedDigest: envelope.display.adaptedDigest, freshness: 'current'};
const instance = document.display.devices[0]!, net = document.display.nets.find(net => net.wireIds.length)!;
const reference: SchematicReference = {kind: 'schematic_reference', projectId, datasetId: document.datasetId,
  documentRef: document.documentRef, artifactRef: document.artifactRef, sourceDigest: document.sourceDigest, adaptedDigest: document.adaptedDigest,
  targets: [{kind: 'instance', occurrencePath: [], definitionId: document.display.definitionId, elementId: instance.id}]};
const netReference: SchematicReference = {...reference, targets: [{kind: 'net', occurrencePath: [], definitionId: document.display.definitionId, netId: net.id}]};
const revision = 'sha256:' + '1'.repeat(64);
function value(ref = reference): OaReadToolValue {
  return {kind: 'oa_read', source: {runId: 'run-test', projectId, bindingId: 'binding-test', projectIdentity: 'identity-test',
    designId: 'folded-cascode-copy', designHandle: 'handle-test', snapshotId: 'snapshot-test', factsDigest: '2'.repeat(64),
    sourceKind: 'saved_oa', environmentBindingId: 'environment-test', libraryMappingIdentity: 'mapping-test',
    lcv: {library: 'FOLDED_CASCODE', cell: 'FOLDED_CASCODE', view: 'schematic'}, capturedAt: '2026-10-28T06:00:00.000Z',
    readMode: 'fresh_process_read_only', savedRevision: revision, revisionMethod: 'copied-file-manifest-sha256-v1',
    sourceObservation: {beforeDigest: revision, afterDigest: revision, copiedDigest: revision, state: 'observed_unchanged', transactionLock: false},
    dirty: {status: 'unknown', reason: 'not_observed'}, adapterVersion: 'synthetic', freshness: 'captured_snapshot'},
    evidenceId: 'evidence-test', resultDigest: '3'.repeat(64), coverage: {collection: 'instances', selector: {kind: 'all'},
      sourceStatus: 'complete', returned: 1, examined: 1, observedTotal: 1, total: 1, complete: true, nextCursor: null,
      limitReason: null, fieldUnknown: 0, fieldUnsupported: 0, excludedScopes: ['hierarchy', 'master_contents', 'effective_cdf', 'device_semantic_roles']},
    data: {kind: 'instances', items: [{id: 'instance:0', name: instance.name, master: instance.master,
      parameters: {status: 'complete', observedCount: 2}, terminals: {status: 'complete', observedCount: 4}}]},
    displayReferences: [{label: instance.name, objectRef: {kind: 'instance', objectId: 'instance:0', designHandle: 'handle-test', savedRevision: revision, snapshotId: 'snapshot-test'}, reference: ref}]};
}
function activity(result = value()): ChatTurnActivity {
  return {sessionId, turnId, version: 1, execution: null, run: null, nextSequence: 2, hasMore: false,
    parts: [{kind: 'run_event', partId: 'part-1', sequence: 1, runId: 'run-test', event: {runId: 'run-test', sequence: 1,
      time: '2026-10-28T06:00:00.000Z', type: 'tool.completed', data: {sessionId: 'native-test', messageId: 'message-test', callId: 'call-test',
        toolName: 'oa_query_instances', arguments: {designHandle: 'handle-test', savedRevision: revision, selector: {kind: 'all'}, cursor: null}, result: {ok: true, value: result}}}}]};
}
const turn: SessionTurn = {id: turnId, user: 'MB5 的保存参数是什么？', assistant: '查询依据 [原理图:evidence-test]', status: 'completed', error: ''};
function links(result = value()) {return schematicQueryLinks(sessionId, projectId, [turn], {[turnId]: {activity: activity(result)}});}
function buttons(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [...(node.type === 'button' ? [node] : []), ...buttons(node.props.children as ReactNode)];
}
function label(button: ReactElement<Record<string, unknown>>) {return renderToStaticMarkup(button);}

test('OA navigation indexes only saved successful results owned by the current chat/project/run/snapshot', () => {
  assert.equal(links().length, 1);
  assert.equal(schematicQueryLinks('other-session', projectId, [turn], {[turnId]: {activity: activity()}}).length, 0);
  assert.equal(schematicQueryLinks(sessionId, 'other-project', [turn], {[turnId]: {activity: activity()}}).length, 0);
  const wrongRun = value(); assert.equal(links({...wrongRun, source: {...wrongRun.source, runId: 'other-run'}}).length, 0);
  const wrongSnapshot = value(); assert.equal(links({...wrongSnapshot, source: {...wrongSnapshot.source, snapshotId: 'other-snapshot'}}).length, 0);
  const duplicate = activity(); assert.equal(schematicQueryLinks(sessionId, projectId, [turn], {[turnId]: {activity: {...duplicate, parts: [...duplicate.parts, ...duplicate.parts]}}}).length, 1);
});

test('reverse lookup requires every source identity field, exact object kind/id and same occurrence', () => {
  const indexed = links(); assert.equal(relatedSchematicQueries(document, reference.targets, indexed).length, 1);
  const variants = [
    {...document, projectId: 'other-project'}, {...document, sourceDigest: 'changed'}, {...document, adaptedDigest: 'changed'},
    {...document, documentRef: {...document.documentRef, revisionId: 'version-B'}},
    {...document, documentRef: {...document.documentRef, documentId: 'another-document'}},
    {...document, artifactRef: {...document.artifactRef, revisionId: 'adapter-B'}},
    {...document, artifactRef: {...document.artifactRef, artifactId: 'another-artifact'}},
  ];
  for (const changed of variants) assert.equal(relatedSchematicQueries(changed, reference.targets, indexed).length, 0);
  assert.equal(relatedSchematicQueries(document, netReference.targets, indexed).length, 0);
  assert.equal(relatedSchematicQueries(document, [], indexed).length, 0);
  assert.equal(relatedSchematicQueries(document, [{kind: 'instance', occurrencePath: [], definitionId: 'other-definition', elementId: instance.id}], indexed).length, 0);
  assert.equal(relatedSchematicQueries(document, [{kind: 'instance', occurrencePath: [], definitionId: document.display.definitionId, elementId: 'same-name-different-id'}], indexed).length, 0);
  // Retaining B never rewrites the original A reference.
  assert.equal(relatedSchematicQueries(document, reference.targets, indexed)[0]!.reference, reference);
});

test('answer tokens resolve only this turn evidence and no mapping never falls back to a historical name match', () => {
  assert.equal(schematicAnswerReferences(turn.assistant, [value()]).length, 1);
  assert.equal(schematicAnswerReferences('[原理图:other-evidence]', [value()]).length, 0);
  assert.equal(schematicAnswerReferences(turn.assistant, [{...value(), displayReferences: []}]).length, 0);
  const mismatched = {...value(), source: {...value().source, savedRevision: 'version-B'}};
  assert.equal(oaDisplayReferences(mismatched).length, 0);
  assert.equal(schematicAnswerReferences(turn.assistant, [mismatched]).length, 0);
  assert.equal(schematicAnswerText(turn.assistant, [value()]), '查询依据 ');
  assert.equal(schematicAnswerText('[原理图:unknown]', [value()]), '〔原理图依据未核实〕');
});

test('design evidence remains in its tool details without a redundant answer action or fake location', () => {
  const overview: OaReadToolValue = {...value(), displayReferences: [], data: {kind: 'design', observedCounts: {instances: 33, nets: 17, ports: 6},
    parameterEncoding: 'skill_stored_value_serialization', coverage: {instances: 'complete', nets: 'complete', ports: 'complete', parameters: 'complete',
      terminals: 'complete', netMembers: 'complete', hierarchy: 'not_read', masterContents: 'not_read', cdf: 'not_read'}}};
  const callActivity = activity(overview), first = callActivity.parts[0]!;
  assert.equal(first.kind, 'run_event'); if (first.kind !== 'run_event' || first.event.type !== 'tool.completed') throw Error('fixture');
  const openActivity: ChatTurnActivity = {...callActivity, parts: [{...first, event: {...first.event,
    data: {...first.event.data, toolName: 'oa_open_design', arguments: {designId: 'folded-cascode-copy', refresh: false}}}}]};
  const opened: unknown[] = [], located: unknown[] = [];
  const props = {turn, activity: openActivity, onRetry() {}, onAdvance() {}, onOpen: (target: unknown) => opened.push(target), onSchematic: (ref: SchematicReference) => located.push(ref)};
  const actions = buttons(ChatAgentParts(props));
  assert.equal(actions.length, 0);assert.deepEqual(opened, []);assert.equal(located.length, 0);
  const html = renderToStaticMarkup(createElement(ChatAgentParts, props));
  assert.match(html,/oa_open_design/);assert.ok(!html.includes('打开了电路副本'));assert.ok(!html.includes('查看结果'));assert.ok(!html.includes('运行记录'));
  assert.ok(!html.includes('查看依据')); assert.ok(!html.includes('查看原理图')); assert.ok(!html.includes('evidence-test')); assert.ok(!html.includes('在图中定位'));
  const detail = renderToStaticMarkup(createElement(OaReadResults, {value: overview}));
  assert.ok(detail.includes('本条为设计概览，未指定可定位对象')); assert.ok(!detail.includes('尚无已核对的图形映射'));
  assert.equal(schematicAnswerEvidence(turn.assistant, [overview]).length, 1);
});

test('one object from two evidence pages is shown once only when every source, snapshot and object identity agrees', () => {
  const first = value(), second = {...value(), evidenceId: 'evidence-parameters'};
  const text = '[原理图:evidence-test] [原理图:evidence-parameters]';
  assert.equal(schematicAnswerReferences(text, [first, second]).length, 1);
  assert.equal(schematicAnswerText(text, [first, second]), ' ');
  const newSnapshot: OaReadToolValue = {...second, source: {...second.source, snapshotId: 'snapshot-B'},
    displayReferences: second.displayReferences!.map(display => ({...display, objectRef: {...display.objectRef, snapshotId: 'snapshot-B'}}))};
  assert.equal(schematicAnswerReferences(text, [first, newSnapshot]).length, 2);
  const newVersion: OaReadToolValue = {...second, source: {...second.source, savedRevision: 'version-B'},
    displayReferences: second.displayReferences!.map(display => ({...display, objectRef: {...display.objectRef, savedRevision: 'version-B'}}))};
  assert.equal(schematicAnswerReferences(text, [first, newVersion]).length, 2);
  const newObject: OaReadToolValue = {...second, displayReferences: second.displayReferences!.map(display => ({...display, objectRef: {...display.objectRef, objectId: 'instance:1'}}))};
  assert.equal(schematicAnswerReferences(text, [first, newObject]).length, 2);
  const base = activity(first), eventPart = base.parts[0]!;
  if (eventPart.kind !== 'run_event' || eventPart.event.type !== 'tool.completed') throw Error('fixture');
  const twoPages: ChatTurnActivity = {...base, nextSequence: 5, parts: [eventPart,
    {kind: 'text', partId: 'answer-1', sequence: 2, text: '[原理图:evidence-test]'},
    {...eventPart, partId: 'second-query', sequence: 3, event: {...eventPart.event, sequence: 2,
      data: {...eventPart.event.data, callId: 'call-second', result: {ok: true, value: second}}}},
    {kind: 'text', partId: 'answer-2', sequence: 4, text: '[原理图:evidence-parameters]'}]};
  const rendered = ChatAgentParts({turn: {...turn, assistant: text}, activity: twoPages, onRetry() {}, onAdvance() {}, onOpen() {}, onSchematic() {}});
  assert.equal(buttons(rendered).filter(button => label(button).includes('查看原理图')).length, 1);
  const secondObject = {...second, displayReferences: second.displayReferences!.map(display => ({...display, label: net.name ?? net.id, reference: netReference,
    objectRef: {...display.objectRef, kind: 'net' as const, objectId: 'net:1'}}))};
  const differentObjects = {...twoPages, parts: twoPages.parts.map(part => part.kind === 'run_event' && part.event.type === 'tool.completed' && part.partId === 'second-query'
    ? {...part, event: {...part.event, data: {...part.event.data, result: {ok: true as const, value: secondObject}}}} : part)};
  let destination: SchematicReference | undefined;
  const singleEntry = buttons(ChatAgentParts({turn: {...turn, assistant: text}, activity: differentObjects, onRetry() {}, onAdvance() {}, onOpen() {}, onSchematic(ref) {destination=ref;}}))
    .filter(button => label(button).includes('查看原理图'));
  assert.equal(singleEntry.length, 1); (singleEntry[0]!.props.onClick as () => void)(); assert.equal(destination, reference);
});

test('unknown or other-turn evidence is visibly unverified and never becomes a details or location link', () => {
  const unresolvedTurn = {...turn, assistant: '[原理图:from-other-turn]'};
  const rendered = ChatAgentParts({turn: unresolvedTurn, activity: activity(), onRetry() {}, onAdvance() {}, onOpen() {}, onSchematic() {}});
  assert.equal(buttons(rendered).filter(button => label(button).includes('查看依据') || label(button).includes('查看原理图')).length, 0);
  const html = renderToStaticMarkup(createElement(ChatAgentParts, {turn: unresolvedTurn, activity: activity(), onRetry() {}, onAdvance() {}, onOpen() {}}));
  assert.ok(html.includes('原理图依据未核实')); assert.ok(!html.includes('from-other-turn'));
});

test('query and answer buttons preserve the reference then existing viewer locates it; selected wire finds network evidence', async () => {
  let resolved: SchematicReference | undefined;
  const api: WorkbenchReviewedSchematicApi = {
    list: async () => ({ok: true, value: [{datasetId: document.datasetId, displayName: 'FOLDED_CASCODE', kind: 'reviewed',
      documentRef: document.documentRef, artifactRef: document.artifactRef, sourceDigest: document.sourceDigest, adaptedDigest: document.adaptedDigest, availability: 'available'}]}),
    openReviewed: async () => ({ok: true, value: document}),
    previewSelection: async () => ({ok: false, error: {code: 'DATA_UNAVAILABLE'}}),
    resolveReference: async request => {resolved = request.reference; return {ok: true, value: {document, reference: request.reference}};},
  };
  const model = createReviewedSchematicTabs(api); model.setProject(projectId); model.setSession(sessionId);
  let target: SchematicReference | undefined;
  const resultButtons = buttons(OaReadResults({value: value(), onLocate: ref => {target = ref;}}));
  assert.equal(resultButtons.length, 1); (resultButtons[0]!.props.onClick as () => void)(); assert.equal(target, reference);
  await model.locate(target!); assert.deepEqual(resolved, reference);
  let tab = model.snapshot().tabs[0]!; assert.equal(tab.status, 'ready'); if (tab.status !== 'ready') throw Error('not ready');
  assert.equal(tab.viewState.selection[0]?.elementId, instance.id);
  const answerButtons = buttons(ChatAgentParts({turn, activity: activity(), onRetry() {}, onOpen() {}, onAdvance() {}, onSchematic: ref => {target = ref;}}));
  const answer = answerButtons.find(button => label(button).includes('查看原理图')); assert.ok(answer); target = undefined;
  (answer.props.onClick as () => void)(); assert.equal(target, reference);
  model.action(tab.key, {type: 'primary-select', target: {artifactId: document.artifactRef.artifactId, revisionId: document.artifactRef.revisionId,
    occurrencePath: [], definitionId: document.display.definitionId, elementKind: 'wire', elementId: net.wireIds[0]!}, ctrlKey: false});
  tab = model.snapshot().tabs[0]!; if (tab.status !== 'ready') throw Error('not ready');
  const selected = reviewedSelectionTargets(document, tab.viewState, 'net');
  assert.equal(relatedSchematicQueries(document, selected, links(value(netReference))).length, 1);
  model.dispose();
});

test('reverse panel supplies both answer and exact tool destinations, grouped without implying parameter-only navigation', () => {
  const indexed = links(), calls: unknown[] = [];
  const panel = SchematicRelatedQueries({links: [...indexed, ...indexed], onNavigate: (link, destination) => calls.push([link.turnId, link.callId, destination])});
  const actions = buttons(panel); assert.equal(actions.length, 2);
  for (const action of actions) (action.props.onClick as () => void)();
  assert.deepEqual(calls, [[turnId, 'call-test', 'answer'], [turnId, 'call-test', 'query']]);
  const html = renderToStaticMarkup(createElement(SchematicRelatedQueries, {links: indexed, onNavigate() {}}));
  assert.ok(html.includes('相关查询与回答')); assert.ok(html.includes(turn.user)); assert.ok(html.includes('2026-10-28'));
});

test('unmapped and partial queries stay visible; question action only composes a scoped draft', () => {
  const raw = value(); const html = renderToStaticMarkup(createElement(OaReadResults, {value: {...raw, displayReferences: [], coverage: {...raw.coverage, complete: false, nextCursor: 'next-page', limitReason: 'page'}}}));
  assert.ok(html.includes('本次结果尚无已核对的图形映射')); assert.ok(html.includes('查询尚未完整返回')); assert.ok(html.includes(instance.name));
  assert.doesNotMatch(html, /在图中定位|已绑定当前聊天/u);
  assert.equal(appendSchematicQuestion(''), FOLDED_QUERY_PROMPT);
  assert.equal(appendSchematicQuestion('已有问题'), '已有问题\n\n' + FOLDED_QUERY_PROMPT);
  assert.equal(appendSchematicQuestion(FOLDED_QUERY_PROMPT), FOLDED_QUERY_PROMPT);
});
