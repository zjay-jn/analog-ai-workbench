import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProjectReadProviderServices, type ProjectReadProviderServices, type ProjectReadProviderOptions } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { projectReadTools } from '../apps/desktop/src/main/agent-project-read/protocol';
import { projectReadRequestBody } from '../apps/desktop/src/main/agent-project-read/models';
import { createAgentRuntimeArbiter, type AgentRuntimeResource } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import type { ProjectReadToolCall, ProjectReadToolResult, ProjectReadActiveTask, ProjectReadModel } from '../apps/desktop/src/shared/agent/agent-project-read';

// Only the local gateway uses real HTTP. The official provider URL is intercepted
// by fetchImpl below and receives synthetic in-memory Response objects, never fetch.
const userText = 'Synthetic project task with confirmed continuation facts.';
const systemText = 'Main-owned root rules and fixed project authority.';
const key = 'synthetic-secret-for-independent-gateway-tests';
// Existing cases deliberately keep their original DeepSeek protocol and budgets.
const PROJECT_READ_MODEL = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const K3_MODEL = { provider: 'kimi', model: 'kimi-k3' } as const;
const listArgs = { directoryId: null, cursor: null, refresh: false };
const readArgs = { fileId: 'signed-file', version: null, cursor: null, start: { line: 1, column: 1 } };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const hasCode = (code: string) => (error: unknown) => error instanceof ProjectReadFsError && error.code === code;
type Issued = { id: string; name: string; arguments: unknown };
const frame = (delta: unknown, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ id: 'independent_completion', model: 'synthetic-model-reported', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
const toolWire = (calls: Issued[]) => frame({ role: 'assistant', tool_calls: calls.map((item, index) => ({ index, id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.arguments) } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
const finalWire = () => frame({ role: 'assistant', content: 'Synthetic final answer.' }) + frame({}, 'stop') + 'data: [DONE]\n\n';
const response = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
const nativeMessages = (system = 'Untrusted native system payload'): Record<string, unknown>[] => [{ role: 'system', content: system }, { role: 'user', content: userText }];
const requestBody = (messages = nativeMessages(), model: ProjectReadModel = PROJECT_READ_MODEL) => ({ model: model.model, messages, tools: projectReadTools(), stream: true });
const assistant = (calls: Issued[]) => ({ role: 'assistant', content: null, tool_calls: calls.map(item => ({ id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.arguments) } })) });
const semanticMessages = (messages: unknown[]) => messages.map(message => {
  const row = message as Record<string, unknown>;
  return !Array.isArray(row.tool_calls) ? row : { ...row, tool_calls: row.tool_calls.map(item => ({ ...item, function: { ...item.function, arguments: JSON.parse(item.function.arguments) as unknown } })) };
});
const toolInput = (item: Issued, messageID = 'message-' + item.id) => ({ sessionID: 'owned-session', messageID, callID: item.id, toolName: item.name, arguments: item.arguments });
const emptyList: ProjectReadToolResult = { ok: true, value: { kind: 'list', phase: 'data', snapshotId: 'owned-snapshot', entries: [], rules: [], resume: null, coverage: { scope: { projectId: 'project', bindingId: 'binding', identity: 'identity', directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 0, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null } } };
function ruleResult(text: string): ProjectReadToolResult {
  return { ok: true, value: { kind: 'read', phase: 'rules', snapshotId: 'owned-snapshot', citation: null, empty: false, next: { line: 1, column: 1 }, resume: null,
    rules: [{ ruleId: 'rule-id', source: 'AGENTS.md', relativeDirectory: '', version: digest(text), normalizedSha256: digest(text), offsetBytes: 0, endBytes: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), text, complete: true }],
    coverage: { scope: { projectId: 'project', bindingId: 'binding', identity: 'identity', directoryId: null, relativeDirectory: '' }, complete: false, scannedCandidates: 1, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 1, position: { line: 1, column: 1 } }, nextCursor: 'next-rule-cursor', limitReason: 'rules' } } };
}
type Transport = { service: ProjectReadProviderServices; sent: { url: string; body: Record<string, unknown> }[]; post(value: unknown, tool?: boolean): Promise<{ status: number; text: string }>; failures: { value: number }; begin(onTool: (call: ProjectReadToolCall) => Promise<ProjectReadToolResult>, system?: string): ReturnType<ProjectReadProviderServices['begin']> };
async function fixture(work: (transport: Transport) => Promise<void>, fake: (number: number, init: RequestInit) => Promise<Response>, maxRequests = 24, model: ProjectReadModel = PROJECT_READ_MODEL) {
  const sent: Transport['sent'] = [], failures = { value: 0 };
  const options: ProjectReadProviderOptions = { getRunCredentials: () => ({ apiKey: key, model, maxRequests, maxOutputTokens: 2048, requestTimeoutMs: 5000 }), onResponse: () => {}, fetchImpl: async (url, init) => {
    assert.equal(url, model.provider === 'kimi' ? 'https://api.moonshot.cn/v1/chat/completions' : 'https://api.deepseek.com/chat/completions'); assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer ' + key); assert.equal(init.redirect, 'error');
    assert.equal(String(init.body).includes(key), false); sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> }); return fake(sent.length, init);
  } };
  const service = await createProjectReadProviderServices(options);
  assert.ok(Number.isSafeInteger(service.port) && service.port > 0 && service.port < 65536);
  const transport: Transport = { service, sent, failures,
    async post(value, tool = false) { const local = `http://127.0.0.1:${service.port}${tool ? '/tool' : '/v1/chat/completions'}`; const result = await fetch(local, { method: 'POST', headers: { Authorization: 'Bearer ' + (tool ? service.toolToken : service.providerToken), 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); return { status: result.status, text: await result.text() }; },
    begin(onTool, system = systemText) { const run = service.begin({ runId: 'owned-run', goal: 'synthetic', constraint: '', initialUserText: userText, systemText: system, onTool, onFailure: () => { failures.value++; } }); run.bindSession('owned-session'); return run; },
  };
  try { await work(transport); } finally { const close = service.close(); assert.equal(service.close(), close); await close; }
}

test('independent K3 gateway: two tool rounds retain private reasoning and original provider arguments across all continuations', async () => {
  const calls: Issued[] = [{ id: 'k3-list', name: 'project_list', arguments: listArgs }, { id: 'k3-read', name: 'project_read', arguments: readArgs }];
  const raw = ['{ "directoryId" : null, "cursor":null, "refresh":false }', '{ "fileId":"signed-\\u0066ile", "version":null,"cursor":null,"start":{"line":1,"column":1} }'];
  const reasoning = ['Private K3 reasoning first.', 'Private K3 reasoning second.'];
  const providerAssistant = (index: number) => ({ role: 'assistant', content: null, reasoning_content: reasoning[index], tool_calls: [{ id: calls[index]!.id, type: 'function', function: { name: calls[index]!.name, arguments: raw[index] } }] });
  const wire = (index: number) => frame({ role: 'assistant', reasoning_content: reasoning[index]!.slice(0, 8) }) + frame({ reasoning_content: reasoning[index]!.slice(8), tool_calls: [{ index: 0, id: calls[index]!.id, type: 'function', function: { name: calls[index]!.name, arguments: raw[index] } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
  await fixture(async f => {
    let executions = 0;
    const run = f.begin(async call => { assert.equal(call.callId, calls[executions]!.id); assert.deepEqual(call.arguments, calls[executions]!.arguments); executions++; return call.toolName === 'project_list' ? emptyList : ruleResult('K3 approved rule'); });
    const messages = nativeMessages();
    for (let index = 0; index < 2; index++) {
      const output = await f.post(requestBody(messages, K3_MODEL)); assert.equal(output.status, 200);
      assert.equal(output.text.includes('Private K3'), false); assert.equal(output.text.includes('reasoning_content'), false);
      const delivered = await f.post(toolInput(calls[index]!), true); assert.equal(delivered.status, 200);
      messages.push(assistant([calls[index]!]), { role: 'tool', tool_call_id: calls[index]!.id, content: delivered.text });
    }
    assert.equal((await f.post(requestBody(messages, K3_MODEL))).status, 200);
    assert.equal(executions, 2); assert.equal(f.sent.length, 3); assert.equal(run.evidence().httpRequests, 3); assert.equal(run.evidence().complete, true);
    for (const sent of f.sent) { assert.equal(sent.body.model, K3_MODEL.model); assert.equal(sent.body.max_completion_tokens, 2048); assert.equal(sent.body.reasoning_effort, 'low'); assert.equal('max_tokens' in sent.body, false); assert.equal('thinking' in sent.body, false); }
    assert.deepEqual((f.sent[1]!.body.messages as unknown[])[2], providerAssistant(0));
    assert.deepEqual((f.sent[2]!.body.messages as unknown[])[2], providerAssistant(0));
    assert.deepEqual((f.sent[2]!.body.messages as unknown[])[4], providerAssistant(1));
    assert.equal(JSON.stringify(run.evidence()).includes('Private K3'), false);
  }, async number => response(number <= 2 ? wire(number - 1) : finalWire()), 3, K3_MODEL);
});

test('independent K3 gateway: native model, reasoning, arguments and result changes cannot replace frozen provider authority', async t => {
  for (const vector of ['model', 'reasoning', 'arguments', 'result'] as const) await t.test(vector, async () => {
    const issued: Issued = { id: 'k3-bound', name: 'project_list', arguments: listArgs }; let executions = 0;
    await fixture(async f => {
      const run = f.begin(async () => { executions++; return emptyList; });
      if (vector === 'model') { assert.equal((await f.post(requestBody())).status, 400); assert.equal(f.sent.length, 0); }
      else {
        assert.equal((await f.post(requestBody(nativeMessages(), K3_MODEL))).status, 200);
        const tool = await f.post(toolInput(issued), true); assert.equal(tool.status, 200);
        const message: Record<string, unknown> = assistant([issued]);
        if (vector === 'reasoning') message.reasoning_content = 'Native forged reasoning';
        if (vector === 'arguments') message.tool_calls = assistant([{ ...issued, arguments: { ...listArgs, refresh: true } }]).tool_calls;
        const result = vector === 'result' ? JSON.stringify({ ok: false, error: { code: 'BUDGET_EXCEEDED' }, coverage: null }) : tool.text;
        assert.equal((await f.post(requestBody([...nativeMessages(), message, { role: 'tool', tool_call_id: issued.id, content: result }], K3_MODEL))).status, 400);
        assert.equal(f.sent.length, 1);
      }
      assert.equal(executions, vector === 'model' ? 0 : 1); assert.equal(run.evidence().failed, true);
    }, async () => response(frame({ role: 'assistant', reasoning_content: 'Private original reasoning' }) + toolWire([issued])), 3, K3_MODEL);
  });
});

test('independent gateway queued calls: serialized callbacks preserve replay identity and cancellation prevents queued work', { timeout: 10000 }, async t => {
  for (const outcome of ['complete', 'cancel', 'first-failure'] as const) await t.test(outcome, async () => {
    const issued: Issued[] = ['first', 'second', 'third'].map(id => ({ id, name: 'project_list', arguments: listArgs }));
    const entered = gate(), released = gate(), order: string[] = []; let active = 0, peak = 0;
    await fixture(async f => {
      const run = f.begin(async call => {
        active++; peak = Math.max(peak, active); order.push('start-' + call.callId);
        try { if (call.callId === 'first') { entered.release(); await released.promise; if (outcome === 'first-failure') throw new Error('Synthetic first callback failure'); } await new Promise<void>(resolve => setImmediate(resolve)); return emptyList; }
        finally { order.push('end-' + call.callId); active--; }
      });
      assert.equal((await f.post(requestBody())).status, 200);
      const pending = [f.post(toolInput(issued[0]!), true)];
      try {
        await Promise.race([entered.promise, pending[0]!.then(() => assert.fail('first call completed without entering the callback'))]);
        pending.push(f.post(toolInput(issued[1]!), true), f.post(toolInput(issued[2]!), true), f.post(toolInput(issued[0]!), true));
        const deadline = performance.now() + 2000;
        while (run.evidence().toolAttempts < 4 && performance.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
        assert.equal(run.evidence().toolAttempts, 4); await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(order, ['start-first']); assert.equal(peak, 1); assert.equal(run.evidence().resolvedCalls, 0);
        if (outcome === 'cancel') f.service.end('owned-run'); released.release();
        const returned = await Promise.all(pending); assert.ok(returned.every(result => result.status === (outcome === 'complete' ? 200 : 400)));
        assert.equal(peak, 1); assert.equal(active, 0); assert.equal(run.evidence().resolvedCalls, outcome === 'complete' ? 3 : 0);
        if (outcome === 'complete') {
          assert.deepEqual(order, ['start-first','end-first','start-second','end-second','start-third','end-third']); assert.equal(returned[0]!.text, returned[3]!.text);
          const replay = await f.post(toolInput(issued[0]!), true); assert.equal(replay.status, 200); assert.equal(replay.text, returned[0]!.text); assert.equal(order.length, 6);
          const messages = [...nativeMessages(), assistant(issued), ...issued.map((item, i) => ({ role: 'tool', tool_call_id: item.id, content: returned[i]!.text }))];
          assert.equal((await f.post(requestBody(messages))).status, 200); assert.equal(run.evidence().complete, true); assert.equal(f.sent.length, 2);
        } else { assert.deepEqual(order, ['start-first','end-first']); assert.equal(f.sent.length, 1); assert.equal(outcome === 'cancel' ? run.evidence().ended : run.evidence().failed, true); }
      } finally { released.release(); await Promise.allSettled(pending); }
    }, async number => response(number === 1 ? toolWire(issued) : finalWire()), 2);
  });
});

test('independent gateway full request: nested escaping and terminal reserve determine actual publication admission', async () => {
  const issued: Issued = { id: 'rule-call', name: 'project_read', arguments: readArgs }, small = ruleResult('small rule'), large = ruleResult('"'.repeat(4096));
  // Keep the request 8 KiB below the wire ceiling as the allowed tool schema grows.
  // The 16 KiB terminal reserve must still reject large and admit small below.
  const emptySystemRequest = projectReadRequestBody(PROJECT_READ_MODEL, [{ role: 'system', content: '' }, { role: 'user', content: userText }, assistant([issued]), { role: 'tool', tool_call_id: issued.id, content: JSON.stringify(large) }], projectReadTools(), 2048);
  const systemBytes = 192 * 1024 - 8192 - Buffer.byteLength(JSON.stringify(emptySystemRequest)); assert.ok(systemBytes > 0);
  await fixture(async f => {
    const run = f.begin(async () => small, 'S'.repeat(systemBytes));
    assert.equal((await f.post(requestBody())).status, 200);
    const call: ProjectReadToolCall = { sessionId: 'owned-session', messageId: 'message-rule-call', callId: issued.id, toolName: 'project_read', arguments: readArgs };
    const expected = (result: ProjectReadToolResult) => ({ ...f.sent[0]!.body, messages: [...f.sent[0]!.body.messages as unknown[], assistant([issued]), { role: 'tool', tool_call_id: issued.id, content: JSON.stringify(result) }] });
    const largeWire = Buffer.byteLength(JSON.stringify(expected(large))), smallWire = Buffer.byteLength(JSON.stringify(expected(small)));
    assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 12288); assert.ok(largeWire <= 192 * 1024, 'raw request should fit without final reserve');
    assert.ok(largeWire + 16384 > 192 * 1024); assert.ok(smallWire + 16384 <= 192 * 1024);
    assert.equal(run.canDeliver({ call, result: large, citations: [], locators: [] }), false); assert.equal(run.canDeliver({ call, result: small, citations: [], locators: [] }), true);
    assert.equal(f.service.canDeliver('foreign-run', { call, result: small, citations: [], locators: [] }), false);
    const delivered = await f.post(toolInput(issued), true); assert.equal(delivered.status, 200);
    const persisted = JSON.parse(delivered.text) as ProjectReadToolResult; assert.deepEqual(persisted, small);
    const continuation = [...nativeMessages(), assistant([issued]), { role: 'tool', tool_call_id: issued.id, content: delivered.text }];
    assert.equal((await f.post(requestBody(continuation))).status, 200);
    assert.equal(Buffer.byteLength(JSON.stringify(f.sent[1]!.body)), smallWire);
    assert.deepEqual(semanticMessages(f.sent[1]!.body.messages as unknown[]), semanticMessages(expected(persisted).messages));
    assert.equal(f.sent[1]!.body.tool_choice, 'none'); assert.equal(run.evidence().complete, true);
  }, async count => response(count === 1 ? toolWire([issued]) : finalWire()), 2);
});

test('independent gateway message ceiling: 96 native messages are bounded before system replacement and 97 dispatch none', async t => {
  for (const count of [96, 97]) await t.test(String(count), async () => {
    await fixture(async f => {
      const run = f.begin(async () => emptyList), messages = Array.from({ length: count - 1 }, () => ({ role: 'system', content: 'untrusted discarded native rule' })); messages.push({ role: 'user', content: userText });
      const result = await f.post(requestBody(messages)); assert.equal(result.status, count === 96 ? 200 : 400); assert.equal(f.sent.length, count === 96 ? 1 : 0);
      if (count === 96) { assert.deepEqual(f.sent[0]!.body.messages, [{ role: 'system', content: systemText }, { role: 'user', content: userText }]); assert.equal(JSON.stringify(f.sent[0]).includes('untrusted discarded'), false); }
      else assert.equal(run.evidence().failed, true);
    }, async () => response(finalWire()));
  });
});

test('independent gateway bound file calls: wrong call, session, message or arguments never execute another capability', async t => {
  for (const vector of ['call', 'session', 'message-replay', 'arguments', 'tool'] as const) await t.test(vector, async () => {
    const issued: Issued = { id: 'signed-read', name: 'project_read', arguments: readArgs }; let executions = 0;
    await fixture(async f => {
      const run = f.begin(async request => { executions++; assert.equal(request.toolName, 'project_read'); assert.deepEqual(request.arguments, readArgs); return ruleResult('bounded rule'); });
      assert.equal((await f.post(requestBody())).status, 200); const input = toolInput(issued);
      if (vector === 'message-replay') { assert.equal((await f.post(input, true)).status, 200); assert.equal((await f.post(input, true)).status, 200); input.messageID = 'other-message'; }
      if (vector === 'call') input.callID = 'foreign-call'; if (vector === 'session') input.sessionID = 'foreign-session'; if (vector === 'arguments') input.arguments = { ...readArgs, fileId: 'foreign-file' }; if (vector === 'tool') input.toolName = 'project_list';
      assert.equal((await f.post(input, true)).status, 400); assert.equal(executions, vector === 'message-replay' ? 1 : 0); assert.equal(f.sent.length, 1); assert.equal(run.evidence().failed, true);
    }, async () => response(toolWire([issued])));
  });
});

test('independent gateway result authority: changed native rule output cannot enter the next provider request', async () => {
  const issued: Issued = { id: 'signed-rule', name: 'project_read', arguments: readArgs }, saved = ruleResult('approved local rule');
  await fixture(async f => {
    f.begin(async () => saved); assert.equal((await f.post(requestBody())).status, 200); assert.equal((await f.post(toolInput(issued), true)).status, 200);
    const altered = ruleResult('native replacement rule');
    assert.equal((await f.post(requestBody([...nativeMessages(), assistant([issued]), { role: 'tool', tool_call_id: issued.id, content: JSON.stringify(altered) }]))).status, 400);
    assert.equal(f.sent.length, 1); assert.equal(f.failures.value, 1);
  }, async () => response(toolWire([issued])));
});

test('independent gateway issued budgets: 64 total including 8 sums is accepted, then total or sum overflow never executes', async t => {
  for (const vector of ['total', 'sum'] as const) await t.test(vector, async () => {
    const calls: Issued[] = Array.from({ length: vector === 'total' ? 64 : 8 }, (_, n) => ({ id: 'bounded-' + n, name: n < 8 ? 'pilot_sum' : 'project_list', arguments: n < 8 ? { values: [1] } : listArgs }));
    const extra: Issued = { id: 'over-budget', name: vector === 'total' ? 'project_list' : 'pilot_sum', arguments: vector === 'total' ? listArgs : { values: [1] } }; let executed = 0;
    await fixture(async f => {
      const run = f.begin(async request => { executed++; return request.toolName === 'pilot_sum' ? { ok: true, value: { kind: 'sum', sum: 1, count: 1, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' } } : emptyList; }); assert.equal((await f.post(requestBody())).status, 200);
      const messages = [...nativeMessages(), assistant(calls)];
      for (const item of calls) { const tool = await f.post(toolInput(item), true); assert.equal(tool.status, 200); messages.push({ role: 'tool', tool_call_id: item.id, content: tool.text }); }
      assert.equal((await f.post(requestBody(messages))).status, 400); assert.equal(executed, calls.length); assert.equal(f.sent.length, 2);
      assert.equal(run.evidence().issued.length, calls.length); assert.equal(run.evidence().resolvedCalls, calls.length); assert.equal(run.evidence().httpRequests, 2);
      assert.equal(f.service.traffic().totalHttpRequests, 2); assert.equal(f.service.traffic().totalToolAttempts, calls.length); assert.equal(run.evidence().failed, true);
    }, async count => response(toolWire(count === 1 ? calls : [extra])));
  });
});

test('independent gateway budget error reserves a final answer before configured provider quota is exhausted', async () => {
  const issued: Issued = { id: 'budget-call', name: 'project_list', arguments: listArgs };
  const stopped: ProjectReadToolResult = { ok: false, error: { code: 'BUDGET_EXCEEDED' }, coverage: null };
  await fixture(async f => {
    const run = f.begin(async () => stopped); assert.equal((await f.post(requestBody())).status, 200); const tool = await f.post(toolInput(issued), true); assert.equal(tool.status, 200);
    assert.equal((await f.post(requestBody([...nativeMessages(), assistant([issued]), { role: 'tool', tool_call_id: issued.id, content: tool.text }]))).status, 200);
    assert.equal(f.sent[0]!.body.tool_choice, 'auto'); assert.equal(f.sent[1]!.body.tool_choice, 'none'); assert.equal(run.evidence().httpRequests, 2); assert.equal(run.evidence().complete, true);
  }, async count => response(count === 1 ? toolWire([issued]) : finalWire()), 24);
});

test('independent gateway late tool: stop while evidence callback is pending cannot resolve the issued call', async () => {
  const entered = gate(), released = gate(), issued: Issued = { id: 'pending-tool', name: 'project_list', arguments: listArgs };
  await fixture(async f => {
    const run = f.begin(async () => { entered.release(); await released.promise; return emptyList; }); assert.equal((await f.post(requestBody())).status, 200); const work = f.post(toolInput(issued), true);
    try { await Promise.race([entered.promise, work.then(() => assert.fail('tool returned before gate'))]); f.service.end('owned-run'); released.release(); assert.equal((await work).status, 400); assert.equal(run.evidence().resolvedCalls, 0); assert.equal(run.evidence().ended, true); assert.equal(f.sent.length, 1); }
    finally { released.release(); await work.catch(() => {}); }
  }, async () => response(toolWire([issued])));
});

test('independent gateway late response: stop aborts pending dispatch and cancels an ignored-abort body', async () => {
  const entered = gate(), released = gate(), cancelled = gate();
  await fixture(async f => {
    const run = f.begin(async () => emptyList), work = f.post(requestBody());
    try { await Promise.race([entered.promise, work.then(() => assert.fail('provider returned before gate'))]); f.service.end('owned-run'); assert.equal((await work).status, 400); released.release(); await cancelled.promise; assert.equal(run.evidence().responses, 0); assert.equal(run.evidence().complete, false); assert.equal(f.sent.length, 1); }
    finally { released.release(); await work.catch(() => {}); }
  }, async () => { entered.release(); await released.promise; return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(finalWire())); }, cancel() { cancelled.release(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); });
});

const task = (mode: ProjectReadActiveTask['mode'], runId: string): ProjectReadActiveTask => ({ mode, runId, project: null, status: 'running', cleanupState: 'idle' });
test('independent runtime factory: calculation-project-calculation creates distinct resources after ordered shutdown', async () => {
  const arbiter = createAgentRuntimeArbiter(), order: string[] = [], created: AgentRuntimeResource[] = [];
  const factory = (name: string) => () => { order.push('create-' + name); const runtime = { dispose() { order.push('dispose-' + name); }, async shutdown() { order.push('shutdown-' + name); } }; created.push(runtime); return runtime; };
  try {
    const a = arbiter.reserveRun(task('calculation', 'a'), () => {}), first = await arbiter.runtime(a, factory('sum-a')); arbiter.release(a);
    const b = arbiter.reserveRun(task('project_read', 'b'), () => {}), second = await arbiter.runtime(b, factory('project')); arbiter.release(b);
    const c = arbiter.reserveRun(task('calculation', 'c'), () => {}), third = await arbiter.runtime(c, factory('sum-c'));
    assert.notEqual(first, second); assert.notEqual(first, third); assert.equal(created.length, 3); assert.deepEqual(order, ['create-sum-a', 'dispose-sum-a', 'shutdown-sum-a', 'create-project', 'dispose-project', 'shutdown-project', 'create-sum-c']); arbiter.release(c);
  } finally { await arbiter.close(); }
  assert.deepEqual(order.slice(-2), ['dispose-sum-c', 'shutdown-sum-c']);
});

test('independent runtime transition: pending cleanup excludes inspection and close prevents creation of a replacement', async () => {
  const arbiter = createAgentRuntimeArbiter(), entered = gate(), released = gate(); let replacements = 0, revoked = 0;
  const first = arbiter.reserveRun(task('calculation', 'first'), () => {}); await arbiter.runtime(first, () => ({ dispose() {}, async shutdown() { entered.release(); await released.promise; } })); arbiter.release(first);
  const next = arbiter.reserveRun(task('project_read', 'next'), () => { revoked++; }); const work = arbiter.runtime(next, () => { replacements++; return { dispose() {}, async shutdown() {} }; });
  try {
    await entered.promise; assert.throws(() => arbiter.release(next), hasCode('BUSY')); assert.throws(() => arbiter.reserveInspection('project', () => {}), hasCode('BUSY'));
    const close = arbiter.close(); assert.equal(arbiter.close(), close); released.release(); await assert.rejects(work, hasCode('CANCELLED')); await close;
    assert.equal(replacements, 0); assert.equal(revoked, 1); assert.deepEqual(arbiter.snapshot(), { busy: false, closed: true, failed: false, activeTask: null });
  } finally { released.release(); await work.catch(() => {}); await arbiter.close(); }
});

test('independent runtime cleanup failure: no new factory or lease can reuse a failed resource', async () => {
  const arbiter = createAgentRuntimeArbiter(); let created = 0;
  const a = arbiter.reserveRun(task('calculation', 'a'), () => {}); await arbiter.runtime(a, () => ({ dispose() {}, async shutdown() { throw new Error('synthetic cleanup failure'); } })); arbiter.release(a);
  const b = arbiter.reserveRun(task('project_read', 'b'), () => {});
  await assert.rejects(arbiter.runtime(b, () => { created++; return { dispose() {}, async shutdown() {} }; }), hasCode('CLEANUP_FAILED'));
  assert.equal(created, 0); assert.throws(() => arbiter.reserveInspection('project', () => {}), hasCode('CLEANUP_FAILED')); await assert.rejects(arbiter.close(), hasCode('CLEANUP_FAILED'));
});
