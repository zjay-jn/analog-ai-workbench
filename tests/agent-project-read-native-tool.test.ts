import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { waveArguments, waveValues } from './fixtures/waveform-results';
import { PROJECT_READ_LIMITS as L, type ProjectReadToolName } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadToolArguments, parseProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read-validation';

// Execute only this reviewed zero-import source, with no real process or network surface.
const modulePath = 'C:/work/analog_ai_workbench/tools/agent-project-read-tools.mjs';
const source = fs.readFileSync(modulePath, 'utf8');
assert.equal((source.match(/^export function createProjectReadNativeTool\(/gmu) ?? []).length, 1);
assert.equal(/\bimport\s*(?:\(|[{'*])/u.test(source), false);
type Tool = { description: string; args: Record<string, unknown>; execute(args: unknown, ctx: unknown): Promise<string> };
const names = ['fs_list','fs_find','fs_search','fs_read','project_list', 'project_find', 'project_search', 'project_read', 'pilot_sum', 'wsl_results_list', 'wsl_results_read', 'wsl_waveform_list', 'wsl_waveform_read', 'wsl_waveform_metrics'] as const;
const args = { project_list: { directoryId: null, cursor: null, refresh: false }, project_find: { directoryId: null, cursor: null, refresh: false, query: '资料' }, project_search: { directoryId: null, cursor: null, refresh: false, query: 'text' }, project_read: { fileId: 'file_main_1', version: null, start: { line: 1, column: 1 }, cursor: null }, pilot_sum: { values: [2, -1, 4] },
  fs_list:{path:'C:\\Synthetic',directoryId:null,cursor:null,refresh:false},fs_find:{path:'C:\\Synthetic',directoryId:null,cursor:null,refresh:false,query:'notes'},fs_search:{path:'C:\\Synthetic\\notes.log',directoryId:null,fileId:null,cursor:null,refresh:false,query:'text'},fs_read:{path:'C:\\Synthetic\\notes.log',fileId:null,version:null,start:{line:1,column:1},cursor:null},
  wsl_results_list:{bindingId:'wsl-binding-test',relativeDirectory:'',nameQuery:'',cursor:null},wsl_results_read:{bindingId:'wsl-binding-test',fileId:'wsl-file-test',version:'10:20:0:1:1',startLine:1,maxLines:200},...waveArguments };
const token = 'a'.repeat(64), port = '43129';
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
const resultFor = (name: ProjectReadToolName): unknown => {
  if(name==='wsl_waveform_list'||name==='wsl_waveform_read'||name==='wsl_waveform_metrics')return {ok:true,value:waveValues[name]};
  const binding={distro:'ROCKY9_LLM_LAB',user:'maxwell',rootPath:'/home/maxwell/simulation/folded/results',id:'wsl-binding-test',rootIdentity:'1:2',readerVersion:'aaw.wsl-results.v1',selectedAt:'2026-09-15T00:00:00.000Z'};
  if(name==='wsl_results_list')return {ok:true,value:{kind:name,binding,relativeDirectory:'',entries:[],nextCursor:null,complete:true,scannedCandidates:0,physicalReadBytes:0}};
  if(name==='wsl_results_read')return {ok:true,value:{kind:name,source:{...binding,relativePath:'empty.csv',absolutePath:binding.rootPath+'/empty.csv'},fileId:'wsl-file-test',fileIdentity:'10:20',version:'10:20:0:1:1',rawSha256:'b'.repeat(64),excerptSha256:'b'.repeat(64),startLine:1,endLine:0,totalLines:0,fileBytes:0,text:'',nextLine:null,complete:true,citationId:'wsl-cite-test',physicalReadBytes:0,scannedCandidates:1}};
  if (name === 'pilot_sum') return { ok: true, value: { kind: 'sum', sum: 5, count: 3, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' } };
  const coverage = { scope: { projectId: 'project_1', bindingId: 'binding_1', identity: 'identity_1', directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 0, scannedFiles: 0, scannedBytes: 0, returned: 0, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null };
  const base = { phase: 'data', snapshotId: 'snapshot_main_1', coverage, rules: [], resume: null };
  if(name.startsWith('fs_')){const source={kind:'windows_filesystem',sourceId:'fs-source-1',rootPath:'C:\\Synthetic',rootIdentity:'b'.repeat(64)},value={...base,source,nextArguments:null,coverage:{...coverage,scope:{kind:'windows_filesystem',projectId:'project_1',bindingId:null,sourceId:source.sourceId,identity:source.rootIdentity,directoryId:'fs-root',relativeDirectory:'',absoluteDirectory:source.rootPath}}};return {ok:true,value:name==='fs_read'?{...value,kind:'read',citation:null,empty:true,next:null}:name==='fs_search'?{...value,kind:'search',matches:[]}:{...value,kind:name.slice(3),entries:[]}};}
  return { ok: true, value: name === 'project_read' ? { ...base, kind: 'read', citation: null, empty: true, next: null } : name === 'project_search' ? { ...base, kind: 'search', matches: [] } : { ...base, kind: name.slice(8), entries: [] } };
};
function harness(fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () => json(resultFor('project_list')), env: Record<string, string | undefined> = {}) {
  const requests: { url: string; init: RequestInit }[] = [], timers = new Map<number, { callback: () => void; ms: number }>(); let nextTimer = 1;
  const abort = new AbortController(), ctx = { sessionID: 'session_native_1', messageID: 'message_native_1', callID: 'call_native_1', abort: abort.signal, directory: 'C:/native-private-sentinel', worktree: 'C:/native-worktree-sentinel' };
  const sandbox = { TextEncoder, TextDecoder, AbortController, AbortSignal, Object, Array, Reflect, JSON, Number, String, Boolean, RegExp, Set, Map, Promise, performance,
    process: { env: { AAW_PILOT_TOOL_PORT: port, AAW_PILOT_TOOL_TOKEN: token, ...env } },
    fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return fetchImpl(url, init); },
    setTimeout(callback: () => void, ms: number) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; }, clearTimeout(id: number) { timers.delete(id); },
  };
  const create = vm.runInNewContext(source.replace(/^export function createProjectReadNativeTool\(/mu, 'function createProjectReadNativeTool(') + '\ncreateProjectReadNativeTool;', sandbox, { filename: 'reviewed-native-tool.mjs', timeout: 1000 }) as (name: string) => Tool;
  return { create, requests, timers, abort, ctx };
}
const unavailable = (error: unknown): boolean => { assert.equal(String(error), 'Error: Project tool unavailable'); return true; };

test('native factory exposes approved project and WSL wrappers with matching JSON-schema argument fields', () => {
  const h = harness();
  for (const name of names) { const tool = h.create(name); assert.equal(typeof tool.execute, 'function'); assert.ok(tool.description); assert.deepEqual(Object.keys(tool.args).sort(), Object.keys(args[name]).sort()); }
  for (const name of ['question', 'read', 'glob', 'grep', 'shell', 'fetch', 'constructor', 'project_find_other']) assert.throws(() => h.create(name), unavailable);
  const read = JSON.parse(JSON.stringify(h.create('project_read').args)); assert.equal(read.start.properties.line.maximum, L.lines); assert.equal(read.start.properties.column.maximum, L.fileBytes + 1); assert.equal(read.fileId.maxLength, L.idBytes);
  assert.equal((h.create('project_search').args.query as { maxLength: number }).maxLength, L.queryBytes); assert.equal(h.requests.length, 0);
});

test('each tool sends one authenticated fixed-loopback POST with the exact native identity and complete host result', async () => {
  for (const name of names) {
    const expected = resultFor(name); assert.ok(parseProjectReadToolResult(expected)); assert.ok(parseProjectReadToolArguments(name, args[name]));
    const h = harness(async () => json(expected)), result = await h.create(name).execute(args[name], h.ctx);
    assert.deepEqual(JSON.parse(result), expected); assert.ok(parseProjectReadToolResult(JSON.parse(result))); assert.equal(h.requests.length, 1);
    const request = h.requests[0]!; assert.equal(request.url, `http://127.0.0.1:${port}/tool`); assert.equal(request.init.method, 'POST'); assert.equal(request.init.redirect, 'error');
    assert.deepEqual(JSON.parse(JSON.stringify(request.init.headers)), { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(request.init.body)), { sessionID: h.ctx.sessionID, messageID: h.ctx.messageID, callID: h.ctx.callID, toolName: name, arguments: args[name] });
    assert.equal(String(request.init.body).includes(token), false); assert.equal(String(request.init.body).includes('native-private-sentinel'), false); assert.equal(result.includes(token), false); assert.equal(h.timers.size, 0); assert.equal(request.init.signal?.aborted, true);
  }
});

test('filesystem native failures preserve only the declared optional OS error code',async()=>{
  for(const osCode of ['ENOENT','EACCES','EPERM','ENOTDIR','EISDIR','EBUSY','EIO']){const expected={ok:false,error:{code:'IO_ERROR',osCode},coverage:null},h=harness(async()=>json(expected));assert.deepEqual(JSON.parse(await h.create('fs_read').execute(args.fs_read,h.ctx)),expected);}
  for(const name of ['fs_read','project_read'] as const){const h=harness(async()=>json({ok:false,error:{code:'IO_ERROR',osCode:name==='fs_read'?'RAW_PRIVATE_ERROR':'ENOENT'},coverage:null}));await assert.rejects(h.create(name).execute(args[name],h.ctx),unavailable);}
});
test('missing or malformed local credentials and unsupported ports reject before any fetch', async () => {
  for (const env of [{ AAW_PILOT_TOOL_PORT: undefined }, { AAW_PILOT_TOOL_PORT: '1023' }, { AAW_PILOT_TOOL_PORT: '65536' }, { AAW_PILOT_TOOL_PORT: '43129/elsewhere' }, { AAW_PILOT_TOOL_PORT: 'https://example.invalid' }, { AAW_PILOT_TOOL_TOKEN: undefined }, { AAW_PILOT_TOOL_TOKEN: 'bad-secret-sentinel' }, { AAW_PILOT_TOOL_TOKEN: 'a'.repeat(65) }]) {
    const h = harness(undefined, env); await assert.rejects(h.create('project_list').execute(args.project_list, h.ctx), unavailable); assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0);
  }
});

test('native session/message/call identity and pre-abort validation exclude source paths and forged tuples', async () => {
  for (const change of [{ sessionID: '' }, { messageID: 'message/foreign' }, { callID: '../path' }, { callID: 'x'.repeat(L.idBytes + 1) }, { abort: null }]) {
    const h = harness(); await assert.rejects(h.create('project_list').execute(args.project_list, { ...h.ctx, ...change }), unavailable); assert.equal(h.requests.length, 0);
  }
  const h = harness(); h.abort.abort(); await assert.rejects(h.create('project_list').execute(args.project_list, h.ctx), unavailable); assert.equal(h.requests.length, 0);
});

test('argument envelope and request byte limits reject extra, missing and oversized fields before dispatch', async () => {
  for (const value of [{ ...args.project_list, path: 'C:/outside' }, { directoryId: null, refresh: false }, null, [], { directoryId: 'x'.repeat(L.requestBytes), cursor: null, refresh: false }]) {
    const h = harness(); await assert.rejects(h.create('project_list').execute(value, h.ctx), unavailable); assert.equal(h.requests.length, 0);
  }
});

test('legacy native args do not replace main strict argument admission; malformed values never become a successful host result', async () => {
  for (const value of [{ ...args.project_list, directoryId: '../path' }, { ...args.project_list, refresh: 'false' }]) {
    let admitted = 0; const h = harness(async (_url, init) => { const body = JSON.parse(String(init.body)); const parsed = parseProjectReadToolArguments('project_list', body.arguments); if (!parsed) return new Response(null, { status: 400 }); admitted++; return json(resultFor('project_list')); });
    await assert.rejects(h.create('project_list').execute(value, h.ctx), unavailable); assert.equal(admitted, 0);
  }
  const semantic = { directoryId: 'issued_directory', cursor: null, refresh: true };
  assert.ok(parseProjectReadToolArguments('project_list', semantic));
  const semanticHost = harness(async () => json({ ok: false, error: { code: 'INVALID_REQUEST' }, coverage: null }));
  assert.equal(JSON.parse(await semanticHost.create('project_list').execute(semantic, semanticHost.ctx)).error.code, 'INVALID_REQUEST');
  const preparation = { ...args.project_read, version: null, cursor: 'main_rules_or_scan_cursor' }; assert.ok(parseProjectReadToolArguments('project_read', preparation));
  const h = harness(async () => json(resultFor('project_read'))); assert.ok(parseProjectReadToolResult(JSON.parse(await h.create('project_read').execute(preparation, h.ctx))));
});

test('complete ordinary JSON at the 12 KiB transport boundary is returned without truncation', async () => {
  const expected = resultFor('project_list'), serialized = JSON.stringify(expected), wire = serialized + ' '.repeat(L.toolResultBytes - Buffer.byteLength(serialized));
  assert.equal(Buffer.byteLength(wire), L.toolResultBytes); const h = harness(async () => new Response(wire, { headers: { 'content-type': 'application/json' } }));
  const result = await h.create('project_list').execute(args.project_list, h.ctx); assert.deepEqual(JSON.parse(result), expected); assert.ok(Buffer.byteLength(result) <= L.toolResultBytes);
});

test('oversized body, malformed JSON and invalid or incomplete UTF-8 reject with only the fixed error', async () => {
  const prefix = JSON.stringify(resultFor('project_list'));
  for (const body of [prefix + ' '.repeat(L.toolResultBytes), 'not-json secret-path-sentinel', new Uint8Array([0xc0, 0xaf]), new Uint8Array([0xe4, 0xb8])]) {
    const h = harness(async () => new Response(body, { headers: { 'content-type': 'application/json' } })); await assert.rejects(h.create('project_list').execute(args.project_list, h.ctx), unavailable); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  }
});

test('strict streaming decoder preserves multibyte JSON values across individual byte chunks', async () => {
  const expected = resultFor('project_list') as { ok: true; value: { entries: unknown[]; coverage: { returned: number; scannedCandidates: number } } };
  expected.value.entries = [{ fileId: 'file_main_1', directoryId: null, parentId: null, name: '资料.txt', relativePath: '资料.txt', kind: 'file', bytes: 6, readability: 'readable', version: null }]; expected.value.coverage.returned = 1; expected.value.coverage.scannedCandidates = 1; assert.ok(parseProjectReadToolResult(expected));
  const body = new TextEncoder().encode(JSON.stringify(expected)); const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of body) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const h = harness(async () => new Response(stream, { headers: { 'content-type': 'application/json' } })); assert.deepEqual(JSON.parse(await h.create('project_list').execute(args.project_list, h.ctx)), expected);
});

test('redirects, non-200 responses, wrong media types and missing bodies fail without any retry', async () => {
  const variants = [() => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }), () => new Response('error secret-sentinel', { status: 403 }), () => new Response('{}', { headers: { 'content-type': 'text/html' } }), () => new Response(null, { headers: { 'content-type': 'application/json' } }), () => { const value = json(resultFor('project_list')); Object.defineProperty(value, 'redirected', { value: true }); return value; }];
  for (const variant of variants) { const h = harness(async () => variant()); await assert.rejects(h.create('project_list').execute(args.project_list, h.ctx), unavailable); assert.equal(h.requests.length, 1); assert.equal(h.requests[0]!.init.signal?.aborted, true); }
});

test('wrong result envelopes or tool kinds are rejected, and legitimate error coverage is kept intact', async () => {
  for (const value of [{ ok: true, value: { kind: 'sum' } }, { ok: true, value: { kind: 'list' }, extra: 'foreign' }, { ok: false, error: { code: 'IO_ERROR', secret: token }, coverage: null }, { ok: false, error: { code: 'IO_ERROR' } }, null, []]) {
    const h = harness(async () => json(value)); await assert.rejects(h.create('project_list').execute(args.project_list, h.ctx), unavailable);
  }
  const expected = { ok: false, error: { code: 'SCOPE_LIMIT' }, coverage: null }; assert.ok(parseProjectReadToolResult(expected)); const h = harness(async () => json(expected)); assert.deepEqual(JSON.parse(await h.create('project_list').execute(args.project_list, h.ctx)), expected);
});

test('native envelope checks are transport checks, while full result schema validation remains in main', async () => {
  const incomplete = { ok: true, value: { kind: 'list' } }; assert.equal(parseProjectReadToolResult(incomplete), null);
  const h = harness(async () => json(incomplete)); const transported = JSON.parse(await h.create('project_list').execute(args.project_list, h.ctx));
  assert.deepEqual(transported, incomplete); assert.equal(parseProjectReadToolResult(transported), null);
  // This injected malformed host response proves no full-schema validation in native;
  // it does not establish model egress or a persisted record through the real main gateway.
});

test('abort while streaming closes the body and never releases a partial successful result', async () => {
  let reading!: () => void, cancelled = 0; const started = new Promise<void>(resolve => { reading = resolve; });
  const stream = new ReadableStream<Uint8Array>({ pull() { reading(); return new Promise<void>(() => {}); }, cancel() { cancelled++; } });
  const h = harness(async () => new Response(stream, { headers: { 'content-type': 'application/json' } })), pending = h.create('project_list').execute(args.project_list, h.ctx);
  await started; await new Promise<void>(resolve => setImmediate(resolve)); h.abort.abort(); await assert.rejects(pending, unavailable); assert.equal(cancelled, 1); assert.equal(h.timers.size, 0);
});

test('abort propagates to fetch and rejects a late valid reply even when the controlled stub ignores its signal', async () => {
  let finish!: (response: Response) => void; const h = harness(async () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = h.create('project_list').execute(args.project_list, h.ctx); h.abort.abort(); assert.equal(h.requests[0]!.init.signal?.aborted, true);
  finish(json(resultFor('project_list'))); await assert.rejects(pending, unavailable); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  // Prompt termination before a fetch promise settles depends on fetch honoring AbortSignal.
});

test('the bounded native timer aborts transport, rejects late results and is cleared after failure', async () => {
  let finish!: (response: Response) => void; const h = harness(async () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = h.create('project_list').execute(args.project_list, h.ctx); const timers = [...h.timers.values()]; assert.equal(timers.length, 1); assert.equal(timers[0]!.ms, L.operationMs + 2000);
  timers[0]!.callback(); assert.equal(h.requests[0]!.init.signal?.aborted, true); finish(json(resultFor('project_list'))); await assert.rejects(pending, unavailable); assert.equal(h.timers.size, 0);
});

test('waveform native wrappers allow the bounded reader shutdown acknowledgment before their 17 second transport cutoff', async () => {
  for (const name of ['wsl_waveform_list','wsl_waveform_read','wsl_waveform_metrics'] as const) {
    let finish!: (response: Response) => void; const h = harness(async () => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = h.create(name).execute(args[name], h.ctx); const timers = [...h.timers.values()]; assert.equal(timers.length, 1); assert.equal(timers[0]!.ms, 17000);
    timers[0]!.callback(); assert.equal(h.requests[0]!.init.signal?.aborted, true); finish(json(resultFor(name))); await assert.rejects(pending, unavailable); assert.equal(h.timers.size, 0);
  }
});

test('transport exceptions never echo credentials, URLs, context paths or response text into native errors', async () => {
  const h = harness(async () => { throw new Error(`synthetic ${token} C:/private-path http://127.0.0.1:${port}/tool`); });
  await assert.rejects(h.create('project_list').execute(args.project_list, h.ctx), unavailable); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
});
