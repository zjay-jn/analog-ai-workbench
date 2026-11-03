import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { createLiveProviderServices, type LiveNativeTool } from '../apps/desktop/src/main/engine-live/provider-gateway';
import { parseLiveSse, liveTools } from '../apps/desktop/src/main/engine-live/protocol';
import { executePilotSum } from '../apps/desktop/src/main/engine-pilot/tool';
import { createOpenCodePilotEngine } from '../apps/desktop/src/main/engine-pilot/opencode-engine';
import { createPilotHost } from '../apps/desktop/src/main/engine-pilot/host';
import { pilotPrompt } from '../apps/desktop/src/main/engine-pilot/prompt';
import type { PilotEngine } from '../apps/desktop/src/main/engine-pilot/engine';
import type { PilotDisk, PilotModel } from '../apps/desktop/src/shared/agent/engine-pilot';
import { createLiveRuntime, type LiveRuntimeOptions } from '../apps/desktop/src/main/engine-live/runtime';
import * as gatewayModule from '../apps/desktop/src/main/engine-live/provider-gateway';
import * as nativeEngineModule from '../apps/desktop/src/main/engine-pilot/opencode-engine';
import type { OpenCodeSupervisor } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import { createCloudDesktopOptions, startCloudDesktop, type CloudDesktopDependencies } from '../apps/desktop/src/main/engine-live/cloud-bootstrap';
import path from 'node:path';
import * as runtimeModule from '../apps/desktop/src/main/engine-live/runtime';
import * as settingsModule from '../apps/desktop/src/main/cloud/model-settings-host';
import * as storeModule from '../apps/desktop/src/main/engine-pilot/store';
import * as workspaceModule from '../apps/desktop/src/main/cloud/register-workspace';
import { createInitializationShutdown } from '../apps/desktop/src/main/engine-live/shutdown';
import {
  PILOT_VERSION, PILOT_RULES_REVISION, parsePilotRequest, parsePilotResult,
  parsePilotEvent, parsePilotDisk,
} from '../apps/desktop/src/shared/agent/engine-pilot';

// Independent synthetic fixtures: no runtime import, store, socket, process or provider.
const runId = 'pilot.00000000-0000-4000-8000-000000000101';
const clientRequestId = '00000000-0000-4000-8000-000000000102';
const time = '2026-09-11T00:00:00.000Z';
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' };
type RawEvent = { type: string; data: Record<string, unknown> };
function event(type: string, data: Record<string, unknown>, sequence = 1) {
  return { runId, sequence, time, type, data };
}
function disk(tail: RawEvent[], state = 'completed', live = true) {
  const identity = live ? { model: { ...model } } : {};
  const accepted = {
    goal: '计算三笔已确认调整的合计。', constraint: '仅使用本任务提供的数字。',
    engineKind: 'opencode', engineVersion: '1.18.17', rulesRevision: PILOT_RULES_REVISION,
    ...identity,
  };
  return { version: 1, runs: [{
    runId, clientRequestId, goal: accepted.goal, constraint: accepted.constraint,
    status: state, createdAt: time, updatedAt: time,
    engineKind: accepted.engineKind, engineVersion: accepted.engineVersion, ...identity,
    events: [
      event('run.accepted', accepted),
      event('engine.started', { sessionId: 'ses_security_live' }, 2),
      ...tail.map((entry, i) => event(entry.type, entry.data, i + 3)),
    ],
  }] };
}
const response = (request: number, responseModel: string | null = 'deepseek-flash') => ({
  type: 'model.response', data: { request, responseModel, usage: null },
});
const finalText = { type: 'message.delta', data: { text: '合计为 85。' } };
const completed = { type: 'run.completed', data: {} };

test('live independent contract security: requested model is exact, immutable and cannot carry hidden capabilities', () => {
  const input = { contractVersion: PILOT_VERSION, clientRequestId, goal: '请计算合计。', constraint: '', model: { ...model } };
  const parsed = parsePilotRequest('startRun', input);
  input.model.model = 'changed-after-parse';
  assert.deepEqual(parsed.model, model);
  assert.equal(Object.isFrozen(parsed.model), true);
  for (const override of [
    { provider: 'kimi', model: 'kimi-k3' }, { ...model, model: 'deepseek-flash' },
    { ...model, baseURL: 'https://untrusted.invalid/v1' }, { ...model, apiKey: 'synthetic-key' },
  ]) assert.throws(() => parsePilotRequest('startRun', { ...input, model: override }));
  for (const [key, value] of Object.entries({
    messages: [{ role: 'user', content: 'foreign-chat-sentinel' }],
    chatSessionId: 'foreign-chat', projectId: 'foreign-project',
    path: 'C:/synthetic-forbidden.txt', providerOptions: { thinking: { type: 'enabled' } },
    budget: 999999, Authorization: 'synthetic-key',
  })) assert.throws(() => parsePilotRequest('startRun', { ...input, model, [key]: value }), key);
  let getterReads = 0;
  const getterModel = { ...model };
  Object.defineProperty(getterModel, 'model', { enumerable: true, get() { getterReads++; return model.model; } });
  assert.throws(() => parsePilotRequest('startRun', { ...input, model: getterModel }));
  assert.equal(getterReads, 0);
  assert.throws(() => parsePilotRequest('startRun', { ...input, model: Object.assign(Object.create({ apiKey: 'synthetic-key' }), model) }));
});

test('live independent contract security: lazy idle status and incomplete or conflicting live status remain distinct', () => {
  const status = {
    engineKind: 'opencode', engineVersion: '1.18.17', ready: false,
    capabilities: ['pilot.sum.v1'], maxRuns: 32,
    model, canStart: true, processState: 'idle', availability: 'available',
  };
  const parsed = parsePilotResult('getStatus', { ok: true, value: status });
  assert.equal(parsed.ok, true);
  if (parsed.ok) { assert.equal(parsed.value.ready, false); assert.equal(parsed.value.canStart, true); }
  for (const patch of [
    { ready: true }, { engineKind: 'fake' }, { availability: 'not_configured' },
    { canStart: false }, { processState: 'unknown' }, { apiKey: 'synthetic-key' },
  ]) assert.throws(() => parsePilotResult('getStatus', { ok: true, value: { ...status, ...patch } }));
  for (const key of ['model', 'canStart', 'availability', 'processState']) {
    const partial: Record<string, unknown> = { ...status }; delete partial[key];
    assert.throws(() => parsePilotResult('getStatus', { ok: true, value: partial }), key);
  }
  const { model: _model, ...unconfigured } = status;
  assert.equal(parsePilotResult('getStatus', { ok: true, value: { ...unconfigured, canStart: false, availability: 'not_configured' } }).ok, true);
});

test('live independent contract security: response identity and unknown usage never become requested identity or zero usage', () => {
  for (const responseModel of [null, 'deepseek-flash']) {
    const parsed = parsePilotEvent(event('model.response', { request: 1, responseModel, usage: null }));
    assert.equal(parsed.type, 'model.response');
    if (parsed.type === 'model.response') { assert.equal(parsed.data.responseModel, responseModel); assert.equal(parsed.data.usage, null); }
  }
  const zero = parsePilotEvent(event('model.response', { request: 1, responseModel: null, usage: { inputTokens: 0, outputTokens: 0 } }));
  if (zero.type === 'model.response') assert.deepEqual(zero.data.usage, { inputTokens: 0, outputTokens: 0 });
  for (const usage of [
    {}, { inputTokens: 1 }, { inputTokens: 1, outputTokens: -1 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1 },
    { inputTokens: 1, outputTokens: 1, estimated: true },
  ]) assert.throws(() => parsePilotEvent(event('model.response', { request: 1, responseModel: null, usage })));
  for (const responseModel of ['', '型'.repeat(43), { model: model.model }]) {
    assert.throws(() => parsePilotEvent(event('model.response', { request: 1, responseModel, usage: null })));
  }
  assert.throws(() => parsePilotEvent(event('model.response', { request: 1, responseModel: null, usage: null, headers: { Authorization: 'synthetic-key' } })));
});

test('live independent history security: accepted and stored model identities must agree and legacy history stays legacy', () => {
  const source = disk([response(1), finalText, completed]);
  const parsed = parsePilotDisk(source);
  assert.deepEqual(parsed.runs[0]?.model, model);
  const actual = parsed.runs[0]?.events.find(entry => entry.type === 'model.response');
  assert.equal(actual?.type, 'model.response');
  if (actual?.type === 'model.response') { assert.equal(actual.data.responseModel, 'deepseek-flash'); assert.equal(actual.data.usage, null); }
  for (const location of ['record', 'accepted']) {
    const changed = structuredClone(source);
    const target = location === 'record' ? changed.runs[0]! : changed.runs[0]!.events[0]!.data;
    delete (target as Record<string, unknown>).model;
    assert.throws(() => parsePilotDisk(changed), location);
  }
  const withKey = structuredClone(source);
  (withKey.runs[0] as Record<string, unknown>).apiKey = 'synthetic-key';
  assert.throws(() => parsePilotDisk(withKey));
  const legacy = parsePilotDisk(disk([finalText, completed], 'completed', false));
  assert.equal(Object.hasOwn(legacy.runs[0]!, 'model'), false);
  assert.throws(() => parsePilotDisk(disk([response(1), finalText, completed], 'completed', false)));
});

test('live independent history security: actual dispatch identities are monotonic, bounded and cannot cross runs or terminal events', () => {
  // Only validated responses produce these events. Missing dispatches belong to the gateway ledger.
  parsePilotDisk(disk([response(2), response(8), finalText, completed]));
  for (const responses of [[response(0)], [response(1), response(1)], [response(2), response(1)], [response(9)]]) {
    assert.throws(() => parsePilotDisk(disk([...responses, finalText, completed])));
  }
  const foreign = disk([response(1), finalText, completed]);
  foreign.runs[0]!.events[2]!.runId = 'pilot.00000000-0000-4000-8000-000000000103';
  assert.throws(() => parsePilotDisk(foreign));
  assert.throws(() => parsePilotDisk(disk([response(1), finalText, completed, response(2)])));
  const sessionless = disk([response(1), finalText, completed]);
  sessionless.runs[0]!.events.splice(1, 1);
  sessionless.runs[0]!.events.forEach((entry, i) => { entry.sequence = i + 1; });
  assert.throws(() => parsePilotDisk(sessionless));
});

test('live independent limit security: live permits eight steps while legacy history retains its four-step limit', () => {
  const steps = (count: number) => Array.from({ length: count }, (_, i) => ({
    type: 'model.step', data: { step: i + 1, usage: null },
  }));
  parsePilotDisk(disk([...steps(8), response(8), finalText, completed]));
  assert.throws(() => parsePilotDisk(disk([...steps(9), finalText, completed])));
  parsePilotDisk(disk([...steps(4), finalText, completed], 'completed', false));
  assert.throws(() => parsePilotDisk(disk([...steps(5), finalText, completed], 'completed', false)));
});

test('live independent question history security: two sequential free-text answers keep their own question identity', () => {
  const asked = (questionId: string, prompt: string) => ({ type: 'question.asked', data: { questionId, prompt } });
  const answered = (questionId: string, answer: string) => ({ type: 'question.answered', data: { questionId, answer } });
  const q1 = asked('que_dynamic_first', '第二笔是增加还是减少，金额是多少？');
  const a1 = answered('que_dynamic_first', '第二笔减少 53。');
  const q2 = asked('que_dynamic_second', '第三笔金额尚未给出，请确认。');
  const a2 = answered('que_dynamic_second', '第三笔增加 18，不是 0。');
  const parsed = parsePilotDisk(disk([response(1), q1, a1, response(2), q2, a2, response(3), finalText, completed]));
  assert.deepEqual(parsed.runs[0]?.events.filter(entry => entry.type === 'question.answered').map(entry => entry.data), [a1.data, a2.data]);
  assert.throws(() => parsePilotDisk(disk([response(1), q1, a1, response(2), q2, a1, finalText, completed])));
  assert.throws(() => parsePilotDisk(disk([response(1), q1, a1, q1, finalText, completed])));
  assert.throws(() => parsePilotDisk(disk([response(1), q1, finalText, completed])));
  const exact = '界'.repeat(1365) + 'a';
  const input = { contractVersion: PILOT_VERSION, runId, questionId: 'que_dynamic_second', answer: exact };
  assert.equal(Buffer.byteLength(exact), 4096);
  assert.equal(parsePilotRequest('answerQuestion', input).answer, exact);
  assert.throws(() => parsePilotRequest('answerQuestion', { ...input, answer: exact + 'b' }));
});

class MemoryHttpResponse extends EventEmitter {
  status = 0; headers: unknown; headersSent = false; writableEnded = false; destroyed = false;
  body = '';
  writeHead(status: number, headers: unknown) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
  end(body = '') { this.body += body; this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
const apiKey = 'sk-independent_security_123456789';
const liveGoal = '请计算 9、-4、12 的合计。';
const liveConstraint = '只使用本任务输入。';
const initialMessages = () => [
  { role: 'system', content: 'native-system-not-authorized-to-replace-main-rules' },
  { role: 'user', content: `Task:\n${liveGoal}\n\nConstraints:\n${liveConstraint}` },
];
const providerBody = (messages: unknown[] = initialMessages()) => ({
  model: 'deepseek-v4-flash', stream: true, tools: liveTools(), messages,
});
const nativeCall = (id: string, args: unknown, name = 'pilot_sum') => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const frame = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: 'completion-security', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const callPrefix = (id: string, args: unknown, name = 'pilot_sum') => frame({
  role: 'assistant', tool_calls: [{ index: 0, ...nativeCall(id, args, name) }],
});
const toolTail = () => frame({}, 'tool_calls') + 'data: [DONE]\n\n';
const finalWire = () => frame({ role: 'assistant', content: '合计为 17。' }) + frame({}, 'stop') + 'data: [DONE]\n\n';
const wireResponse = (wire: string) => new Response(wire, { headers: { 'content-type': 'text/event-stream' } });

async function gatewayFixture(t: TestContext, config: {
  fetch?: (url: string, init: RequestInit, index: number) => Promise<Response>;
  maxRequests?: number;
  requestTimeoutMs?: number;
  begin?: boolean;
} = {}) {
  let handler!: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _address: string, done: () => void) { done(); return this; },
    address: () => ({ port: 43123, address: '127.0.0.1', family: 'IPv4' }),
    close(done: () => void) { done(); return this; },
  });
  // Exercise the real service handler while replacing only native socket allocation.
  t.mock.method(http, 'createServer', ((listener: unknown) => {
    handler = listener as typeof handler; return server as unknown as http.Server;
  }) as typeof http.createServer);
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const tools: LiveNativeTool[] = [];
  const notices: unknown[] = [];
  let failures = 0, credentialReads = 0;
  const services = await createLiveProviderServices({
    async fetchImpl(url, init) { fetches.push({ url, init }); return config.fetch ? config.fetch(url, init, fetches.length) : wireResponse(finalWire()); },
    getRunCredentials(id) { credentialReads++; assert.equal(id, runId); return { apiKey, maxRequests: config.maxRequests ?? 8, maxOutputTokens: 16384, requestTimeoutMs: config.requestTimeoutMs ?? 600000 }; },
    onResponse(id, value) { assert.equal(id, runId); notices.push(value); },
  });
  assert.equal(fetches.length, 0); assert.equal(credentialReads, 0);
  const begin = () => {
    const run = services.begin({ runId, goal: liveGoal, constraint: liveConstraint,
      async onTool(call) { tools.push(call); return executePilotSum(call.arguments); },
      onFailure() { failures++; },
    });
    run.bindSession('ses_security_gateway'); return run;
  };
  const run = config.begin === false ? undefined : begin();
  const send = (body: unknown, options: { tool?: boolean; path?: string; origin?: string; authorization?: string } = {}) => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      url: options.path ?? (options.tool ? '/tool' : '/v1/chat/completions'), method: 'POST',
      headers: { authorization: options.authorization ?? `Bearer ${options.tool ? services.toolToken : services.providerToken}`,
        'content-type': 'application/json', ...(options.origin === undefined ? {} : { origin: options.origin }) },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const response = new MemoryHttpResponse();
    const done = handler(request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse);
    return { response, done };
  };
  const callTool = (id = 'call_security', args: unknown = { values: [9, -4, 12] }, patch: Record<string, unknown> = {}) => send({
    sessionID: 'ses_security_gateway', messageID: 'msg_security_gateway', callID: id,
    toolName: 'pilot_sum', arguments: args, ...patch,
  }, { tool: true });
  t.after(() => services.close());
  return { services, run, begin, send, callTool, fetches, tools, notices, failures: () => failures, credentialReads: () => credentialReads };
}
async function waitForFetch(fixture: { fetches: unknown[] }) {
  for (let i = 0; i < 12 && fixture.fetches.length === 0; i++) await setImmediate();
  assert.equal(fixture.fetches.length, 1, 'The synthetic provider transport was reached');
  await setImmediate();
}

test('live independent gateway security: complete upstream validation precedes call release and actual tool execution', async t => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const f = await gatewayFixture(t, { fetch: async (_url, _init, index) => index === 1
    ? new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) : wireResponse(finalWire()) });
  const first = f.send(providerBody());
  upstream.enqueue(Buffer.from(callPrefix('call_security', { values: [9, -4, 12] })));
  await waitForFetch(f);
  assert.equal(first.response.headersSent, false); assert.equal(first.response.body, '');
  assert.deepEqual(f.run!.evidence().issued, []); assert.equal(f.tools.length, 0); assert.equal(f.notices.length, 0);
  upstream.enqueue(Buffer.from(toolTail())); upstream.close(); await first.done;
  assert.equal(first.response.status, 200);
  assert.deepEqual(parseLiveSse(first.response.body).calls.map(call => ({ id: call.id, arguments: call.arguments })), [{ id: 'call_security', arguments: { values: [9, -4, 12] } }]);
  assert.equal(f.tools.length, 0, 'Validated model output still needs an actual native tool request');
  const tool = f.callTool(); await tool.done; assert.equal(tool.response.status, 200); assert.equal(f.tools.length, 1);
  assert.deepEqual(JSON.parse(tool.response.body), { sum: 17, count: 3, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' });
  const repeated = f.callTool(); await repeated.done; assert.equal(repeated.response.body, tool.response.body); assert.equal(f.tools.length, 1);
  const messages: unknown[] = [...initialMessages(), { role: 'assistant', content: null, tool_calls: [nativeCall('call_security', { values: [9, -4, 12] })] },
    { role: 'tool', tool_call_id: 'call_security', content: tool.response.body }];
  const second = f.send(providerBody(messages)); await second.done; assert.equal(second.response.status, 200);
  assert.equal(f.run!.evidence().complete, true); assert.equal(f.fetches.length, 2);
  for (const request of f.fetches) {
    assert.equal(request.url, 'https://api.deepseek.com/chat/completions'); assert.equal(request.init.redirect, 'error');
    assert.equal(new Headers(request.init.headers).get('authorization'), `Bearer ${apiKey}`);
    const body = JSON.parse(String(request.init.body)); assert.equal(body.model, 'deepseek-v4-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 16384); assert.equal(body.tool_choice, 'auto');
    assert.equal(JSON.stringify(body).includes('native-system-not-authorized'), false);
    assert.equal(JSON.stringify(body).includes(apiKey), false);
  }
  assert.deepEqual(f.notices, [1, 2].map(request => ({ request, responseModel: 'deepseek-flash', usage: null })));
  assert.equal(JSON.stringify([first.response.body, second.response.body, f.notices, f.services.traffic(), f.run!.evidence()]).includes(apiKey), false);
});

test('live independent gateway security: malformed, incomplete and cancelled tails execute zero business tools', async t => {
  for (const mode of ['append-arguments', 'change-id', 'change-name', 'missing-done', 'length', 'error', 'reasoning', 'wire-overflow', 'invalid-utf8', 'cancel', 'premature-tool'] as const) {
    await t.test(mode, async child => {
      let upstream!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
      const f = await gatewayFixture(child, { fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
      const first = f.send(providerBody());
      upstream.enqueue(Buffer.from(callPrefix('call_security', { values: [9, -4, 12] })));
      await waitForFetch(f);
      assert.equal(first.response.body, ''); assert.deepEqual(f.run!.evidence().issued, []); assert.equal(f.tools.length, 0);
      if (mode === 'cancel') f.services.end(runId);
      else if (mode === 'premature-tool') { const early = f.callTool(); await early.done; assert.notEqual(early.response.status, 200); }
      else {
        let tail = toolTail();
        if (mode === 'append-arguments') tail = frame({ tool_calls: [{ index: 0, function: { arguments: '{"values":[99]}' } }] }) + tail;
        if (mode === 'change-id') tail = frame({ tool_calls: [{ index: 0, id: 'changed_call' }] }) + tail;
        if (mode === 'change-name') tail = frame({ tool_calls: [{ index: 0, function: { name: 'question' } }] }) + tail;
        if (mode === 'missing-done') tail = frame({}, 'tool_calls');
        if (mode === 'length') tail = frame({}, 'length') + 'data: [DONE]\n\n';
        if (mode === 'error') tail = 'data: {"error":{"message":"synthetic-secret-must-not-escape"}}\n\n' + tail;
        if (mode === 'reasoning') tail = frame({ reasoning_content: 'unexpected thinking' }) + tail;
        if (mode === 'wire-overflow') tail = ' '.repeat(16777217);
        if (mode === 'invalid-utf8') upstream.enqueue(Uint8Array.from([0xc3, 0x28]));
        upstream.enqueue(Buffer.from(tail)); upstream.close();
      }
      await first.done; assert.notEqual(first.response.status, 200);
      assert.equal(first.response.body.includes('tool_calls'), false); assert.equal(first.response.body.includes('synthetic-secret'), false);
      assert.equal(f.notices.length, 0); assert.equal(f.tools.length, 0);
      const denied = f.callTool(); await denied.done; assert.notEqual(denied.response.status, 200); assert.equal(f.tools.length, 0);
      assert.equal(f.fetches.length, 1); assert.equal(f.run!.evidence().complete, false);
    });
  }
});

test('live independent gateway security: forbidden destinations, fields and foreign transcript data are rejected before fetch', async t => {
  for (const mode of ['route', 'origin', 'model', 'url', 'thinking', 'reasoning-effort', 'tool-choice', 'foreign-chat', 'forged-tool', 'extra-tool'] as const) {
    await t.test(mode, async child => {
      const f = await gatewayFixture(child); const body: Record<string, unknown> = providerBody();
      if (mode === 'model') body.model = 'kimi-k3';
      if (mode === 'url') body.baseURL = 'https://untrusted.invalid/v1';
      if (mode === 'thinking') body.thinking = { type: 'enabled' };
      if (mode === 'reasoning-effort') body.reasoning_effort = 'high';
      if (mode === 'tool-choice') body.tool_choice = 'required';
      if (mode === 'foreign-chat') body.messages = [...initialMessages(), { role: 'user', content: 'foreign-chat-sentinel' }];
      if (mode === 'forged-tool') body.messages = [...initialMessages(), { role: 'tool', tool_call_id: 'invented_call', content: '17' }];
      if (mode === 'extra-tool') body.tools = [...liveTools(), { type: 'function', function: { name: 'shell', parameters: {} } }];
      const request = f.send(body, mode === 'route' ? { path: '/v1/models' } : mode === 'origin' ? { origin: 'https://untrusted.invalid' } : {});
      await request.done; assert.notEqual(request.response.status, 200); assert.equal(f.fetches.length, 0); assert.equal(f.tools.length, 0);
      assert.equal(f.services.traffic().totalProviderAttempts, 1); assert.equal(f.services.traffic().totalHttpRequests, 0);
    });
  }
});

test('live independent gateway budget security: actual dispatches one through eight are counted and ninth never fetches', async t => {
  const f = await gatewayFixture(t, { fetch: async (_url, _init, index) => wireResponse(callPrefix(`call_budget_${index}`, { values: [index] }) + toolTail()) });
  const messages: unknown[] = initialMessages();
  for (let index = 1; index <= 8; index++) {
    const request = f.send(providerBody(messages)); await request.done; assert.equal(request.response.status, 200, `dispatch ${index}`);
    const callId = `call_budget_${index}`, args = { values: [index] };
    const tool = f.callTool(callId, args); await tool.done; assert.equal(tool.response.status, 200);
    assert.equal(JSON.parse(tool.response.body).sum, index);
    messages.push({ role: 'assistant', content: null, tool_calls: [nativeCall(callId, args)] }, { role: 'tool', tool_call_id: callId, content: tool.response.body });
  }
  const ninth = f.send(providerBody(messages)); await ninth.done;
  assert.notEqual(ninth.response.status, 200); assert.equal(f.fetches.length, 8); assert.equal(f.tools.length, 8);
  assert.equal(f.services.traffic().totalProviderAttempts, 9); assert.equal(f.services.traffic().totalHttpRequests, 8);
  assert.deepEqual(f.notices.map(value => (value as { request: number }).request), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(f.run!.evidence().failed, true);
});

test('live independent gateway budget security: a concurrent contender cannot reserve the same final dispatch', async t => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const f = await gatewayFixture(t, { maxRequests: 1, fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
  const first = f.send(providerBody()); upstream.enqueue(Buffer.from(callPrefix('call_security', { values: [9, -4, 12] })));
  await waitForFetch(f);
  const second = f.send(providerBody()); await second.done; await first.done;
  assert.notEqual(first.response.status, 200); assert.notEqual(second.response.status, 200);
  assert.equal(f.fetches.length, 1); assert.equal(f.tools.length, 0); assert.equal(f.notices.length, 0);
  assert.equal(f.services.traffic().totalProviderAttempts, 2); assert.equal(f.services.traffic().totalHttpRequests, 1);
  assert.equal(f.fetches[0]!.init.signal?.aborted, true);
});

test('live independent gateway failure security: failed dispatches consume budget and native retry cannot send again', async t => {
  for (const failure of ['network', 401, 429, 500] as const) await t.test(String(failure), async child => {
    const f = await gatewayFixture(child, { fetch: async () => {
      if (failure === 'network') throw Error(apiKey);
      return Response.json({ error: { message: apiKey } }, { status: failure });
    } });
    const first = f.send(providerBody()); await first.done;
    const retry = f.send(providerBody()); await retry.done;
    assert.notEqual(first.response.status, 200); assert.notEqual(retry.response.status, 200);
    assert.equal(f.fetches.length, 1); assert.equal(f.tools.length, 0); assert.equal(f.notices.length, 0);
    assert.equal(f.services.traffic().totalProviderAttempts, 2); assert.equal(f.services.traffic().totalHttpRequests, 1);
    assert.equal(JSON.stringify([first.response.body, retry.response.body, f.services.traffic()]).includes(apiKey), false);
  });
});

test('live independent gateway question security: arbitrary sequential questions retain exact answer and transcript ownership', async t => {
  const questions = ['第一笔的单位是“元”还是“万元”？', '第二笔请确认：\n增加还是减少？'];
  const answers = ['单位是元，保持 120。', '减少 53；上一条只说明单位。'];
  const args = questions.map((question, i) => ({ questions: [{ question, header: `确认 ${i + 1}`, options: [], multiple: false }] }));
  const f = await gatewayFixture(t, { fetch: async (_url, _init, index) => wireResponse(index < 3
    ? callPrefix(`call_question_${index}`, args[index - 1], 'question') + toolTail() : finalWire()) });
  const messages: unknown[] = initialMessages();
  const expectedResults: string[] = [];
  for (let i = 0; i < 2; i++) {
    const request = f.send(providerBody(messages)); await request.done; assert.equal(request.response.status, 200);
    assert.equal(f.fetches.length, i + 1); assert.equal(f.run!.evidence().complete, false);
    const callID = `call_question_${i + 1}`, questionID = `que_free_${i + 1}`;
    f.run!.question({ questionID, messageID: `msg_question_${i + 1}`, callID, prompt: questions[i]!, arguments: args[i] });
    f.run!.answer(answers[i]!, questionID);
    f.run!.answerDelivery(questionID, Promise.resolve());
    const content = `User has answered your questions: "${questions[i]}"="${answers[i]}". You can now continue with the user's answers in mind.`;
    expectedResults.push(content);
    messages.push({ role: 'assistant', content: null, tool_calls: [nativeCall(callID, args[i], 'question')] }, { role: 'tool', tool_call_id: callID, content });
  }
  const final = f.send(providerBody(messages)); await final.done; assert.equal(final.response.status, 200);
  assert.equal(f.run!.evidence().complete, true); assert.equal(f.tools.length, 0);
  const outbound = JSON.parse(String(f.fetches[2]!.init.body));
  assert.deepEqual(outbound.messages.filter((entry: { role: string }) => entry.role === 'tool').map((entry: { content: string }) => entry.content), expectedResults);
  assert.throws(() => f.run!.answer('迟到的旧答案', 'que_free_1'));
  assert.equal(f.fetches.length, 3);
});

test('live independent gateway binding security: changed question or cached tool identity never acquires another execution', async t => {
  for (const mode of ['question-call', 'question-message', 'question-text', 'question-id', 'duplicate-answer', 'tool-message', 'tool-session', 'tool-args'] as const) {
    await t.test(mode, async child => {
      const isTool = mode.startsWith('tool-'), args = isTool ? { values: [9, -4, 12] } : { questions: [{ question: '请确认金额。', header: '金额', options: [] }] };
      const f = await gatewayFixture(child, { fetch: async () => wireResponse(callPrefix('call_bound', args, isTool ? 'pilot_sum' : 'question') + toolTail()) });
      const request = f.send(providerBody()); await request.done; assert.equal(request.response.status, 200);
      if (isTool) {
        const first = f.callTool('call_bound'); await first.done; assert.equal(first.response.status, 200);
        const patch = mode === 'tool-message' ? { messageID: 'msg_foreign' } : mode === 'tool-session' ? { sessionID: 'ses_foreign' } : {};
        const altered = f.callTool('call_bound', mode === 'tool-args' ? { values: [99] } : { values: [9, -4, 12] }, patch);
        await altered.done; assert.notEqual(altered.response.status, 200); assert.equal(f.tools.length, 1);
      } else {
        const binding = { questionID: 'que_bound', messageID: 'msg_bound', callID: 'call_bound', prompt: '请确认金额。', arguments: args };
        f.run!.question(binding);
        if (mode === 'duplicate-answer') { f.run!.answer('增加 18。', binding.questionID); assert.throws(() => f.run!.answer('改为 99。', binding.questionID)); }
        else {
          const patch = mode === 'question-call' ? { callID: 'call_not_issued' } : mode === 'question-message' ? { messageID: 'msg_foreign' }
            : mode === 'question-id' ? { questionID: 'que_foreign' } : { prompt: '问题已更换。' };
          assert.throws(() => f.run!.question({ ...binding, ...patch }));
        }
        assert.equal(f.tools.length, 0);
      }
      assert.equal(f.fetches.length, 1); assert.equal(f.run!.evidence().failed, true);
    });
  }
});

test('live independent gateway timeout security: headers, first body byte, idle and total deadlines revoke held calls', async t => {
  for (const mode of ['headers', 'first-body-byte', 'idle', 'total'] as const) await t.test(mode, async child => {
    child.mock.timers.enable({ apis: ['setTimeout'] });
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    const f = await gatewayFixture(child, { requestTimeoutMs: mode === 'total' ? 100000 : 600000,
      fetch: async () => mode === 'headers' ? new Promise<Response>(() => {}) : new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) });
    const request = f.send(providerBody());
    if (mode === 'idle' || mode === 'total') upstream.enqueue(Buffer.from(callPrefix('call_security', { values: [9, -4, 12] })));
    await waitForFetch(f);
    if (mode === 'total') {
      child.mock.timers.tick(50000); upstream.enqueue(Buffer.from(': keepalive\n\n')); await setImmediate();
      child.mock.timers.tick(49999); await setImmediate(); assert.equal(request.response.writableEnded, false);
      child.mock.timers.tick(1);
    } else {
      child.mock.timers.tick(mode === 'idle' ? 59999 : 119999); await setImmediate();
      assert.equal(request.response.writableEnded, false); child.mock.timers.tick(1);
    }
    await request.done; assert.notEqual(request.response.status, 200); assert.equal(f.tools.length, 0); assert.equal(f.notices.length, 0);
    assert.equal(f.fetches[0]!.init.signal?.aborted, true);
    const reason = mode === 'idle' ? 'idle_timeout' : mode === 'total' ? 'request_timeout' : 'first_byte_timeout';
    assert.ok(f.services.traffic().entries.some(entry => entry.reason === reason), reason);
    const retry = f.send(providerBody()); await retry.done; assert.equal(f.fetches.length, 1);
  });
});

test('live independent gateway answer admission security: an early continuation waits for acknowledgement and cannot survive failure or stop', async t => {
  for (const mode of ['acknowledged', 'uncertain', 'stopped'] as const) await t.test(mode, async child => {
    const prompt = '请确认第三笔金额。', answer = '增加 18。';
    const args = { questions: [{ question: prompt, header: '金额', options: [] }] };
    const f = await gatewayFixture(child, { fetch: async (_url, _init, index) => wireResponse(index === 1
      ? callPrefix('call_ack', args, 'question') + toolTail() : finalWire()) });
    const first = f.send(providerBody()); await first.done; assert.equal(first.response.status, 200);
    f.run!.question({ questionID: 'que_ack', messageID: 'msg_ack', callID: 'call_ack', prompt, arguments: args });
    f.run!.answer(answer, 'que_ack');
    let acknowledge!: () => void, reject!: (error: Error) => void;
    const delivery = new Promise<void>((yes, no) => { acknowledge = yes; reject = no; });
    f.run!.answerDelivery('que_ack', delivery);
    const messages: unknown[] = [...initialMessages(), { role: 'assistant', content: null, tool_calls: [nativeCall('call_ack', args, 'question')] },
      { role: 'tool', tool_call_id: 'call_ack', content: `User has answered your questions: "${prompt}"="${answer}". You can now continue with the user's answers in mind.` }];
    const next = f.send(providerBody(messages)); await setImmediate(); await setImmediate();
    assert.equal(f.fetches.length, 1); assert.equal(next.response.headersSent, false); assert.equal(f.tools.length, 0);
    assert.equal(f.services.traffic().totalProviderAttempts, 2); assert.equal(f.services.traffic().totalHttpRequests, 1);
    assert.ok(f.services.traffic().entries.some(entry => entry.reason === 'answer_pending'));
    if (mode === 'acknowledged') acknowledge();
    else if (mode === 'uncertain') reject(Error('PRIVATE_ACK_FAILURE'));
    else { f.services.end(runId); acknowledge(); }
    await next.done; await setImmediate();
    assert.equal(next.response.status === 200, mode === 'acknowledged'); assert.equal(f.fetches.length, mode === 'acknowledged' ? 2 : 1);
    assert.equal(f.run!.evidence().complete, mode === 'acknowledged'); assert.equal(f.tools.length, 0);
    if (mode !== 'acknowledged') { const retry = f.send(providerBody(messages)); await retry.done; assert.equal(f.fetches.length, 1); }
    assert.equal(JSON.stringify([next.response.body, f.services.traffic()]).includes('PRIVATE_ACK_FAILURE'), false);
  });
});

test('live independent completion security: only confirmed cleanup can publish success and user stop wins the cleanup race', async t => {
  for (const mode of ['abort-failed', 'success-delayed', 'stop-during-cleanup'] as const) await t.test(mode, async () => {
  const owner = { senderId: 101, isTopFrame: true, appOrigin: 'null', navigationEpoch: 1,
    appSessionId: 'security-live', windowId: 'security-live', webContentsId: 101, workspaceId: 'security-live', rootId: 'security-live' };
  const selected: PilotModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
  let saved: PilotDisk = { version: 1, runs: [] }, aborts = 0, executions = 0;
  let operation: Promise<void> | undefined;
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const client = {
    health: async () => true, createSession: async () => 'ses_cleanup_security', prompt: async () => {},
    messages: async () => [
      { info: { id: 'user_cleanup', sessionID: 'ses_cleanup_security', role: 'user', time: { created: 1 } },
        parts: [{ id: 'part_user_cleanup', sessionID: 'ses_cleanup_security', messageID: 'user_cleanup', type: 'text', text: `Task:\n${liveGoal}\n\nConstraints:\n${liveConstraint}` }] },
      { info: { id: 'assistant_cleanup', sessionID: 'ses_cleanup_security', role: 'assistant', parentID: 'user_cleanup', agent: 'pilot', providerID: 'workbench', modelID: 'deepseek-v4-flash', finish: 'stop', time: { created: 2, completed: 3 } },
        parts: [{ id: 'part_final_cleanup', sessionID: 'ses_cleanup_security', messageID: 'assistant_cleanup', type: 'text', text: '合计为 17。' }] },
    ],
    questions: async () => [], answer: async () => { throw Error('No question in this fixture'); },
    abort: async () => { aborts++; if (mode === 'abort-failed') throw Error('SYNTHETIC_ABORT_FAILED'); await cleanupGate; }, dispose() {},
  };
  const native = createOpenCodePilotEngine({ client, profile: 'live-deepseek', services: {
    begin: () => ({ bindSession() {}, answer() {}, evidence: () => ({ complete: true }) }), end() {}, close: async () => {},
  } });
  const engine: PilotEngine = { ...native,
    liveStatus: () => ({ model: selected, canStart: true, processState: 'ready', availability: 'available' }),
    accept: (_id, requested) => { assert.deepEqual(requested, selected); return selected; },
    start(input) { executions++; operation = native.start(input); void operation.catch(() => {}); return operation; },
  };
  const host = createPilotHost({ owner, engine, store: {
    load: () => saved, save(value) { saved = parsePilotDisk(value); }, close() {},
  } });
  try {
    await host.initialization;
    const accepted = await host.invoke('startRun', owner, { contractVersion: PILOT_VERSION, clientRequestId,
      goal: liveGoal, constraint: liveConstraint, model: selected });
    assert.equal((accepted as { ok: boolean }).ok, true);
    for (let i = 0; i < 12 && aborts === 0; i++) await setImmediate();
    assert.ok(operation); assert.equal(executions, 1); assert.equal(aborts, 1);
    if (mode === 'abort-failed') {
      await assert.rejects(operation); await setImmediate(); assert.equal(await native.health(), false);
      assert.notEqual(saved.runs[0]?.status, 'completed', 'A failed native cleanup must not be persisted as a successful live task');
      assert.equal(saved.runs[0]?.status, 'failed');
    } else {
      assert.equal(saved.runs[0]?.status, 'running', 'Completed cannot precede the pending cleanup barrier');
      if (mode === 'stop-during-cleanup') {
        await host.invoke('stopRun', owner, { contractVersion: PILOT_VERSION, runId: saved.runs[0]!.runId });
        assert.equal(saved.runs[0]?.status, 'stopped');
      }
      releaseCleanup(); await operation; await setImmediate();
      assert.equal(saved.runs[0]?.status, mode === 'success-delayed' ? 'completed' : 'stopped');
      assert.equal(saved.runs[0]?.events.filter(entry => entry.type === 'run.completed').length, mode === 'success-delayed' ? 1 : 0);
    }
  } finally { releaseCleanup(); host.revoke(); await native.shutdown?.().catch(() => {}); }
  });
});

test('live independent runtime security: accepting freezes credentials before deferred startup and disposal cannot skip other owners', async t => {
  for (const mode of ['normal', 'dispose-throws', 'exit-unconfirmed'] as const) await t.test(mode, async child => {
    const selected: PilotModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
    const config = { key: apiKey, model: selected.model as string, configured: true };
    let reads = 0, nativeStarts = 0, gatewayStarts = 0, fetches = 0;
    let providerOptions!: gatewayModule.LiveProviderOptions;
    let releaseEngine!: () => void;
    const execution = new Promise<void>(resolve => { releaseEngine = resolve; });
    const order: string[] = [], nativeOptions: unknown[] = [];
    let nested: Promise<void> | undefined, runtime!: PilotEngine;
    const settings: LiveRuntimeOptions['settings'] = {
      key: () => { reads++; return config.configured ? config.key : undefined; }, defaultModel: () => config.model,
      read: () => ({ ok: true, value: { storage: 'ready', encryptionAvailable: true, providers: [{
        provider: 'deepseek', address: 'https://api.deepseek.com', model: config.model, configured: config.configured,
        source: 'file', maxOutputTokens: 8192, timeoutMs: 600000,
      }] } }),
    };
    child.mock.method(gatewayModule, 'createLiveProviderServices', async (input: gatewayModule.LiveProviderOptions) => {
      gatewayStarts++; providerOptions = input;
      return { port: 43123, providerToken: 'a'.repeat(64), toolToken: 'b'.repeat(64),
        end() { order.push('gateway.revoke'); }, close: async () => { order.push('gateway.close'); },
      } as unknown as gatewayModule.LiveProviderServices;
    });
    const projected: PilotEngine = {
      kind: 'opencode', version: '1.18.17', health: async () => true,
      start: async () => { order.push('engine.start'); await execution; }, answer: async () => {},
      stop: async () => { order.push('engine.stop'); releaseEngine(); },
      dispose() { order.push('engine.dispose'); nested = runtime.shutdown!(); releaseEngine(); if (mode === 'dispose-throws') throw Error(apiKey); },
      shutdown: async () => { order.push('engine.shutdown'); releaseEngine(); },
    };
    child.mock.method(nativeEngineModule, 'createOpenCodePilotEngine', () => projected);
    const supervisor: OpenCodeSupervisor = {
      port: 43124, password: 'c'.repeat(64), directory: 'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/security/cwd', pid: 43125,
      health: async () => true, diagnostics: () => ({ stdoutBytes: 0, stderrBytes: 0, outputLimitExceeded: false, markers: [] }),
      exited: new Promise(() => {}), stop: async () => { order.push('native.stop'); return { exited: mode !== 'exit-unconfirmed', code: 0, signal: null }; },
    };
    const budget = { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000, deadlineMs: 600000, waitMs: 1800000 };
    runtime = createLiveRuntime({ settings, budget, fetchImpl: async () => { fetches++; throw Error('No provider in runtime fixture'); },
      startNative: async input => { nativeStarts++; nativeOptions.push(input); return supervisor; } });
    budget.maxRequests = 999; budget.requestTimeoutMs = 1;
    for (let i = 0; i < 3; i++) { assert.equal(runtime.liveStatus!().canStart, true); assert.equal(await runtime.health(), true); }
    assert.deepEqual([reads, gatewayStarts, nativeStarts, fetches], [0, 0, 0, 0]);
    assert.deepEqual(runtime.accept!(runId, selected), selected);
    config.key = 'sk-replaced_after_acceptance_987654'; config.model = 'deepseek-v4-flash-vision-exp';
    const controller = new AbortController();
    const running = runtime.start({ runId, model: selected, prompt: pilotPrompt(liveGoal, liveConstraint), signal: controller.signal,
      callbacks: { notice() {}, tool: async () => { throw Error('No tool in runtime fixture'); } } });
    for (let i = 0; i < 12 && !order.includes('engine.start'); i++) await setImmediate();
    assert.ok(order.includes('engine.start')); assert.equal(reads, 1);
    assert.deepEqual(providerOptions.getRunCredentials(runId), { apiKey, maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000 });
    assert.equal(runtime.liveStatus!().availability, 'unsupported_model');
    assert.equal(JSON.stringify(nativeOptions).includes(apiKey), false); assert.equal(JSON.stringify(nativeOptions).includes(config.key), false);
    const closing = runtime.shutdown!(); assert.equal(runtime.shutdown!(), closing); assert.equal(nested, closing);
    assert.throws(() => providerOptions.getRunCredentials(runId)); assert.equal(runtime.liveStatus!().canStart, false);
    if (mode === 'normal') await closing; else await assert.rejects(closing, { message: 'OpenCode pilot unavailable' });
    await running;
    for (const action of ['gateway.revoke', 'engine.dispose', 'engine.shutdown', 'gateway.close', 'native.stop']) assert.equal(order.filter(entry => entry === action).length, 1, action);
    assert.equal(fetches, 0); assert.equal(nativeStarts, 1);
    assert.throws(() => runtime.accept!('pilot.00000000-0000-4000-8000-000000000104', selected));
  });
});

test('live independent composition security: QA requires explicit isolated roots and every privileged dependency before any fallback', async () => {
  const calls: string[] = [], root = path.resolve('C:/work/analog_ai_workbench');
  const dataRoot = path.join(root, '.local', 'agent-engine-live-tests', '00000000-0000-4000-8000-000000000105');
  const unused = (name: string): never => { calls.push(name); throw Error('Forbidden preparation side effect'); };
  const dependencies: CloudDesktopDependencies = {
    credentials: () => unused('credential'), encryption: { available: () => unused('encryption'), encrypt: () => unused('encrypt'), decrypt: () => unused('decrypt') },
    chatV1: async () => unused('chat-v1'), chatV2: async () => unused('chat-v2'), providerFetch: async () => unused('provider'),
    nativeFactory: async () => unused('native'), loadReviewed: () => unused('reviewed'), loadSynthetic: async () => unused('synthetic'),
    liveBudget: { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000, deadlineMs: 600000, waitMs: 1800000 },
  };
  const options = { mode: 'qa' as const, applicationRoot: root, dataRoot, profileRoot: path.join(dataRoot, 'profile'), dependencies };
  const prepared = createCloudDesktopOptions(options); assert.equal(prepared.preloadEntry, 'sessions.js');
  assert.equal(typeof prepared.registerExtension, 'function'); assert.deepEqual(calls, []);
  for (const key of ['credentials', 'encryption', 'chatV1', 'chatV2', 'providerFetch', 'nativeFactory', 'loadReviewed', 'loadSynthetic', 'liveBudget']) {
    const missing = { ...dependencies } as Record<string, unknown>; delete missing[key];
    const invalid = { ...options, dependencies: missing } as unknown as typeof options;
    assert.throws(() => createCloudDesktopOptions(invalid), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
    await assert.rejects(startCloudDesktop(invalid), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
  }
  for (const patch of [
    { dataRoot: path.join(root, '.local') }, { profileRoot: path.join(root, '.local', 'cloud-user-data') },
    { dataRoot: path.resolve('C:/work/analog_ai_lab/.local') },
  ]) assert.throws(() => createCloudDesktopOptions({ ...options, ...patch }), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
  for (const liveBudget of [
    { ...dependencies.liveBudget, maxRequests: 9 }, { ...dependencies.liveBudget, deadlineMs: 4800001 },
    { ...dependencies.liveBudget, maxOutputTokens: 16385 }, { ...dependencies.liveBudget, waitMs: 1800001 },
    { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000, deadlineMs: 600000 },
  ]) assert.throws(() => createCloudDesktopOptions({ ...options, dependencies: { ...dependencies, liveBudget } } as typeof options));
  assert.deepEqual(calls, []);
});

test('live independent answer security: uncertain native acknowledgement cannot retry, complete or regain cleanup authority', async () => {
  const owner = { senderId: 106, isTopFrame: true, appOrigin: 'null', navigationEpoch: 1,
    appSessionId: 'security-answer', windowId: 'security-answer', webContentsId: 106, workspaceId: 'security-answer', rootId: 'security-answer' };
  const selected: PilotModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
  const prompt = '第三笔金额尚未知，请确认。', questionId = 'que_uncertain', callId = 'call_uncertain';
  const args = { questions: [{ question: prompt, header: '金额', options: [], multiple: false, custom: true }] };
  let saved: PilotDisk = { version: 1, runs: [] }, nativeAnswers = 0, creates = 0, rejects = 0, aborts = 0;
  let operation: Promise<void> | undefined, input: Parameters<PilotEngine['start']>[0] | undefined;
  let rejectReply!: (error: Error) => void;
  const acknowledgement = new Promise<void>((_resolve, reject) => { rejectReply = reject; });
  const order: string[] = [];
  const client = {
    health: async () => true, createSession: async () => { creates++; return 'ses_answer_security'; }, prompt: async () => {},
    messages: async () => [
      { info: { id: 'user_answer', sessionID: 'ses_answer_security', role: 'user', time: { created: 1 } }, parts: [{ id: 'part_user_answer', sessionID: 'ses_answer_security', messageID: 'user_answer', type: 'text', text: `Task:\n${liveGoal}\n\nConstraints:\n${liveConstraint}` }] },
      { info: { id: 'assistant_answer', sessionID: 'ses_answer_security', role: 'assistant', parentID: 'user_answer', agent: 'pilot', providerID: 'workbench', modelID: selected.model, time: { created: 2 } },
        parts: [{ id: 'part_question_answer', sessionID: 'ses_answer_security', messageID: 'assistant_answer', type: 'tool', tool: 'question', callID: callId, state: { status: 'running', input: args } }] },
    ],
    questions: async () => nativeAnswers ? [] : [{ id: questionId, sessionID: 'ses_answer_security', questions: args.questions, tool: { messageID: 'assistant_answer', callID: callId } }],
    answer: async (_session: string, id: string, answer: string) => { assert.equal(id, questionId); assert.equal(answer, '增加 18。\n不要假定为零。'); nativeAnswers++; order.push('native.answer'); await acknowledgement; },
    abort: async () => { aborts++; }, reject: async () => { rejects++; }, dispose() {},
  };
  const native = createOpenCodePilotEngine({ client, profile: 'live-deepseek', services: {
    begin: () => ({ bindSession() {}, question(binding) { assert.equal(binding.callID, callId); assert.equal(binding.prompt, prompt); },
      answer(_answer, id) { assert.equal(id, questionId); }, evidence: () => ({ complete: false }) }), end() {}, close: async () => {},
  } });
  const engine: PilotEngine = { ...native,
    liveStatus: () => ({ model: selected, canStart: true, processState: 'ready', availability: 'available' }),
    accept: () => selected, start(value) { input = value; operation = native.start(value); void operation.catch(() => {}); return operation; },
  };
  const host = createPilotHost({ owner, engine, store: {
    load: () => saved, save(value) { saved = parsePilotDisk(value); if (value.runs[0]?.events.at(-1)?.type === 'question.answered') order.push('answer.persist'); }, close() {},
  } });
  try {
    await host.initialization;
    await host.invoke('startRun', owner, { contractVersion: PILOT_VERSION, clientRequestId, goal: liveGoal, constraint: liveConstraint, model: selected });
    for (let i = 0; i < 12 && saved.runs[0]?.status !== 'waiting_user'; i++) await setImmediate();
    assert.equal(saved.runs[0]?.status, 'waiting_user'); const id = saved.runs[0]!.runId;
    const request = { contractVersion: PILOT_VERSION, runId: id, questionId, answer: '增加 18。\n不要假定为零。' };
    assert.deepEqual(await host.invoke('answerQuestion', owner, { ...request, questionId: 'que_foreign' }), { ok: false, error: { code: 'STALE_QUESTION' } });
    assert.equal(nativeAnswers, 0);
    assert.deepEqual(await host.invoke('answerQuestion', owner, request), { ok: true, value: { accepted: true } });
    assert.deepEqual(order, ['answer.persist', 'native.answer']);
    assert.deepEqual(await host.invoke('answerQuestion', owner, request), { ok: false, error: { code: 'STALE_QUESTION' } });
    rejectReply(Error('SYNTHETIC_PRIVATE_REPLY_DETAIL'));
    assert.ok(operation); await assert.rejects(operation); await setImmediate();
    assert.equal(saved.runs[0]?.status, 'failed'); assert.equal(nativeAnswers, 1); assert.equal(aborts, 1); assert.equal(rejects, 0);
    assert.equal(await native.health(), false); assert.ok(input);
    const before = JSON.stringify(saved);
    input.callbacks.notice({ type: 'text', text: '迟到正文' }); input.callbacks.notice({ type: 'completed' });
    await assert.rejects(input.callbacks.tool({ sessionId: 'ses_answer_security', callId: 'late_call', toolName: 'pilot.sum.v1', arguments: { values: [1] } }));
    assert.equal(JSON.stringify(saved), before); assert.equal(before.includes('SYNTHETIC_PRIVATE_REPLY_DETAIL'), false);
    await assert.rejects(native.start({ ...input, runId: 'pilot.00000000-0000-4000-8000-000000000107', signal: new AbortController().signal }));
    assert.equal(creates, 1);
  } finally { rejectReply(Error('fixture cleanup')); host.revoke(); await native.shutdown?.().catch(() => {}); }
});

test('live independent initialization security: throwing cloud construction enrolls cleanup before credentials and waits for the acquired runtime', async t => {
  const order: string[] = [], handlers = new Map<string, unknown>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const parent = createInitializationShutdown({ timeoutMs: 1000 });
  const root = path.resolve('C:/work/analog_ai_workbench');
  const dataRoot = path.join(root, '.local', 'agent-engine-live-tests', '00000000-0000-4000-8000-000000000108');
  const owner = { senderId: 108, isTopFrame: true, appOrigin: 'null', navigationEpoch: 1,
    appSessionId: 'security-init', windowId: 'security-init', webContentsId: 108, workspaceId: 'security-init', rootId: 'security-init' };
  let engineRevoked = false, storeClosed = false;
  t.mock.method(settingsModule, 'createModelSettings', () => {
    order.push('settings.create'); return { dispose() { order.push('settings.revoke'); } } as unknown as ReturnType<typeof settingsModule.createModelSettings>;
  });
  t.mock.method(runtimeModule, 'createLiveRuntime', () => {
    order.push('runtime.create'); return {
      kind: 'opencode', version: '1.18.17', health: async () => !engineRevoked,
      start: async () => { throw Error('No startup during construction'); }, answer: async () => {}, stop: async () => {},
      dispose() { if (!engineRevoked) { engineRevoked = true; order.push('runtime.revoke'); } },
      shutdown: async () => { order.push('runtime.shutdown'); await gate; order.push('runtime.exited'); },
    };
  });
  t.mock.method(storeModule, 'createPilotStore', () => {
    order.push('store.create'); return { load: () => ({ version: 1 as const, runs: [] }), save() { throw Error('No task writes'); },
      close() { if (!storeClosed) { storeClosed = true; order.push('store.close'); } } };
  });
  t.mock.method(workspaceModule, 'workspaceExtension', () => () => { order.push('workspace.throw'); throw Error('SYNTHETIC_CONSTRUCTION_FAILURE'); });
  const forbidden = (): never => { throw Error('No native, provider, source or encryption I/O'); };
  const options = createCloudDesktopOptions({ mode: 'qa', applicationRoot: root, dataRoot, profileRoot: path.join(dataRoot, 'profile'), dependencies: {
    credentials: () => { assert.equal(order[0], 'parent.enrolled'); order.push('credentials'); return { deepseek: apiKey }; },
    encryption: { available: forbidden, encrypt: forbidden, decrypt: forbidden },
    chatV1: async () => forbidden(), chatV2: async () => forbidden(), providerFetch: async () => forbidden(), nativeFactory: async () => forbidden(),
    loadReviewed: forbidden, loadSynthetic: async () => forbidden(),
    liveBudget: { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000, deadlineMs: 600000, waitMs: 1800000 },
  } });
  type Context = Parameters<NonNullable<typeof options.registerExtension>>[0];
  const ipcMain = { handle(channel: string, handler: unknown) { handlers.set(channel, handler); }, removeHandler(channel: string) { handlers.delete(channel); } } as unknown as Context['ipcMain'];
  try {
    assert.throws(() => options.registerExtension!({ ipcMain, owner, deriveCallerContext: () => owner,
      registerCleanup(participant) { order.push('parent.enrolled'); parent.register(participant); },
    }), { message: 'CLOUD_BOOTSTRAP_INITIALIZATION' });
    parent.completeConstruction();
    let settled = false; const pending = parent.shutdown(); void pending.then(() => { settled = true; });
    assert.equal(parent.shutdown(), pending); await setImmediate();
    assert.ok(order.includes('runtime.shutdown')); assert.equal(settled, false); assert.equal(engineRevoked, true);
    release(); await pending;
    assert.equal(order.filter(entry => entry === 'runtime.shutdown').length, 1);
    assert.ok(order.indexOf('runtime.exited') > order.indexOf('runtime.revoke')); assert.equal(handlers.size, 0); assert.equal(storeClosed, true);
  } finally { release(); parent.completeConstruction(); await parent.shutdown().catch(() => {}); }
});

test('live independent initialization security: shutdown during construction waits for late registered owners and bounds a hung drain', async t => {
  for (const mode of ['resolved', 'owner-fails', 'timeout'] as const) await t.test(mode, async child => {
    child.mock.timers.enable({ apis: ['setTimeout'] });
    const order: string[] = [], failures: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = createInitializationShutdown({ timeoutMs: 100, onFailure: code => failures.push(code) });
    cleanup.register({ revoke() { order.push('first.revoke'); }, dispose() { order.push('first.dispose'); } });
    const pending = cleanup.shutdown(); let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    assert.throws(() => cleanup.register({ revoke() { order.push('late.revoke'); },
      async shutdown() { order.push('late.shutdown'); await gate; if (mode === 'owner-fails') throw Error('PRIVATE_FAILURE'); },
      dispose() { order.push('late.dispose'); },
    }), { message: 'CLOUD_SHUTDOWN_STARTED' });
    assert.deepEqual(order, ['first.revoke', 'late.revoke']); await setImmediate(); assert.equal(settled, false);
    cleanup.completeConstruction(); await setImmediate(); assert.ok(order.includes('late.shutdown'));
    if (mode === 'timeout') { child.mock.timers.tick(100); await assert.rejects(pending, { message: 'CLOUD_SHUTDOWN_TIMEOUT' }); }
    else { release(); if (mode === 'owner-fails') await assert.rejects(pending, { message: 'CLOUD_SHUTDOWN_FAILED' }); else await pending; }
    assert.equal(order.filter(entry => entry === 'late.dispose').length, 1); assert.equal(order.filter(entry => entry === 'first.dispose').length, 1);
    assert.equal(cleanup.shutdown(), pending); assert.equal(failures.length, mode === 'resolved' ? 0 : 1); release();
  });
});
