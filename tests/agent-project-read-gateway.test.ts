import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectReadProviderServices, type ProjectReadProviderOptions, type ProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { PROJECT_READ_MODEL, projectReadTools, parseProjectReadSse, type ProjectReadCompletion } from '../apps/desktop/src/main/agent-project-read/protocol';
import { liveQuestionResult } from '../apps/desktop/src/main/engine-live/protocol';
import type { ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';

const args = { directoryId: null, cursor: null, refresh: false }, initialUserText = 'Task: synthetic fixture\nConfirmed continuation facts: verified excerpt 17', systemText = 'Hard product permissions. Root rule: only this project.';
const frame = (delta: unknown, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ id: 'completion_fixture', model: 'reported-deepseek-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
const wire = (id: string, name: string, argumentsValue: unknown) => frame({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(argumentsValue) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
const finalWire = () => frame({ role: 'assistant', content: 'Finished using verified tools.' }) + frame({}, 'stop') + 'data: [DONE]\n\n';
const nativeMessages = (): unknown[] => [{ role: 'system', content: 'private native filesystem data must not be forwarded' }, { role: 'user', content: initialUserText }];
const body = (messages = nativeMessages()) => ({ model: PROJECT_READ_MODEL.model, stream: true, tools: projectReadTools(), messages });
const post = (service: ProjectReadProviderServices, value: unknown, tool = false) => fetch(`http://127.0.0.1:${service.port}${tool ? '/tool' : '/v1/chat/completions'}`, { method: 'POST', headers: { Authorization: 'Bearer ' + (tool ? service.toolToken : service.providerToken), 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const assistant = (value: ProjectReadCompletion) => ({ role: 'assistant', content: value.text || null, ...(value.calls.length ? { tool_calls: value.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) });
const result: ProjectReadToolResult = { ok: true, value: { kind: 'list', phase: 'data', snapshotId: 'snapshot', entries: [], rules: [], resume: null, coverage: { scope: { projectId: 'project', bindingId: 'binding', identity: 'identity', directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 0, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null } } };
function options(fetchImpl: ProjectReadProviderOptions['fetchImpl'], maxRequests = 24): ProjectReadProviderOptions { return { fetchImpl, getRunCredentials: () => ({ apiKey: 'synthetic-main-key', model: PROJECT_READ_MODEL, maxRequests, maxOutputTokens: 2048, requestTimeoutMs: 5000 }), onResponse: () => {} }; }
const response = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });

test('project gateway rebuilds main system and exact continued user text, persists tool before replay, and keeps request 24 for final answer', async () => {
  const sent: Record<string, unknown>[] = []; let toolCount = 0, notices = 0;
  const service = await createProjectReadProviderServices({ ...options(async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-main-key');
    sent.push(JSON.parse(String(init.body))); return response(sent.length === 24 ? finalWire() : wire('call_' + sent.length, 'project_list', args));
  }), onResponse: () => { notices++; } });
  try {
    const run = service.begin({ runId: 'project-run-1', goal: 'synthetic fixture', constraint: '', initialUserText, systemText, onFailure: () => {}, onTool: async call => {
      assert.equal(call.sessionId, 'session'); assert.equal(call.toolName, 'project_list'); assert.equal(run.canDeliver({ call, result, citations: [], locators: [] }), true); toolCount++; return result;
    } }); run.bindSession('session'); const messages = nativeMessages();
    for (let n = 1; n <= 24; n++) {
      const http = await post(service, body(messages)); assert.equal(http.status, 200); const completion = parseProjectReadSse(await http.text());
      if (n === 24) { assert.equal(completion.calls.length, 0); break; }
      const c = completion.calls[0]!, input = { sessionID: 'session', messageID: 'message_' + n, callID: c.id, toolName: c.name, arguments: c.arguments };
      const tool = await post(service, input, true); assert.equal(tool.status, 200); const saved = await tool.json(); assert.deepEqual(saved, result);
      if (n === 1) { const replay = await post(service, input, true); assert.equal(replay.status, 200); assert.equal(toolCount, 1); }
      messages.push(assistant(completion), { role: 'tool', tool_call_id: c.id, content: JSON.stringify(saved) });
    }
    assert.equal(sent.length, 24); assert.equal(notices, 24); assert.equal(toolCount, 23); assert.equal(run.evidence().complete, true);
    assert.equal(sent.at(-1)?.tool_choice, 'none'); assert.ok(sent.slice(0, -1).every(row => row.tool_choice === 'auto'));
    for (const row of sent) { assert.deepEqual((row.messages as unknown[]).slice(0, 2), [{ role: 'system', content: systemText }, { role: 'user', content: initialUserText }]); assert.equal(JSON.stringify(row).includes('private native filesystem'), false); assert.equal(JSON.stringify(row).includes('synthetic-main-key'), false); }
    assert.equal((await post(service, body(messages))).status, 400); assert.equal(sent.length, 24);
  } finally { await service.close(); }
});

test('project gateway holds the next provider call until confirmed question delivery', async () => {
  let requests = 0, release!: () => void; const delivery = new Promise<void>(resolve => { release = resolve; });
  const q = { questions: [{ question: 'Which fixture?', header: 'Input', options: [], multiple: false, custom: true }] };
  const service = await createProjectReadProviderServices(options(async () => response(++requests === 1 ? wire('question_call', 'question', q) : finalWire()), 2));
  try {
    const run = service.begin({ runId: 'question-run', goal: 'fixture', constraint: '', initialUserText, systemText, onFailure: () => {}, onTool: async () => result }); run.bindSession('session');
    const first = await post(service, body()); assert.equal(first.status, 200); const completion = parseProjectReadSse(await first.text());
    run.question({ questionID: 'question', messageID: 'message', callID: 'question_call', prompt: 'Which fixture?', arguments: q }); run.answer('synthetic A', 'question'); run.answerDelivery('question', delivery);
    const pending = post(service, body([...nativeMessages(), assistant(completion), { role: 'tool', tool_call_id: 'question_call', content: liveQuestionResult('Which fixture?', 'synthetic A') }]));
    await new Promise<void>(resolve => setTimeout(resolve, 30)); assert.equal(requests, 1); release(); assert.equal((await pending).status, 200); assert.equal(requests, 2);
  } finally { release(); await service.close(); }
});

test('project gateway rejects a changed result or a truncated SSE before any further dispatch', async () => {
  for (const mode of ['changed-result', 'truncated']) {
    let requests = 0, tools = 0;
    const service = await createProjectReadProviderServices(options(async () => { requests++; return response(mode === 'truncated' ? wire('call', 'project_list', args).replace('data: [DONE]\n\n', '') : wire('call', 'project_list', args)); }));
    try {
      service.begin({ runId: 'reject-run', goal: 'fixture', constraint: '', initialUserText, systemText, onFailure: () => {}, onTool: async () => { tools++; return result; } }).bindSession('session');
      const first = await post(service, body());
      if (mode === 'truncated') { assert.equal(first.status, 400); assert.equal(tools, 0); }
      else {
        const completion = parseProjectReadSse(await first.text()); assert.equal((await post(service, { sessionID: 'session', messageID: 'message', callID: 'call', toolName: 'project_list', arguments: args }, true)).status, 200);
        assert.equal((await post(service, body([...nativeMessages(), assistant(completion), { role: 'tool', tool_call_id: 'call', content: JSON.stringify({ ok: false, error: { code: 'CANCELLED' }, coverage: null }) }]))).status, 400);
      }
      assert.equal(requests, 1);
    } finally { await service.close(); }
  }
});

test('project gateway serializes concurrent issued native file calls and keeps duplicate calls idempotent', async () => {
  let active = 0, peak = 0, calls = 0;
  const multiple = frame({ role: 'assistant', tool_calls: [0, 1].map(index => ({ index, id: 'call_' + index, type: 'function', function: { name: 'project_list', arguments: JSON.stringify(args) } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
  const service = await createProjectReadProviderServices(options(async () => response(multiple)));
  try {
    service.begin({ runId: 'parallel-native-fixture', goal: 'fixture', constraint: '', initialUserText, systemText, onFailure() {}, async onTool() {
      active++; peak = Math.max(peak, active); calls++; await new Promise<void>(resolve => setTimeout(resolve, 30)); active--; return result;
    } }).bindSession('session');
    assert.equal((await post(service, body())).status, 200);
    const inputs = [0, 1, 0].map(n => ({ sessionID: 'session', messageID: 'message', callID: 'call_' + n, toolName: 'project_list', arguments: args }));
    const replies = await Promise.all(inputs.map(value => post(service, value, true)));
    assert.ok(replies.every(value => value.status === 200)); assert.equal(calls, 2); assert.equal(peak, 1);
  } finally { await service.close(); }
});
