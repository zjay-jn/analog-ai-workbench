import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createProjectReadProviderServices, type ProjectReadProviderOptions } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { PROJECT_READ_MODEL, projectReadTools } from '../apps/desktop/src/main/agent-project-read/protocol';
import type { ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';

const user = 'Synthetic retry transcript', key = 'synthetic-provider-secret', tick = () => new Promise<void>(resolve => setImmediate(resolve));
const frame = (delta: unknown, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ id: 'retry-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
const final = () => frame({ role: 'assistant', content: 'Synthetic success' }) + frame({}, 'stop') + 'data: [DONE]\n\n';
const listArgs = { directoryId: null, cursor: null, refresh: false };
const toolWire = () => frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'issued-once', type: 'function', function: { name: 'project_list', arguments: JSON.stringify(listArgs) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
const response = (wire = final()) => new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
const body = (messages: unknown[] = [{ role: 'user', content: user }]) => ({ model: PROJECT_READ_MODEL.model, messages, tools: projectReadTools(), stream: true });
const result: ProjectReadToolResult = { ok: true, value: { kind: 'list', phase: 'data', snapshotId: 'snapshot', entries: [], rules: [], resume: null, coverage: { scope: { projectId: 'project', bindingId: 'binding', identity: 'identity', directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 0, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null } } };
class Reply extends EventEmitter {
  status = 0; body = ''; destroyed = false; headersSent = false; writableEnded = false; headers: Record<string, unknown> = {};
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
  end(value: string) { this.body = value; this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; return this; }
}
async function fixture(t: TestContext, fake: (attempt: number, init: RequestInit) => Promise<Response>, limits: { requests?: number; request?: number; first?: number; idle?: number; onResponse?: () => void } = {}) {
  let handler!: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  class Server extends EventEmitter { listen(_port: number, _host: string, ready: () => void) { ready(); return this; } address() { return { port: 43123 }; } close(done: () => void) { done(); return this; } }
  t.mock.method(http, 'createServer', ((listener: typeof handler) => { handler = listener; return new Server(); }) as unknown as typeof http.createServer);
  const sent: string[] = [], counters = { failures: 0, responses: 0, tools: 0 };
  const options: ProjectReadProviderOptions = {
    getRunCredentials: () => ({ apiKey: key, model: PROJECT_READ_MODEL, maxRequests: limits.requests ?? 8, maxOutputTokens: 2048, requestTimeoutMs: limits.request ?? 5000 }),
    timeouts: { firstByteTimeoutMs: limits.first ?? 1000, idleTimeoutMs: limits.idle ?? 500 },
    onResponse: () => { counters.responses++; limits.onResponse?.(); },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + key);
      sent.push(String(init.body)); return fake(sent.length, init);
    },
  };
  const service = await createProjectReadProviderServices(options), run = service.begin({ runId: 'retry-run', goal: 'synthetic', constraint: '', initialUserText: user, systemText: 'Synthetic permissions', onFailure: () => { counters.failures++; }, onTool: async () => { counters.tools++; return result; } });
  run.bindSession('owned-session');
  function pending(value: unknown = body(), tool = false) {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { headers: { authorization: 'Bearer ' + (tool ? service.toolToken : service.providerToken), 'content-type': 'application/json' }, url: tool ? '/tool' : '/v1/chat/completions', method: 'POST', socket: { remoteAddress: '127.0.0.1', setTimeout() {} } });
    const reply = new Reply(), done = handler(request as unknown as http.IncomingMessage, reply as unknown as http.ServerResponse);
    return { reply, done };
  }
  return { service, run, sent, counters, pending, async post(value: unknown = body(), tool = false) { const work = pending(value, tool); await work.done; return work.reply; } };
}
async function until(done: () => boolean) { for (let i = 0; i < 100; i++) { if (done()) return; await tick(); } assert.fail('synthetic request did not settle'); }
function retry(reply: Reply, status = 503, delay?: number) {
  assert.equal(reply.status, status); assert.deepEqual(JSON.parse(reply.body), { error: { message: status === 504 ? 'Upstream request timed out' : 'Upstream temporarily unavailable' } });
  assert.equal(Object.keys(reply.headers).some(name => name.toLowerCase() === 'retry-after'), false); assert.equal(reply.body.includes(key), false);
  assert.equal(reply.headers['retry-after-ms'], delay === undefined ? undefined : String(delay));
}

for (const status of ['network', 408, 429, 500, 502, 503, 504] as const) test('provider retry: ' + status + ' defers to native and commits only its successful retry', async t => {
  let cancelled = false;
  const f = await fixture(t, async attempt => {
    if (attempt > 1) return response();
    if (status === 'network') throw Error('private provider URL ' + key);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'retry-after': '99999999999999', 'x-private': key } });
  });
  try {
    retry(await f.post()); assert.equal(f.counters.failures, 0); assert.equal(f.counters.responses, 0);
    assert.equal(f.run.evidence().failed, false); assert.equal(f.run.evidence().recoverableReason, 'UPSTREAM'); assert.equal(f.run.evidence().failureReason, undefined);
    assert.equal(f.run.evidence().responses, 0); assert.deepEqual(f.run.evidence().issued, []); if (status !== 'network') assert(cancelled);
    assert.equal((await f.post()).status, 200); assert.deepEqual(f.sent[0], f.sent[1]);
    assert.equal(f.counters.responses, 1); assert.equal(f.counters.failures, 0); assert.equal(f.run.evidence().recoverableReason, undefined);
    assert.equal(f.run.evidence().httpRequests, 2); assert.equal(f.run.evidence().attempts, 2); assert.equal(f.run.evidence().complete, true);
    assert.equal(JSON.stringify(f.service.traffic()).includes(key), false);
  } finally { await f.service.close(); }
});

for (const mode of ['request', 'first', 'idle'] as const) test('provider retry: main ' + mode + ' deadline is recoverable without committing partial bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let cancelled = false;
  const f = await fixture(t, async (attempt, init) => {
    if (attempt > 1) return response();
    if (mode === 'idle') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant', content: 'uncommitted' }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => { cancelled = true; reject(Error('synthetic aborted')); }, { once: true }));
  }, { request: mode === 'request' ? 30 : 100, first: 40, idle: 20 });
  try {
    const pending = f.pending(); await until(() => f.sent.length === 1); await tick(); t.mock.timers.tick(mode === 'request' ? 30 : mode === 'first' ? 40 : 20); await pending.done;
    retry(pending.reply, 504); assert(cancelled); assert.equal(f.counters.failures, 0); assert.equal(f.run.evidence().responses, 0);
    assert.equal(f.run.evidence().recoverableReason, mode === 'request' ? 'TIMEOUT' : mode === 'first' ? 'FIRST_RESPONSE_TIMEOUT' : 'IDLE_TIMEOUT');
    assert.equal((await f.post()).status, 200); assert.equal(f.run.evidence().recoverableReason, undefined); assert.equal(f.run.evidence().responses, 1);
  } finally { await f.service.close(); t.mock.timers.reset(); }
});

for (const mode of [400, 401, 403, 501, 'protocol'] as const) test('provider retry: ' + mode + ' remains terminal and sanitized', async t => {
  const f = await fixture(t, async () => mode === 'protocol' ? response('not a complete SSE ' + key) : new Response(key, { status: mode }));
  try {
    const reply = await f.post(); assert.equal(reply.status, 400); assert.deepEqual(JSON.parse(reply.body), { error: 'LIVE_REJECTED' }); assert.doesNotMatch(reply.body, /timeout|429|unavailable/iu);
    assert.equal(f.counters.failures, 1); assert.equal(f.run.evidence().failed, true); assert.equal(f.run.evidence().recoverableReason, undefined);
    assert.equal(f.run.evidence().responses, 0); assert.deepEqual(f.run.evidence().issued, []);
    assert.equal((await f.post()).status, 400); assert.equal(f.sent.length, 1); assert.equal(f.counters.failures, 1);
  } finally { await f.service.close(); }
});

test('provider retry: same committed transcript reuses the issued tool without repeating its effect', async t => {
  const f = await fixture(t, async attempt => { if (attempt === 1) return response(toolWire()); if (attempt === 2) throw Error('synthetic network'); return response(); });
  const tool = { sessionID: 'owned-session', messageID: 'owned-message', callID: 'issued-once', toolName: 'project_list', arguments: listArgs };
  try {
    assert.equal((await f.post()).status, 200); const saved = await f.post(tool, true); assert.equal(saved.status, 200);
    const messages = [{ role: 'user', content: user }, { role: 'assistant', content: null, tool_calls: [{ id: 'issued-once', type: 'function', function: { name: 'project_list', arguments: JSON.stringify(listArgs) } }] }, { role: 'tool', tool_call_id: 'issued-once', content: saved.body }];
    retry(await f.post(body(messages))); assert.equal(f.run.evidence().responses, 1); assert.equal(f.run.evidence().resolvedCalls, 1);
    assert.equal((await f.post(tool, true)).body, saved.body); assert.equal(f.counters.tools, 1);
    assert.equal((await f.post(body(messages))).status, 200); assert.equal(f.sent[1], f.sent[2]); assert.equal(f.counters.tools, 1);
    assert.equal(f.run.evidence().responses, 2); assert.equal(f.run.evidence().complete, true);
  } finally { await f.service.close(); }
});

test('provider retry: request capacity is consumed and exhaustion returns a non-retry terminal response', async t => {
  const f = await fixture(t, async () => new Response(key, { status: 429 }), { requests: 2 });
  try {
    retry(await f.post()); assert.equal((await f.post()).status, 400); assert.equal(f.counters.failures, 1);
    assert.equal(f.run.evidence().failed, true); assert.equal(f.run.evidence().failureReason, 'UPSTREAM'); assert.equal(f.run.evidence().responses, 0);
    assert.equal(f.run.evidence().httpRequests, 2); assert.equal((await f.post()).status, 400); assert.equal(f.sent.length, 2); assert.equal(f.counters.failures, 1);
  } finally { await f.service.close(); }
});

test('provider retry: native exhaustion promotes its last trusted reason exactly once without a callback', async t => {
  const f = await fixture(t, async () => { throw Error('synthetic network'); });
  try {
    retry(await f.post()); f.service.finalizeFailure('foreign-run'); assert.equal(f.run.evidence().failed, false);
    assert.doesNotThrow(() => f.service.finalizeFailure('retry-run')); assert.doesNotThrow(() => f.service.finalizeFailure('retry-run'));
    assert.equal(f.run.evidence().failed, true); assert.equal(f.run.evidence().failureReason, 'UPSTREAM'); assert.equal(f.counters.failures, 0);
    assert.equal((await f.post()).status, 400); assert.equal(f.sent.length, 1);
  } finally { await f.service.close(); }
});

test('provider retry: stop during a retry remains cancelled and ignores late upstream success', async t => {
  let release!: (value: Response) => void, cancelled = false;
  const f = await fixture(t, async attempt => { if (attempt === 1) throw Error('synthetic network'); return new Promise<Response>(resolve => { release = resolve; }); });
  try {
    retry(await f.post()); const pending = f.pending(); await until(() => f.sent.length === 2); f.service.end('retry-run'); await pending.done;
    assert.equal(pending.reply.status, 400); f.service.finalizeFailure('retry-run');
    release(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } })); await until(() => cancelled);
    assert.equal(f.run.evidence().ended, true); assert.equal(f.run.evidence().responses, 0); assert.equal(f.run.evidence().failureReason, undefined); assert.equal(f.counters.failures, 0);
  } finally { await f.service.close(); }
});

test('provider retry: a timed out old attempt cannot poison a later successful response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let release!: (value: Response) => void, cancelled = false;
  const f = await fixture(t, async attempt => attempt === 1 ? new Promise<Response>(resolve => { release = resolve; }) : response(), { request: 30, first: 40, idle: 20 });
  try {
    const pending = f.pending(); await until(() => f.sent.length === 1); t.mock.timers.tick(30); await pending.done; retry(pending.reply, 504);
    assert.equal((await f.post()).status, 200);
    release(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 })); await until(() => cancelled);
    assert.equal(f.run.evidence().complete, true); assert.equal(f.run.evidence().failed, false); assert.equal(f.run.evidence().recoverableReason, undefined); assert.equal(f.counters.failures, 0);
  } finally { await f.service.close(); t.mock.timers.reset(); }
});

test('provider retry: reader network failure discards its partial response before native retry', async t => {
  let pulls = 0;
  const f = await fixture(t, async attempt => attempt > 1 ? response() : new Response(new ReadableStream({
    pull(controller) { if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant', content: 'partial' }))); else controller.error(Error('private reader failure ' + key)); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  try {
    retry(await f.post()); assert.equal(f.run.evidence().responses, 0); assert.deepEqual(f.run.evidence().issued, []);
    assert.equal((await f.post()).status, 200); assert.equal(f.run.evidence().responses, 1); assert.equal(f.counters.failures, 0);
  } finally { await f.service.close(); }
});

test('provider retry: changed retry transcript is rejected before another HTTP dispatch', async t => {
  const f = await fixture(t, async () => { throw Error('synthetic network'); });
  try {
    retry(await f.post()); assert.equal((await f.post(body([{ role: 'user', content: user + ' changed' }]))).status, 400);
    assert.equal(f.sent.length, 1); assert.equal(f.counters.failures, 1); assert.equal(f.run.evidence().recoverableReason, undefined);
  } finally { await f.service.close(); }
});

test('provider retry: a failure after committing a response cannot retry an uncertain publication', async t => {
  const f = await fixture(t, async () => response(toolWire()), { onResponse() { throw Error('synthetic publication failure'); } });
  try {
    assert.equal((await f.post()).status, 400); assert.equal(f.run.evidence().responses, 1); assert.deepEqual(f.run.evidence().issued, ['issued-once']);
    assert.equal(f.run.evidence().failed, true); assert.equal(f.run.evidence().recoverableReason, undefined); assert.equal(f.counters.failures, 1);
    assert.equal((await f.post()).status, 400); assert.equal(f.sent.length, 1); assert.equal(f.counters.tools, 0);
  } finally { await f.service.close(); }
});

test('provider retry: last allowed timeout is terminal while preserving its precise main reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, async (_attempt, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(Error('synthetic stop')), { once: true })), { requests: 1, request: 30, first: 40, idle: 20 });
  try {
    const pending = f.pending(); await until(() => f.sent.length === 1); t.mock.timers.tick(30); await pending.done;
    assert.equal(pending.reply.status, 400); assert.equal(f.counters.failures, 1); assert.equal(f.run.evidence().failureReason, 'TIMEOUT');
    assert.equal(f.run.evidence().recoverableReason, undefined); assert.equal((await f.post()).status, 400); assert.equal(f.sent.length, 1);
  } finally { await f.service.close(); t.mock.timers.reset(); }
});

test('provider retry: valid server delay is rebuilt as one bounded integer with native precedence', async t => {
  const now = Date.UTC(2026, 8, 17); t.mock.method(Date, 'now', () => now);
  const cases: Array<{ ms?: string; seconds?: string; expected: number }> = [
    { ms: '0', seconds: '99', expected: 0 }, { ms: '1.2', expected: 2 }, { ms: '2147483647', expected: 2147483647 },
    { ms: '1junk', seconds: '2.1', expected: 2100 }, { ms: '-1', seconds: '0', expected: 0 },
    { ms: 'Infinity', seconds: '.0001', expected: 1 }, { ms: '2147483648', seconds: '2', expected: 2000 },
    { seconds: '999999', expected: 999999000 }, { seconds: '2147483.647', expected: 2147483647 },
    { seconds: 'Thu, 17 Sep 2026 00:00:01 GMT', expected: 1000 },
    { ms: 'bad', seconds: 'Thursday, 17-Sep-26 00:00:01 GMT', expected: 1000 },
    { seconds: 'Thu Sep 17 00:00:01 2026', expected: 1000 },
  ];
  for (const [index, value] of cases.entries()) {
    const headers: Record<string, string> = { 'x-private': key, ...(value.ms === undefined ? {} : { 'retry-after-ms': value.ms }), ...(value.seconds === undefined ? {} : { 'retry-after': value.seconds }) };
    const f = await fixture(t, async () => new Response(key, { status: index % 2 ? 503 : 429, headers }));
    try { const reply = await f.post(); retry(reply, 503, value.expected); assert.deepEqual(Object.keys(reply.headers).sort(), ['Cache-Control', 'Connection', 'Content-Type', 'retry-after-ms'].sort()); assert.equal(f.sent.length, 1); assert.equal(f.counters.failures, 0); }
    finally { await f.service.close(); }
  }
});

test('provider retry: malformed, expired and overflowing retry headers are omitted', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 8, 17));
  const cases: Array<Record<string, string>> = [
    { 'retry-after-ms': '-1' }, { 'retry-after-ms': 'Infinity' }, { 'retry-after-ms': '1junk' }, { 'retry-after-ms': '1e3' },
    { 'retry-after-ms': '2147483647.1' }, { 'retry-after-ms': '2147483647.0000000001' }, { 'retry-after': '2147483.6470000001' }, { 'retry-after': '2147483.648' }, { 'retry-after': '-1' }, { 'retry-after': 'Infinity' },
    { 'retry-after': '1junk' }, { 'retry-after': '1e3' }, { 'retry-after': 'Thu, 17 Sep 2026 00:00:00 GMT' },
    { 'retry-after': 'Wed, 16 Sep 2026 00:00:00 GMT' }, { 'retry-after': 'Thu, 30 Feb 2028 00:00:00 GMT' },
    { 'retry-after': 'Fri, 18 Dec 2026 00:00:00 GMT' }, { 'retry-after': '2026-09-17T00:00:01Z' },
    { 'retry-after-ms': 'bad', 'retry-after': 'bad' },
  ];
  for (const headers of cases) {
    const f = await fixture(t, async () => new Response(key, { status: 429, headers }));
    try { retry(await f.post()); assert.equal(f.counters.failures, 0); }
    finally { await f.service.close(); }
  }
});

test('provider retry: terminal errors never attach upstream retry headers', async t => {
  for (const status of [429, 503, 401, 200]) {
    const f = await fixture(t, async () => new Response('invalid protocol ' + key, { status, headers: { 'content-type': 'text/event-stream', 'retry-after-ms': '0', 'retry-after': '10', 'x-private': key } }), { requests: status === 429 || status === 503 ? 1 : 8 });
    try { const reply = await f.post(); assert.equal(reply.status, 400); assert.deepEqual(JSON.parse(reply.body), { error: 'LIVE_REJECTED' }); assert.doesNotMatch(reply.body, /timeout|429|unavailable/iu); assert.deepEqual(Object.keys(reply.headers).sort(), ['Cache-Control', 'Connection', 'Content-Type'].sort()); assert.equal(f.counters.failures, 1); assert.equal(reply.body.includes(key), false); }
    finally { await f.service.close(); }
  }
});
