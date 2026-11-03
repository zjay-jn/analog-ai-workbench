import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChatRunOrigin,
  parseChatTurnExecution,
  parseChatTurnInteraction,
  parseChatInteractionDecision,
} from '../apps/desktop/src/shared/agent/chat-turns';
import {parseSessionDisk,parseSessionRequest,SESSION_VERSION} from '../apps/desktop/src/shared/agent/chat-sessions';
import type {SessionDisk,SessionMethod,SessionRequests,SessionState} from '../apps/desktop/src/shared/agent/chat-sessions';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';
import type {UnifiedChatService} from '../apps/desktop/src/main/cloud/unified-chat-service';
import {createUnifiedChatCoordinator} from '../apps/desktop/src/main/cloud/unified-chat-coordinator';
import {createAgentRuntimeArbiter} from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type {ProjectReadHost} from '../apps/desktop/src/main/agent-project-read/host';
import {parseProjectReadDisk} from '../apps/desktop/src/main/agent-project-read/store';
import {PROJECT_READ_LIMITS as L,type ProjectReadEvent,type ProjectReadRun} from '../apps/desktop/src/shared/agent/agent-project-read';

// Independent boundary checks. No application startup, file fixture, native process,
// network transport, WSL, EDA, real user history or real provider is involved.
const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const digest = 'a'.repeat(64);
const execution = () => ({
  executionId: 'chat-execution-1', version: 1, requestDigest: digest,
  acceptedContext: {
    projectId, workspaceRevision: 1, bindingId: null, bindingIdentity: null,
    provider: 'kimi', model: 'kimi-k3', historyVersion: digest,
  },
  phase: 'accepted', cleanupState: 'idle', runLink: null,
  parentTurnId: null, pendingInteraction: null,
});

test('unified boundary: origin cannot carry renderer source paths, credentials or accessors', () => {
  const origin = {chatSessionId: sessionId, turnId, executionId: 'chat-execution-1', inputDigest: digest};
  for (const extra of [{root: 'C:\\other'}, {apiKey: 'synthetic-secret'}, {nativeSessionId: 'foreign'}]) {
    assert.throws(() => parseChatRunOrigin({...origin, ...extra}));
  }
  let getterCalls = 0;
  const accessor = {...origin};
  Object.defineProperty(accessor, 'inputDigest', {enumerable: true, get() {getterCalls++; return digest;}});
  assert.throws(() => parseChatRunOrigin(accessor));
  assert.equal(getterCalls, 0, 'untrusted data accessors must never execute');
  assert.throws(() => parseChatRunOrigin({...origin, chatSessionId: 'engine-native-session'}));
  assert.throws(() => parseChatRunOrigin({...origin, turnId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}));
});

test('unified boundary: accepted model and binding fields cannot form a wider snapshot', () => {
  const row = execution();
  for (const mutation of [
    {bindingId: 'binding-1'}, {bindingIdentity: digest},
    {provider: 'deepseek', model: 'kimi-k3'},
    {provider: 'kimi', model: 'deepseek-v4-flash'},
    {root: 'C:\\unrelated'}, {workspaceRevision: -1},
  ]) assert.throws(() => parseChatTurnExecution({...row, acceptedContext: {...row.acceptedContext, ...mutation}}));
  assert.throws(() => parseChatTurnExecution({...row, runLink: {runId: 'run-1', workspaceId: null, root: 'C:\\other'}}));
});

test('unified boundary: configuration action is fixed to its stated missing capability', () => {
  const interaction = {kind: 'configuration', interactionId: 'configuration-1', required: 'project_directory', action: 'select_project', message: '选择项目'};
  assert.throws(() => parseChatTurnInteraction({...interaction, action: 'review_environment'}));
  assert.throws(() => parseChatTurnInteraction({...interaction, root: 'C:\\unrelated'}));
  assert.throws(() => parseChatInteractionDecision({kind: 'configuration', decision: 'retry', projectId}));
  assert.throws(() => parseChatInteractionDecision({kind: 'configuration', decision: 'retry', model: 'kimi-k3'}));
});

test('unified boundary: recovery confirmation cannot grant persistent or arbitrary permissions', () => {
  const interaction = {
    kind: 'permission', interactionId: 'permission-1', permissionRequestId: 'request-1',
    operation: 'continue_verified_work', sourceRunId: 'project-run-1', recoveryVersion: digest,
    message: '继续已核定成果',
  };
  for (const operation of ['shell', 'read_any_path', 'network', 'continue_unverified_work']) {
    assert.throws(() => parseChatTurnInteraction({...interaction, operation}));
  }
  assert.throws(() => parseChatTurnInteraction({...interaction, root: 'C:\\other'}));
  for (const decision of ['always', 'allow_all', 'yes']) {
    assert.throws(() => parseChatInteractionDecision({kind: 'permission', permissionRequestId: 'request-1', decision}));
  }
  assert.throws(() => parseChatInteractionDecision({kind: 'permission', permissionRequestId: 'request-1', decision: 'allow_once', scope: '*'}));
});

test('unified boundary: question answer cannot masquerade as permission or select another run', () => {
  const question = {kind: 'question', questionId: 'question-1', answer: 'yes'};
  assert.deepEqual(parseChatInteractionDecision(question), question);
  assert.throws(() => parseChatInteractionDecision({...question, permissionRequestId: 'permission-1'}));
  assert.throws(() => parseChatInteractionDecision({...question, runId: 'foreign-run'}));
  assert.throws(() => parseChatInteractionDecision({...question, answer: '界'.repeat(1366)}));
  assert.throws(() => parseChatInteractionDecision({...question, answer: '\ud800'}));
});

const storedSession = (id = sessionId, requestId = turnId, executionId = 'chat-execution-1', runId = 'project-run-1') => ({
  id, title: 'synthetic only', provider: 'kimi', model: 'kimi-k3',
  createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
  turns: [{id: requestId, user: 'synthetic only', assistant: '', status: 'running', error: '', provider: 'kimi', model: 'kimi-k3',
    execution: {...execution(), executionId, acceptedContext: {...execution().acceptedContext, bindingId: 'binding-1', bindingIdentity: digest}, runLink: {runId, workspaceId: null}},
  }],
});

test('unified persisted identity: two conversations cannot claim the same turn, execution or run', () => {
  const first = storedSession();
  const otherSessionId = '44444444-4444-4444-8444-444444444444';
  const otherTurnId = '55555555-5555-4555-8555-555555555555';
  const disk = (second: ReturnType<typeof storedSession>) => ({version: 6, selectedId: sessionId, sessions: [first, second]});
  for (const second of [
    storedSession(otherSessionId, turnId, 'other-execution', 'other-run'),
    storedSession(otherSessionId, otherTurnId, 'chat-execution-1', 'other-run'),
    storedSession(otherSessionId, otherTurnId, 'other-execution', 'project-run-1'),
  ]) assert.throws(() => parseSessionDisk(disk(second)));
  assert.equal(parseSessionDisk(disk(storedSession(otherSessionId, otherTurnId, 'other-execution', 'other-run'))).sessions.length, 2);
});

test('unified persisted identity: model or phase disagreement and forward parent references fail closed', () => {
  const disk = () => ({version: 6, selectedId: sessionId, sessions: [storedSession()]});
  const wrongModel = disk();
  wrongModel.sessions[0]!.turns[0]!.provider = 'deepseek';
  wrongModel.sessions[0]!.turns[0]!.model = 'deepseek-v4-flash';
  assert.throws(() => parseSessionDisk(wrongModel));
  const wrongState = disk();
  wrongState.sessions[0]!.turns[0]!.execution.phase = 'completed';
  assert.throws(() => parseSessionDisk(wrongState));
  const parent = disk();
  const wrongParent = {...parent.sessions[0]!.turns[0]!.execution, parentTurnId: '55555555-5555-4555-8555-555555555555'};
  assert.throws(() => parseSessionDisk({...parent, sessions: [{...parent.sessions[0], turns: [{...parent.sessions[0]!.turns[0], execution: wrongParent}]}]}));
});

test('unified public routing: stop requires exact turn and caller cannot inject run, snapshot or source', () => {
  const stop = {contractVersion: SESSION_VERSION, sessionId, turnId};
  assert.throws(() => parseSessionRequest('cancelReply', {contractVersion: SESSION_VERSION, sessionId}));
  assert.throws(() => parseSessionRequest('cancelReply', {...stop, runId: 'foreign-run'}));
  const send = {contractVersion: SESSION_VERSION, sessionId, requestId: turnId, text: 'synthetic only'};
  for (const extra of [{execution: execution()}, {projectId}, {bindingId: 'other-binding'}, {origin: {}}, {model: 'kimi-k3'}]) {
    assert.throws(() => parseSessionRequest('sendMessage', {...send, ...extra}));
  }
  assert.throws(() => parseSessionRequest('sendMessage', {...send, continueFrom: turnId, followUp: {fromTurnId: turnId, expectedTurnVersion: 1}}));
  const answer = {contractVersion: SESSION_VERSION, sessionId, turnId, interactionId: 'question-1', requestId: '66666666-6666-4666-8666-666666666666', decision: {kind: 'question', questionId: 'question-1', answer: 'synthetic only'}};
  assert.throws(() => parseSessionRequest('answerInteraction', {...answer, runId: 'foreign-run'}));
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const caller = {senderId: 1, isTopFrame: true, appOrigin: 'null', navigationEpoch: 1, appSessionId: 'synthetic', windowId: 'synthetic', webContentsId: 1, workspaceId: 'synthetic', rootId: 'synthetic'};
const oldTurnId = '77777777-7777-4777-8777-777777777777';
async function activeHost() {
  let disk: SessionDisk = parseSessionDisk({version: 6, selectedId: sessionId, sessions: [{
    id: sessionId, title: 'synthetic only', provider: 'kimi', model: 'kimi-k3',
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
    turns: [{id: oldTurnId, user: 'old synthetic question', assistant: 'old synthetic answer', status: 'completed', error: '', provider: 'kimi', model: 'kimi-k3'}],
  }]});
  let current: Parameters<UnifiedChatService['execute']>[0] | undefined, release = () => {};
  const answers: {executionId: string; questionId: string; answer: string}[] = [];
  const service: UnifiedChatService = {
    capture: input => ({...execution().acceptedContext, provider: input.provider, model: input.model, historyVersion: input.historyVersion}),
    execute: async input => {current = input; await new Promise<void>(resolve => {release = resolve;});},
    answer: async (executionId, interaction, answer) => {answers.push({executionId, questionId: interaction.kind === 'question' ? interaction.questionId : 'wrong-kind', answer});},
    activity: () => {throw Error('Activity is not used in this synthetic negative test');},
    reconcile: (_sessionId, turn) => turn.execution!, forget: () => {}, busy: () => false,
  };
  const host = createSessionHost({owner: caller, configured: {deepseek: true, kimi: true},
    store: {load: () => structuredClone(disk), save: value => {disk = parseSessionDisk(value);}},
    execute: async () => {throw Error('Legacy provider must not execute');}, turns: service,
  });
  const invoke = <M extends SessionMethod>(method: M, args: Omit<SessionRequests[M], 'contractVersion'>) => host.invoke(caller, method, {contractVersion: SESSION_VERSION, ...args});
  const started = invoke('sendMessage', {sessionId, requestId: turnId, text: 'synthetic current question'});
  assert.equal(started.ok, true); await tick(); assert.ok(current);
  return {host, invoke, current: current!, answers, state: (): SessionState => {
    const result = invoke('readState', {}); assert.ok(result.ok); return result.value;
  }, close: async () => {host.revoke(); release(); await tick();}};
}

test('unified host negative: stopping an older turn or foreign caller cannot abort the active turn', async () => {
  const h = await activeHost();
  try {
    assert.deepEqual(h.invoke('cancelReply', {sessionId, turnId: oldTurnId}), {ok: false, error: {code: 'CONFLICT'}});
    assert.equal(h.current.signal.aborted, false);
    const foreign = h.host.invoke({...caller, navigationEpoch: 2}, 'cancelReply', {contractVersion: SESSION_VERSION, sessionId, turnId});
    assert.deepEqual(foreign, {ok: false, error: {code: 'CAPABILITY_DENIED'}});
    assert.equal(h.current.signal.aborted, false);
    assert.equal(h.state().activeTurn?.turnId, turnId);
  } finally {await h.close();}
});

test('unified host negative: wrong, conflicting or late question answers cannot dispatch another delivery', async () => {
  const h = await activeHost();
  try {
    const question = {kind: 'question' as const, interactionId: 'interaction-question-1', questionId: 'native-question-1', prompt: 'synthetic clarification', state: 'pending' as const};
    h.current.onExecution({phase: 'waiting_question', cleanupState: 'idle', runLink: null, pendingInteraction: question});
    const answer = {sessionId, turnId, interactionId: question.interactionId, requestId: '88888888-8888-4888-8888-888888888888', decision: {kind: 'question' as const, questionId: question.questionId, answer: 'synthetic answer'}};
    assert.deepEqual(h.invoke('answerInteraction', {...answer, decision: {...answer.decision, questionId: 'other-native-question'}}), {ok: false, error: {code: 'CONFLICT'}});
    assert.deepEqual(h.invoke('answerInteraction', {...answer, interactionId: 'old-interaction'}), {ok: false, error: {code: 'CONFLICT'}});
    assert.equal(h.answers.length, 0);
    assert.equal(h.invoke('answerInteraction', answer).ok, true);
    assert.equal(h.invoke('answerInteraction', answer).ok, true);
    assert.equal(h.answers.length, 1);
    assert.deepEqual(h.invoke('answerInteraction', {...answer, decision: {...answer.decision, answer: 'different answer'}}), {ok: false, error: {code: 'CONFLICT'}});
    h.current.onExecution({phase: 'running', cleanupState: 'idle', runLink: null, pendingInteraction: null});
    assert.deepEqual(h.invoke('answerInteraction', {...answer, requestId: '99999999-9999-4999-8999-999999999999'}), {ok: false, error: {code: 'CONFLICT'}});
    assert.equal(h.answers.length, 1);
  } finally {await h.close();}
});

test('unified host negative: stop during configuration cleanup still aborts its exact execution', async () => {
  const h = await activeHost();
  try {
    h.current.onExecution({phase: 'needs_configuration', cleanupState: 'pending', runLink: null,
      pendingInteraction: {kind: 'configuration', interactionId: 'configuration-1', required: 'project_directory', action: 'select_project', message: 'synthetic missing project'},
    });
    const stopped = h.invoke('cancelReply', {sessionId, turnId});
    assert.equal(stopped.ok, true, 'a pending configuration card cannot disable execution cancellation');
    assert.equal(h.current.signal.aborted, true);
  } finally {await h.close();}
});

function coldCoordinator(cache: string) {
  const time = '2026-09-16T00:00:00.000Z', runId = 'synthetic-cold-run';
  const project = {projectId, bindingId: 'binding-1', name: 'Synthetic', directoryName: 'Cold-Source', directorySegments: ['Q', 'Synthetic', 'Cold-Source'], identity: digest};
  const model = {provider: 'kimi', model: 'kimi-k3'} as const;
  const origin = {chatSessionId: sessionId, turnId, executionId: 'chat-execution-1', inputDigest: digest};
  const budget = {providerAttempts: L.requests, httpDispatches: L.requests, toolAttempts: L.toolCalls, physicalReadBytes: L.runReadBytes, visitedCandidates: L.runCandidates, contextBytes: L.contextBytes, outputBytes: L.outputBytes, maxOutputTokens: L.maxOutputTokens, deadlineMs: L.deadlineMs, waitMs: L.waitMs};
  const finalText = 'synthetic prefix and durable final tail';
  const events = [
    {type: 'run.accepted', data: {project, model, continuedFrom: null, budget, origin}},
    {type: 'run.started', data: {sessionId: 'native-synthetic-cold', engine: 'opencode', version: '1.18.17'}},
    {type: 'model.step', data: {step: 1}},
    {type: 'message.delta', data: {messageId: 'synthetic-message', step: 1, text: finalText}},
    {type: 'cleanup.started', data: {reason: 'completed'}},
    {type: 'cleanup.completed', data: {outcome: 'confirmed'}},
    {type: 'run.completed', data: {citations: []}},
  ].map((event, index) => ({runId, sequence: index + 1, time, ...event})) as ProjectReadEvent[];
  const run: ProjectReadRun = {runId, clientRequestId: 'synthetic-cold-client', project, model, goal: 'synthetic ledger only', constraint: '', continuedFrom: null,
    status: 'completed', cleanupState: 'idle', createdAt: time, updatedAt: time, eventCount: events.length,
    accounting: {providerAttempts: 0, httpDispatches: 0, toolAttempts: 0, physicalReadBytes: 0, visitedCandidates: 0, contextBytes: null}, continuation: null, origin, events};
  // The synthetic Q: locator is parsed as data; no filesystem lookup is performed.
  assert.ok(parseProjectReadDisk({version: 1, runs: [{run, citations: [], root: {projectId, bindingId: 'binding-1', root: 'Q:\\Synthetic\\Cold-Source', chain: [{dev: '1', ino: '1'}, {dev: '1', ino: '2'}, {dev: '1', ino: '3'}]}}]}));
  const session = storedSession(sessionId, turnId, origin.executionId, runId);
  session.turns[0]!.assistant = cache;
  session.turns[0]!.status = 'completed';
  session.turns[0]!.execution.phase = 'completed';
  let disk = parseSessionDisk({version: 6, selectedId: sessionId, sessions: [session]}), saves = 0, sideEffects = 0;
  const forbidden = (): never => {sideEffects++; throw Error('Cold reconciliation must not acquire sources or execute');};
  const service = createUnifiedChatCoordinator({
    project: {chatRuns: () => [structuredClone(run)], chatRun: (id: string) => id === runId ? structuredClone(run) : null,
      captureChat: forbidden, createChatEngine: forbidden, attachChat: forbidden, finishChat: forbidden, answerChat: forbidden} as unknown as ProjectReadHost,
    arbiter: createAgentRuntimeArbiter(), workspace: forbidden, getSession: forbidden, plain: forbidden,
  });
  return {service, run, finalText, disk: () => disk, sideEffects: () => sideEffects, saves: () => saves,
    host: () => createSessionHost({owner: caller, configured: {deepseek: true, kimi: true},
      store: {load: () => structuredClone(disk), save: value => {disk = parseSessionDisk(value); saves++;}}, execute: forbidden, turns: service}),
  };
}

test('unified cold negative: restoring only a final answer cache is persisted without execution', () => {
  const c = coldCoordinator('synthetic prefix'), host = c.host();
  try {
    const result = host.invoke(caller, 'readState', {contractVersion: SESSION_VERSION});
    assert.ok(result.ok);
    assert.equal(result.value.selected?.turns[0]?.assistant, c.finalText);
    assert.equal(c.disk().sessions[0]?.turns[0]?.assistant, c.finalText, 'restored text alone must trigger a durable save');
    assert.equal(c.saves(), 1);
    assert.equal(c.sideEffects(), 0);
  } finally {host.revoke();}
});

test('unified cold negative: divergent answer cache and wrong origins cannot become verified completion', () => {
  const c = coldCoordinator('unrelated cached answer'), host = c.host();
  try {
    const result = host.invoke(caller, 'readState', {contractVersion: SESSION_VERSION});
    assert.ok(result.ok);
    assert.ok(result.value.storage === 'error' || result.value.selected?.turns[0]?.execution?.phase === 'needs_review', 'conflicting cached text must fail closed');
    assert.equal(c.sideEffects(), 0);
  } finally {host.revoke();}
  for (const patch of [{chatSessionId: oldTurnId}, {turnId: oldTurnId}, {executionId: 'foreign-execution'}, {inputDigest: 'b'.repeat(64)}]) {
    const other = coldCoordinator('synthetic prefix');
    Object.assign(other.run, {origin: {...other.run.origin!, ...patch}});
    assert.throws(() => other.service.reconcile(sessionId, structuredClone(other.disk().sessions[0]!.turns[0]!)));
    assert.equal(other.sideEffects(), 0);
  }
});

test('unified permission negative: allowing a reviewed source cannot silently adopt another project', async () => {
  const session = storedSession();
  const interaction = {kind: 'permission' as const, interactionId: 'review-interaction', permissionRequestId: 'review-request', operation: 'continue_verified_work' as const, sourceRunId: 'reviewed-source-run', recoveryVersion: digest, message: 'synthetic reviewed source'};
  const turn = {...session.turns[0]!, status: 'failed', execution: {...session.turns[0]!.execution, phase: 'needs_review', runLink: null, pendingInteraction: interaction}};
  let disk = parseSessionDisk({version: 6, selectedId: sessionId, sessions: [{...session, turns: [turn]}]}), executions = 0;
  const service: UnifiedChatService = {
    capture: input => ({...execution().acceptedContext, projectId: '44444444-4444-4444-8444-444444444444', bindingId: 'new-project-binding', bindingIdentity: 'b'.repeat(64), provider: input.provider, model: input.model, historyVersion: input.historyVersion}),
    execute: async () => {executions++; throw Error('Scope conflict must not execute');},
    answer: async () => {throw Error('Permission must not become a question answer');},
    activity: () => {throw Error('Not used');}, reconcile: (_id, row) => row.execution!, forget: () => {}, busy: () => false,
  };
  const host = createSessionHost({owner: caller, configured: {deepseek: true, kimi: true},
    store: {load: () => structuredClone(disk), save: value => {disk = parseSessionDisk(value);}},
    execute: async () => {throw Error('Legacy executor must not run');}, turns: service,
  });
  try {
    const result = host.invoke(caller, 'answerInteraction', {contractVersion: SESSION_VERSION, sessionId, turnId, interactionId: interaction.interactionId,
      requestId: '88888888-8888-4888-8888-888888888888', decision: {kind: 'permission', permissionRequestId: interaction.permissionRequestId, decision: 'allow_once'}});
    assert.deepEqual(result, {ok: false, error: {code: 'CONFLICT'}}, 'a recovery permission only approves its reviewed source scope');
    assert.equal(disk.sessions[0]!.turns.length, 1);
    assert.deepEqual(disk.sessions[0]!.turns[0]!.execution!.pendingInteraction, interaction);
    assert.equal(executions, 0);
  } finally {host.revoke(); await tick();}
});
