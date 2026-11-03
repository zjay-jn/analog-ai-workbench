import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { PROJECT_READ_NATIVE_TOOL_IDENTITY } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import { parseProjectReadSse, projectReadTools } from '../apps/desktop/src/main/agent-project-read/protocol';
import { createProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { parseProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import { parseProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import type { ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';

// Explicit already-closed synthetic live batch. These are read-only recorded data, never a live transport.
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const base = 'C:/work/analog_ai_workbench/.local/quality-evidence/20260913-agent-project-read-live-01/raw/exercise';
const read = (name: string) => fs.readFileSync(path.join(base, name), 'utf8');
const wires = Array.from({ length: 6 }, (_, i) => read('response-' + (i + 1) + '.sse'));
const completions = wires.map(wire => parseProjectReadSse(wire));
const disk = parseProjectReadDisk(JSON.parse(read('ledger.raw.json'))); assert.ok(disk);
const saved = disk.runs.find(row => row.run.runId === 'project-7e86ac96-7552-45b2-9cc4-b4a83dc37fbe')!;
const lastCalls = completions[5]!.calls;
const start = saved.run.events.find(e => e.type === 'tool.started' && e.data.callId === lastCalls[0]!.id)!;
const end = saved.run.events.find(e => e.type === 'tool.completed' && e.data.callId === lastCalls[0]!.id)!;
assert.equal(end.type, 'tool.completed');
const searchResult = end.type === 'tool.completed' ? end.data.result : assert.fail('missing confirmed search');
const firstDuration = Date.parse(end.time) - Date.parse(start.time);
const source = fs.readFileSync('C:/work/analog_ai_workbench/tools/agent-project-read-tools.mjs', 'utf8');
type Tool = { execute(args: unknown, context: unknown): Promise<string> };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail('offline transport did not reach the expected checkpoint'); }
const error = (value: unknown) => String(value) === 'Error: Project tool unavailable';
function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; delay: number; callback: () => void }>();
  return { timers, now: () => now,
    setTimeout(callback: () => void, delay: number) { const id = ++next; timers.set(id, { at: now + delay, delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    advance(value: number) { assert.ok(value >= now); now = value; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.callback(); },
  };
}
function native(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, time = clock(), port = 43129, token = 'a'.repeat(64)) {
  const requests: { at: number; body: Record<string, unknown>; signal: AbortSignal }[] = [];
  const sandbox = { TextEncoder, TextDecoder, AbortController, AbortSignal, Object, Array, Reflect, JSON, Number, String, Boolean, RegExp, Set, Map, Promise,
    process: { env: { AAW_PILOT_TOOL_PORT: String(port), AAW_PILOT_TOOL_TOKEN: token } },
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    async fetch(url: string, init: RequestInit) { assert.equal(url, 'http://127.0.0.1:' + port + '/tool'); assert.equal(init.redirect, 'error'); assert.ok(init.signal); requests.push({ at: time.now(), body: JSON.parse(String(init.body)), signal: init.signal }); return fetchImpl(url, init); },
  };
  assert.equal(/\bimport\s*(?:\(|[{'*])/u.test(source), false);
  const create = vm.runInNewContext(source.replace(/^export function createProjectReadNativeTool\(/mu, 'function createProjectReadNativeTool(') + '\ncreateProjectReadNativeTool;', sandbox, { timeout: 1000 }) as (name: string) => Tool;
  const execute = (name: string, args: unknown, id: string, abort: AbortSignal, sessionID = 'offline-session') => create(name).execute(args, { sessionID, messageID: 'offline-message', callID: id, abort });
  return { execute, requests, time };
}
const emptyFind: ProjectReadToolResult = { ok: true, value: { kind: 'find', phase: 'data', snapshotId: 'offline-snapshot', rules: [], resume: null, entries: [], coverage: { scope: { projectId: 'offline-project', bindingId: 'offline-binding', identity: 'offline-identity', directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 0, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null } } };
const json = (result: unknown) => new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
const sumArgs = { values: [1, 2] }, sumResult = { ok: true, value: { kind: 'sum', sum: 3, count: 2, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' } };

test('six recorded SSE responses match the closed ledger and put cancellation exactly after the second queued native timer', () => {
  assert.equal(Buffer.byteLength(source), PROJECT_READ_NATIVE_TOOL_IDENTITY.bytes); assert.equal(createHash('sha256').update(source).digest('hex'), PROJECT_READ_NATIVE_TOOL_IDENTITY.sha256);
  assert.deepEqual(completions.map(c => c.calls.length), [1, 1, 0, 2, 2, 2]);
  const calls = completions.flatMap(c => c.calls), started = disk.runs.flatMap(row => row.run.events.filter(e => e.type === 'tool.started'));
  assert.equal(calls.length, 8); assert.equal(started.length, 8);
  for (const call of calls) { const event = started.find(e => e.data.callId === call.id); assert.ok(event); assert.equal(event.data.toolName, call.name); assert.deepEqual(event.data.arguments, call.arguments); }
  assert.equal(firstDuration, 7544); assert.deepEqual(lastCalls.map(c => c.name), ['project_search', 'project_find']);
  const traffic = read('timeline.ndjson').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.name === 'traffic');
  const arrived = traffic.find(row => row.order === 116), cancelled = traffic.find(row => row.order === 130), unbound = traffic.find(row => row.order === 131);
  assert.equal(arrived.value.kind, 'tool'); assert.equal(Date.parse(cancelled.time) - Date.parse(arrived.time), 12017); assert.equal(cancelled.value.reason, 'cancelled'); assert.equal(unbound.value.reason, 'unbound'); assert.ok(Date.parse(unbound.time) > Date.parse(cancelled.time));
  assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.cleanupState, 'idle'); assert.equal(saved.run.accounting.httpDispatches, 3);
});

test('recorded N02 two-call response survives queue wait plus a valid individual operation without changing the twelve-second timer', async () => {
  const time = clock(), gates = [gate(), gate()], entered: string[] = []; let failures = 0, externalDispatches = 0;
  const abort = new AbortController(), runId = 'offline-recorded-n02';
  const service = await createProjectReadProviderServices({ getRunCredentials: () => ({ apiKey: 'synthetic-offline-key', model, maxRequests: 24, maxOutputTokens: 16384, requestTimeoutMs: 600000 }), onResponse() {}, fetchImpl: async () => { externalDispatches++; return new Response(wires[5], { headers: { 'Content-Type': 'text/event-stream' } }); } });
  const request = JSON.parse(read('request-4.json')).body as { messages: { role: string; content: string }[] };
  const systemText = request.messages.find(m => m.role === 'system')!.content, initialUserText = request.messages.find(m => m.role === 'user')!.content;
  const run = service.begin({ runId, goal: saved.run.goal, constraint: '', systemText, initialUserText, onFailure() { failures++; abort.abort(); service.end(runId); }, async onTool(call) { const index = entered.length; entered.push(call.callId); await gates[index]!.promise; return index === 0 ? searchResult : emptyFind; } }); run.bindSession('offline-session');
  const provider = await fetch('http://127.0.0.1:' + service.port + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + service.providerToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.model, stream: true, tools: projectReadTools(), messages: [{ role: 'user', content: initialUserText }] }) });
  assert.equal(provider.status, 200); const issued = parseProjectReadSse(await provider.text());
  const h = native((url, init) => fetch(url, init), time, service.port, service.toolToken);
  const jobs = issued.calls.map(call => h.execute(call.name, call.arguments, call.id, abort.signal)); jobs.forEach(job => { void job.catch(() => {}); });
  try {
    await until(() => entered.length === 1); assert.ok([...time.timers.values()].every(t => t.delay === 12000));
    time.advance(firstDuration); gates[0]!.resolve(); await until(() => entered.length === 2);
    time.advance(12001); await tick(); await tick();
    // 5000 ms is a deterministic permitted find duration, not a claim about its unfinished live duration.
    time.advance(firstDuration + 5000); gates[1]!.resolve();
    const settled = await Promise.allSettled(jobs);
    assert.deepEqual(settled.map(row => row.status), ['fulfilled', 'fulfilled']);
    for (const row of settled) if (row.status === 'fulfilled') assert.ok(parseProjectReadToolResult(JSON.parse(row.value)));
    assert.deepEqual(h.requests.map(row => row.at), [0, firstDuration]); assert.equal(failures, 0); assert.equal(run.evidence().failed, false); assert.equal(run.evidence().resolvedCalls, 2); assert.equal(externalDispatches, 1); assert.equal(time.timers.size, 0);
  } finally { abort.abort(); gates.forEach(g => g.resolve()); await Promise.allSettled(jobs); await service.close(); }
});

test('a cancelled native waiter performs no POST and owns no timer while its predecessor runs', async () => {
  const gateA = gate(), firstAbort = new AbortController(), secondAbort = new AbortController(), thirdAbort = new AbortController();
  const h = native(async () => { await gateA.promise; return json(sumResult); });
  const first = h.execute('pilot_sum', sumArgs, 'first', firstAbort.signal), second = h.execute('pilot_sum', sumArgs, 'second', secondAbort.signal), third = h.execute('pilot_sum', sumArgs, 'third', thirdAbort.signal); void second.catch(() => {});
  try { assert.equal(h.requests.length, 1); assert.equal(h.time.timers.size, 1); secondAbort.abort(); await assert.rejects(second, error); assert.equal(h.requests.length, 1); h.time.advance(5000); gateA.resolve(); assert.deepEqual(JSON.parse(await first), sumResult); assert.deepEqual(JSON.parse(await third), sumResult); assert.deepEqual(h.requests.map(row => row.at), [0, 5000]); assert.equal(h.time.timers.size, 0); }
  finally { firstAbort.abort(); secondAbort.abort(); thirdAbort.abort(); gateA.resolve(); await Promise.allSettled([first, second, third]); }
});

test('native timeout or transport failure drops queued calls in that session but a fresh session remains usable', async t => {
  for (const mode of ['timeout', 'http-failure']) await t.test(mode, async () => {
    let release!: (value: Response) => void;
    const h = native(async (_url, init) => new Promise<Response>((resolve, reject) => { release = resolve; init.signal!.addEventListener('abort', () => reject(Error('synthetic abort')), { once: true }); }));
    const abort = new AbortController(), first = h.execute('pilot_sum', sumArgs, 'first', abort.signal), second = h.execute('pilot_sum', sumArgs, 'second', abort.signal); void first.catch(() => {}); void second.catch(() => {});
    if (mode === 'timeout') h.time.advance(12000); else release(new Response(null, { status: 400 }));
    await assert.rejects(first, error); await assert.rejects(second, error); assert.equal(h.requests.length, 1); assert.equal(h.time.timers.size, 0);
    await assert.rejects(h.execute('pilot_sum', sumArgs, 'late', abort.signal), error); assert.equal(h.requests.length, 1);
    const next = h.execute('pilot_sum', sumArgs, 'next', abort.signal, 'fresh-session'); await until(() => h.requests.length === 2); release(json(sumResult)); assert.deepEqual(JSON.parse(await next), sumResult);
  });
});
