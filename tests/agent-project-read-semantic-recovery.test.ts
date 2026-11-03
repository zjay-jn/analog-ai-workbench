import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseProjectReadSse, projectReadTools, type ProjectReadCompletion } from '../apps/desktop/src/main/agent-project-read/protocol';
import { parseProjectReadEvent, parseProjectReadRequest, parseProjectReadToolArguments } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadToolCall, type ProjectReadToolName, type ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { createProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { createProjectReadStore, parseProjectReadDisk, type ProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIoBudget } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';
import { createProjectReadBroker } from '../apps/desktop/src/main/cloud/project-read-broker';

const recordedBase = 'C:/work/analog_ai_workbench/.local/quality-evidence/20260913-agent-project-read-live-03/raw/exercise-n02-n03-new-window';
const recorded = [7, 8, 9, 10].map(n => fs.readFileSync(path.join(recordedBase, 'response-' + n + '.sse'), 'utf8'));
const parent = 'C:/work/analog_ai_workbench/.local/agent-project-read-tests';
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const success = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!value.ok) return assert.fail(JSON.stringify(value)); return value.value; };
function fixture() {
  const base = path.join(parent, randomUUID()), directory = path.join(base, 'source'); fs.mkdirSync(path.join(directory, 'docs'), { recursive: true }); fs.writeFileSync(path.join(directory, 'docs', 'notes.txt'), 'Synthetic recovery text.');
  return { directory, root: captureFolderRoot(randomUUID(), randomUUID(), directory), remove() { const actual = fs.realpathSync.native(base); assert.equal(actual, base); assert.match(path.relative(parent, actual), /^[0-9a-f-]{36}$/u); fs.rmSync(actual, { recursive: true }); } };
}
const frame = (delta: unknown, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ id: 'offline-correction', model: 'offline-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
const toolWire = (name: string, args: unknown, id: string) => frame({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
const assistant = (response: ProjectReadCompletion) => ({ role: 'assistant', content: response.text || null, ...(response.calls.length ? { tool_calls: response.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) });

test('recorded response10 is a syntactically valid call; strict public browse and successful-event semantics remain denied', () => {
  const values = recorded.map(wire => parseProjectReadSse(wire)); assert.deepEqual(values.map(v => v.calls.length), [4, 4, 1, 1]);
  const call = values[3]!.calls[0]!; assert.equal(call.name, 'project_list'); assert.deepEqual(call.arguments, { directoryId: 'pri-r-d-7b44d108-caff-4f4f-845d-fb5977d9c05d', cursor: null, refresh: true });
  assert.equal(parseProjectReadRequest('browseProject', { contractVersion: V, projectId: 'project', bindingId: 'binding', ...call.arguments }), null);
  assert.throws(() => parseProjectReadSse(toolWire('shell', {}, 'unknown')));
  assert.throws(() => parseProjectReadSse(toolWire('project_list', { ...call.arguments, path: 'C:/outside' }, 'extra')));
  assert.throws(() => parseProjectReadSse(toolWire('project_list', { ...call.arguments, refresh: 'true' }, 'type')));
});

test('recorded response10 receives persisted INVALID_REQUEST through real host and gateway, then corrects to current root and child IDs', async () => {
  const f = fixture(), arbiter = createAgentRuntimeArbiter(); let disk: ProjectReadDisk = { version: 1, runs: [] }, active: ProjectReadEngineInput | undefined, providerCalls = 0, failures = 0;
  const diskStore = createProjectReadStore('C:/work/analog_ai_workbench', path.join(path.dirname(f.directory), 'agent-project-read'));
  const observedResults: ProjectReadToolResult[] = [], sent: unknown[] = [];
  const service = await createProjectReadProviderServices({ getRunCredentials: () => ({ apiKey: 'synthetic-offline-key', model, maxRequests: 24, maxOutputTokens: 16384, requestTimeoutMs: 600000 }),
    onResponse(runId, event) { if (active?.runId === runId) active.callbacks.notice({ type: 'response', ...event }); },
    async fetchImpl(_url, init) {
      providerCalls++; const body = JSON.parse(String(init.body)); sent.push(body); let wire: string;
      if (providerCalls === 1) wire = recorded[3]!;
      else if (providerCalls === 2) { assert.deepEqual(JSON.parse(body.messages.at(-1).content), { ok: false, error: { code: 'INVALID_REQUEST' }, coverage: null }); wire = toolWire('project_list', { directoryId: null, cursor: null, refresh: false }, 'correct-root'); }
      else if (providerCalls === 3) { const result = JSON.parse(body.messages.at(-1).content), directory = result.value.entries.find((e: { name: string }) => e.name === 'docs'); assert.ok(directory); wire = toolWire('project_list', { directoryId: directory.directoryId, cursor: null, refresh: false }, 'correct-child'); }
      else { assert.equal(providerCalls, 4); assert.equal(JSON.parse(body.messages.at(-1).content).value.entries[0].name, 'notes.txt'); wire = frame({ role: 'assistant', content: 'Offline correction completed with verified directory IDs.' }) + frame({}, 'stop') + 'data: [DONE]\n\n'; }
      return new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const models: ProjectReadModelSnapshots = { status: () => ({ model, canStart: true, reason: null }), freeze: () => model, get: () => ({ apiKey: 'synthetic-offline-key', model, maxRequests: 24, maxOutputTokens: 16384, requestTimeoutMs: 600000 }), forget() {}, close() {} };
  const post = (route: string, body: unknown, token: string) => fetch('http://127.0.0.1:' + service.port + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const engine: ProjectReadEngine = {
    status: () => ({ model, canStart: true, processState: 'ready', reason: null }), health: async () => true, accept: () => model,
    canDeliver: (id, publication) => service.canDeliver(id, publication), accounting: id => { const e = service.evidence(id); return { providerAttempts: e?.attempts ?? 0, httpDispatches: e?.httpRequests ?? 0, contextBytes: e?.contextBytes ?? 0 }; },
    async start(input) {
      active = input; service.begin({ runId: input.runId, goal: input.prompt.goal, constraint: input.prompt.constraint, systemText: input.prompt.systemText, initialUserText: input.prompt.initialUserText, onFailure() { failures++; input.callbacks.notice({ type: 'failed' }); }, onTool: call => input.callbacks.tool(call) }).bindSession('offline-session');
      input.callbacks.notice({ type: 'started', sessionId: 'offline-session' }); const messages: unknown[] = [{ role: 'user', content: input.prompt.initialUserText }];
      for (let n = 1; n <= 4; n++) {
        const result = await post('/v1/chat/completions', { model: model.model, stream: true, tools: projectReadTools(), messages }, service.providerToken); assert.equal(result.status, 200);
        const response = parseProjectReadSse(await result.text()); input.callbacks.notice({ type: 'step', step: n, usage: response.usage });
        if (response.text) input.callbacks.notice({ type: 'text', messageId: 'message-' + n, step: n, text: response.text }); messages.push(assistant(response));
        for (const call of response.calls) {
          const http = await post('/tool', { sessionID: 'offline-session', messageID: 'message-' + n, callID: call.id, toolName: call.name, arguments: call.arguments }, service.toolToken); assert.equal(http.status, 200);
          const output = await http.json() as ProjectReadToolResult; observedResults.push(output);
          const persisted = diskStore.load().runs[0]!.run.events.find(e => e.type === 'tool.completed' && e.data.callId === call.id); assert.ok(persisted, 'tool reply cannot precede its on-disk ledger event');
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
        }
        if (response.finish === 'stop') { input.callbacks.notice({ type: 'completed' }); return; }
      }
      assert.fail('correction failed to finish');
    },
    answer: async () => {}, stop: async id => { service.end(id); }, dispose() {}, shutdown: async () => {},
  };
  const host = createProjectReadHost({ arbiter, models, bindings: { snapshotBinding: () => ({ ok: true, value: { folder: f.root, name: 'Offline recovery' } }) }, createEngine: () => engine, store: { load: () => diskStore.load(), save(next) { const parsed = parseProjectReadDisk(next); assert.ok(parsed, 'strict disk validation'); diskStore.save(parsed); disk = parsed; }, close: () => diskStore.close() } });
  try {
    success(await host.invoke('startRun', { contractVersion: V, projectId: f.root.projectId, bindingId: f.root.bindingId, clientRequestId: randomUUID(), model, goal: 'Recover the synthetic directory listing.', constraint: '', continuedFrom: null }, () => true));
    for (let i = 0; i < 1000; i++) { const run = disk.runs[0]?.run; if (run && ['failed', 'completed'].includes(run.status) && run.cleanupState === 'idle') break; await tick(); }
    const run = disk.runs[0]!.run; assert.equal(run.status, 'completed'); assert.equal(failures, 0); assert.equal(providerCalls, 4); assert.equal(sent.length, 4); assert.equal(run.accounting.toolAttempts, 3); assert.equal(run.accounting.physicalReadBytes, 0);
    assert.deepEqual(observedResults[0], { ok: false, error: { code: 'INVALID_REQUEST' }, coverage: null });
    const bad = run.events.find(e => e.type === 'tool.completed')!; assert.equal(bad.type, 'tool.completed'); if (bad.type === 'tool.completed') { assert.equal((bad.data.arguments as { refresh: boolean }).refresh, true); const goodResult = observedResults[1]!; assert.equal(goodResult.ok, true); assert.equal(parseProjectReadEvent({ ...bad, data: { ...bad.data, result: goodResult } }), null, 'illegal refresh cannot be persisted as successful'); }
  } finally { host.revoke(); await host.shutdown().catch(() => {}); await service.close(); await arbiter.close().catch(() => {}); diskStore.close(); f.remove(); }
});

test('all three refresh semantic errors publish before index access, preserve valid state, and keep snapshot and identity bounds', async () => {
  const f = fixture(), abort = new AbortController(), budget = createProjectReadIoBudget(), identity = createHash('sha256').update(JSON.stringify(f.root.chain)).digest('hex');
  const index = createProjectReadIndex({ root: f.root, identity, owner: { kind: 'run', id: 'offline-broker' }, signal: abort.signal }); let operations = 0;
  const guarded = { ...index, list: (...args: Parameters<typeof index.list>) => { operations++; return index.list(...args); }, find: (...args: Parameters<typeof index.find>) => { operations++; return index.find(...args); }, candidates: (...args: Parameters<typeof index.candidates>) => { operations++; return index.candidates(...args); } };
  const publications: ProjectReadToolResult[] = [];
  const broker = createProjectReadBroker({ root: f.root, project: { projectId: f.root.projectId, bindingId: f.root.bindingId, name: 'Offline', directoryName: 'source', directorySegments: ['source'], identity }, runId: 'offline-broker', signal: abort.signal, budget, index: guarded, authorize: call => call.sessionId === 'owned', publishRule: async () => {}, installRootRule: async () => {}, canDeliver: () => true, publish: async value => { publications.push(value.result); } });
  const call = (name: ProjectReadToolName, args: unknown): ProjectReadToolCall => ({ toolName: name, arguments: args, callId: randomUUID(), sessionId: 'owned', messageId: 'message' } as ProjectReadToolCall);
  try {
    await broker.prepare(); const io = budget.evidence().physicalReadBytes;
    for (const name of ['project_list', 'project_find', 'project_search'] as const) for (const field of ['directoryId', 'cursor']) {
      const args = { directoryId: null, cursor: null, refresh: true, ...(name === 'project_list' ? {} : { query: 'notes' }), [field]: 'unissued-id' }; assert.ok(parseProjectReadToolArguments(name, args));
      assert.deepEqual(await broker.execute(call(name, args)), { ok: false, error: { code: 'INVALID_REQUEST' }, coverage: null });
    }
    assert.equal(publications.length, 6); assert.equal(operations, 0); assert.equal(broker.accounting().toolAttempts, 6); assert.equal(budget.evidence().physicalReadBytes, io);
    const initial = success(await broker.execute(call('project_list', { directoryId: null, cursor: null, refresh: false }))); assert.equal(initial.kind, 'list'); if (initial.kind !== 'list') return assert.fail(); const oldId = initial.entries.find(e => e.name === 'docs')!.directoryId;
    success(await broker.execute(call('project_list', { directoryId: null, cursor: null, refresh: true })));
    assert.equal((await broker.execute(call('project_list', { directoryId: oldId, cursor: null, refresh: false }))).ok, false);
    assert.deepEqual(await broker.execute(call('project_list', { directoryId: null, cursor: null, refresh: true })), { ok: false, error: { code: 'SCOPE_LIMIT' }, coverage: null });
    success(await broker.execute(call('project_list', { directoryId: null, cursor: null, refresh: false })));
    const before = operations; await assert.rejects(broker.execute({ ...call('project_list', { directoryId: null, cursor: null, refresh: false }), sessionId: 'foreign' })); assert.equal(operations, before);
  } finally { abort.abort(); await broker.close(); f.remove(); }
});
