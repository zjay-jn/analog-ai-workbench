import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_PROJECT_READ_VERSION as V, PROJECT_READ_LIMITS as SHARED_LIMITS } from '../apps/desktop/src/shared/agent/agent-project-read';
import type * as C from '../apps/desktop/src/shared/agent/agent-project-read';
import {
  PROJECT_READ_LIMITS, parseProjectReadRequest, parseProjectReadValue, parseProjectReadResult,
  parseProjectReadEvent, parseProjectReadToolArguments, parseProjectReadToolResult,
  projectReadJsonBytes, projectReadFitsJsonBudget,
} from '../apps/desktop/src/shared/agent/agent-project-read-validation';

const time = '2026-09-11T12:00:00.000Z', hash = 'a'.repeat(64);
const model: C.ProjectReadModel = { provider: 'deepseek', model: 'deepseek-v4-flash' };
const project: C.ProjectReadRef = { projectId: 'project_1', bindingId: 'binding_1', name: '合成项目', directoryName: 'Synthetic', directorySegments: ['C', 'Synthetic'], identity: 'root_1' };
const accounting: C.ProjectReadAccounting = { providerAttempts: 1, httpDispatches: 1, toolAttempts: 1, physicalReadBytes: 200, visitedCandidates: 2, contextBytes: null };
const budget: C.ProjectReadBudget = { providerAttempts: 24, httpDispatches: 24, toolAttempts: 64, physicalReadBytes: 268435456, visitedCandidates: 100000, contextBytes: 196608, outputBytes: 65536, maxOutputTokens: 16384, deadlineMs: 14400000, waitMs: 1800000 };
const summary: C.ProjectReadSummary = { runId: 'run_1', clientRequestId: 'client_1', project, model, goal: '查找合成说明', constraint: '', continuedFrom: null, status: 'running', cleanupState: 'idle', createdAt: time, updatedAt: time, accounting, eventCount: 2, continuation: null };
const coverage: C.ProjectReadCoverage = { scope: { projectId: project.projectId, bindingId: project.bindingId, identity: project.identity, directoryId: null, relativeDirectory: '' }, complete: true, scannedCandidates: 2, scannedFiles: 1, scannedBytes: 100, returned: 1, skipped: { policy: 0, unsupported: 0, fileLimit: 0, unavailable: 0 }, remaining: { directories: 0, files: 0, position: null }, nextCursor: null, limitReason: null };
const file: C.ProjectReadEntry = { fileId: 'file_1', directoryId: null, parentId: null, name: 'notes.md', relativePath: 'notes.md', kind: 'file', bytes: 100, readability: 'readable', version: null };
const directory: C.ProjectReadEntry = { fileId: null, directoryId: 'directory_1', parentId: null, name: 'docs', relativePath: 'docs', kind: 'directory', bytes: 0, readability: 'directory', version: null };
const preview: C.ProjectReadCitationPreview = { citationId: 'citation_1', fileId: 'file_1', relativePath: 'notes.md', version: hash, normalizedSha256: hash, range: { start: { line: 3, column: 4 }, end: { line: 4, column: 2 } }, excerpt: '甲😀\n乙', excerptSha256: hash, totalLines: 20, fileBytes: 100, source: 'read' };
const citation: C.ProjectReadCitation = { ...preview, runId: 'run_1', project, snapshotId: 'snapshot_1', fileIdentity: 'file_identity_1', createdAt: time, origin: null };
const accepted: C.ProjectReadEvent = { runId: 'run_1', sequence: 1, time, type: 'run.accepted', data: { project, model, continuedFrom: null, budget } };
const started: C.ProjectReadEvent = { runId: 'run_1', sequence: 2, time, type: 'run.started', data: { sessionId: 'session_1', engine: 'opencode', version: '1.18.17' } };
const listResult: C.ProjectReadToolResult = { ok: true, value: { kind: 'list', phase: 'data', snapshotId: 'snapshot_1', coverage, rules: [], resume: null, entries: [file] } };
const readResult: C.ProjectReadToolResult = { ok: true, value: { kind: 'read', phase: 'data', snapshotId: 'snapshot_1', coverage, rules: [], resume: null, citation: preview, empty: false, next: null } };
const readCall: C.ProjectReadEventData['tool.completed'] = { sessionId: 'session_1', messageId: 'message_1', callId: 'call_1', toolName: 'project_read', arguments: { fileId: 'file_1', version: hash, start: { line: 3, column: 4 }, cursor: null }, result: readResult };
const status: C.ProjectReadStatus = { model, project, availability: 'unchecked', canStart: true, processState: 'idle', cleanupState: 'idle', reason: null, activeTask: null };
type OriginalMethod = 'getStatus' | 'revalidateProject' | 'startRun' | 'listRuns' | 'readRun' | 'answerQuestion' | 'stopRun' | 'resolveCitation' | 'checkCitation' | 'browseProject' | 'cancelInspection' | 'deleteRun';
const requests: Pick<C.ProjectReadRequests, OriginalMethod> = {
  getStatus: { contractVersion: V, projectId: 'project_1' }, revalidateProject: { contractVersion: V, projectId: 'project_1', bindingId: 'binding_1' },
  startRun: { contractVersion: V, clientRequestId: 'client_1', projectId: 'project_1', bindingId: 'binding_1', model, goal: '检索中文😀，保留原文。\n', constraint: '', continuedFrom: null },
  listRuns: { contractVersion: V, projectId: null, before: null }, readRun: { contractVersion: V, runId: 'run_1', after: 0 },
  answerQuestion: { contractVersion: V, runId: 'run_1', questionId: 'question_1', answer: '先看第二节。' }, stopRun: { contractVersion: V, runId: 'run_1' },
  resolveCitation: { contractVersion: V, runId: 'run_1', citationId: 'citation_1' }, checkCitation: { contractVersion: V, runId: 'run_1', citationId: 'citation_1' },
  browseProject: { contractVersion: V, projectId: 'project_1', bindingId: 'binding_1', directoryId: null, cursor: null, refresh: true },
  cancelInspection: { contractVersion: V, projectId: 'project_1' }, deleteRun: { contractVersion: V, runId: 'run_1', expectedEventCount: 2 },
};
const values: Pick<C.ProjectReadValues, OriginalMethod> = {
  getStatus: status, revalidateProject: { ...status, availability: 'available' }, startRun: { runId: 'run_1' }, listRuns: { runs: [summary], nextBefore: null },
  readRun: { run: summary, events: [accepted, started], nextAfter: 2, hasMore: false }, answerQuestion: { accepted: true }, stopRun: { accepted: true },
  resolveCitation: citation, checkCitation: { citationId: 'citation_1', state: 'current', reason: null }, browseProject: { snapshotId: 'snapshot_1', coverage, entries: [file] },
  cancelInspection: { accepted: true }, deleteRun: { deleted: true },
};
function event(type: keyof C.ProjectReadEventData, data: unknown, sequence = 3): unknown { return { runId: 'run_1', sequence, time, type, data }; }
function badEvent(type: keyof C.ProjectReadEventData, data: unknown): void { assert.equal(parseProjectReadEvent(event(type, data)), null); }

test('original project-read public methods admit representative requests and envelopes without retaining input objects', () => {
  assert.equal(PROJECT_READ_LIMITS, SHARED_LIMITS);
  for (const method of Object.keys(requests) as OriginalMethod[]) {
    const parsed = parseProjectReadRequest(method, requests[method]);
    assert.deepEqual(parsed, requests[method], method); assert.notEqual(parsed, requests[method]); assert.ok(Object.isFrozen(parsed));
    assert.deepEqual(parseProjectReadValue(method, values[method]), values[method], method);
    const result = parseProjectReadResult(method, { ok: true, value: values[method] });
    assert.deepEqual(result, { ok: true, value: values[method] }, method);
    assert.deepEqual(parseProjectReadResult(method, { ok: false, error: { code: 'CAPABILITY_DENIED' } }), { ok: false, error: { code: 'CAPABILITY_DENIED' } });
  }
  const parsed = parseProjectReadValue('resolveCitation', citation)!;
  assert.ok(Object.isFrozen(parsed.range.start)); assert.ok(Object.isFrozen(parsed.project.directorySegments));
  assert.notEqual(parsed.project, project);
});

test('unknown methods, extra fields and ambiguous result unions fail closed', () => {
  for (const method of ['__proto__', 'constructor', 'then', 'project_read', '', 'futureMethod'] as unknown as C.ProjectReadMethod[]) {
    assert.equal(parseProjectReadRequest(method, requests.getStatus), null);
    assert.equal(parseProjectReadValue(method, {}), null);
    assert.equal(parseProjectReadResult(method, { ok: false, error: { code: 'BUSY' } }), null);
  }
  for (const method of Object.keys(requests) as OriginalMethod[]) {
    assert.equal(parseProjectReadRequest(method, { ...requests[method], path: 'C:\\private' }), null, method);
    assert.equal(parseProjectReadValue(method, { ...values[method], unexpected: true }), null, method);
    assert.equal(parseProjectReadResult(method, { ok: true, value: values[method], error: { code: 'BUSY' } }), null);
    assert.equal(parseProjectReadRequest(method, { ...requests[method], contractVersion: 'future' }), null);
  }
  for (const result of [{ ok: 1, value: {} }, { ok: false, error: { code: 'IO_ERROR', message: 'C:\\private' } }, { ok: false, error: { code: 'UNKNOWN' } }]) assert.equal(parseProjectReadResult('getStatus', result), null);
});

test('plain data admission rejects getters, symbols, sparse arrays and exotic prototypes without running hooks', () => {
  let invoked = 0;
  const getter = Object.defineProperty({ ...requests.getStatus }, 'projectId', { enumerable: true, get() { invoked++; return 'project_1'; } });
  const hidden = Object.defineProperty({ ...requests.getStatus }, 'projectId', { enumerable: false, value: 'project_1' });
  const polluted = Object.assign(Object.create({ injected: true }), requests.getStatus);
  const nullProto = Object.assign(Object.create(null), requests.getStatus);
  for (const value of [getter, hidden, polluted, nullProto, { ...requests.getStatus, [Symbol('hidden')]: true }, new Date(), [], null]) assert.equal(parseProjectReadRequest('getStatus', value), null);
  const arrays: unknown[] = [new Array(1), Object.assign([1], { extra: 1 }), Object.setPrototypeOf([1], null), Object.defineProperty([1], '0', { get() { invoked++; return 1; } }), Object.defineProperty([1], '0', { value: 1, enumerable: false }), Object.assign([1], { [Symbol('extra')]: 1 })];
  for (const value of arrays) assert.equal(parseProjectReadToolArguments('pilot_sum', { values: value }), null);
  const dangerous = { toJSON() { invoked++; throw new Error('must not run'); } };
  assert.equal(projectReadJsonBytes(dangerous), null); assert.equal(projectReadJsonBytes(getter), null); assert.equal(invoked, 0);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.doesNotThrow(() => assert.equal(parseProjectReadRequest('getStatus', revoked.proxy), null));
});

test('scalar UTF-8 limits preserve exact text and reject isolated surrogates and model/path authority fields', () => {
  const goal = '😀'.repeat(1024);
  assert.equal(parseProjectReadRequest('startRun', { ...requests.startRun, goal })?.goal, goal);
  for (const invalid of [goal + 'x', '\ud800', '\udfff', ' ', 3, null]) assert.equal(parseProjectReadRequest('startRun', { ...requests.startRun, goal: invalid }), null);
  assert.ok(parseProjectReadRequest('startRun', { ...requests.startRun, constraint: 'x'.repeat(4096) }));
  assert.equal(parseProjectReadRequest('answerQuestion', { ...requests.answerQuestion, answer: '界'.repeat(1366) }), null);
  for (const invalid of [{ ...model, baseURL: 'https://example.invalid' }, { provider: 'kimi', model: 'kimi-unsupported' }, { ...model, model: 'deepseek-flash' }]) assert.equal(parseProjectReadRequest('startRun', { ...requests.startRun, model: invalid }), null);
  for (const invalid of ['../secret', 'C:\\secret', '/secret', '', 'x'.repeat(257), '资料']) assert.equal(parseProjectReadRequest('getStatus', { ...requests.getStatus, projectId: invalid }), null);
  assert.ok(parseProjectReadRequest('getStatus', { ...requests.getStatus, projectId: 'x'.repeat(256) }));
});

test('finite integer budgets reject NaN, infinity, fractions and negative zero at request and event boundaries', () => {
  for (const value of [NaN, Infinity, -Infinity, -0, -1, 0.5, 1025, '2']) assert.equal(parseProjectReadRequest('readRun', { ...requests.readRun, after: value }), null);
  assert.ok(parseProjectReadRequest('readRun', { ...requests.readRun, after: 1024 }));
  for (const value of [NaN, Infinity, -1, -0, 1.5, Number.MAX_SAFE_INTEGER+1]) badEvent('model.step', { step: value });
  assert.ok(parseProjectReadEvent(event('model.step', { step: 25 })));
  badEvent('budget.updated', { ...accounting, httpDispatches: 2 });
  badEvent('budget.updated', { ...accounting, physicalReadBytes: 268435457 });
  badEvent('budget.updated', { ...accounting, visitedCandidates: 100001 });
  badEvent('model.response', { request: 1, responseModel: null, usage: { inputTokens: Infinity, outputTokens: 1 } });
  assert.ok(parseProjectReadEvent(event('model.response', { request: 24, responseModel: 'deepseek-flash', usage: null })));
});

test('Unicode scalar citation ranges use half-open columns across lines and remain display metadata', () => {
  assert.ok(parseProjectReadValue('resolveCitation', citation));
  for (const invalid of [
    { ...citation, range: { start: { line: 3, column: 4 }, end: { line: 4, column: 3 } } },
    { ...citation, range: { start: { line: 0, column: 4 }, end: { line: 4, column: 2 } } },
    { ...citation, totalLines: 3 }, { ...citation, fileBytes: 1 }, { ...citation, excerpt: '甲\ud800\n乙' },
    { ...citation, excerpt: '甲\r\n乙' }, { ...citation, normalizedSha256: 'A'.repeat(64) }, { ...citation, version: 'x' },
    { ...citation, origin: { runId: citation.runId, citationId: 'old' } },
  ]) assert.equal(parseProjectReadValue('resolveCitation', invalid), null);
  const single = { ...citation, excerpt: '😀', range: { start: { line: 2, column: 10 }, end: { line: 2, column: 11 } } };
  assert.ok(parseProjectReadValue('resolveCitation', single));
  assert.equal(parseProjectReadValue('resolveCitation', { ...single, range: { start: { line: 2, column: 10 }, end: { line: 2, column: 12 } } }), null);
  for (const relativePath of ['/abs.md', 'C:/abs.md', '../notes.md', 'a//notes.md', 'a/../notes.md', 'a\\notes.md', 'x:ads', 'dir/CON?.md']) assert.equal(parseProjectReadValue('resolveCitation', { ...citation, relativePath }), null);
  assert.equal(parseProjectReadValue('resolveCitation', { ...citation, project: { ...project, directoryName: 'Different' } }), null);
});

test('directory/file discriminants and supported file size remain distinct from rejected candidates', () => {
  assert.ok(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage, entries: [directory] }));
  for (const invalid of [{ ...directory, fileId: 'file_1' }, { ...directory, bytes: 1 }, { ...file, directoryId: 'dir' }, { ...file, readability: 'directory' }, { ...file, bytes: -1 }, { ...file, bytes: 16777217 }, { ...file, relativePath: 'different.md' }]) assert.equal(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage, entries: [invalid] }), null);
  assert.ok(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage, entries: [{ ...file, bytes: 16777217, readability: 'file_limit' }] }));
  assert.equal(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage: { ...coverage, returned: 2 }, entries: [file, file] }), null);
  assert.equal(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage, entries: [] }), null);
});

test('coverage completion never carries a continuation or an unvisited position', () => {
  for (const invalid of [{ ...coverage, nextCursor: 'cursor_1' }, { ...coverage, limitReason: 'page' }, { ...coverage, remaining: { ...coverage.remaining, files: 1 } }, { ...coverage, remaining: { ...coverage.remaining, position: { line: 3, column: 1 } } }]) assert.equal(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage: invalid, entries: [file] }), null);
  const partial = { ...coverage, complete: false, remaining: { directories: null, files: null, position: null }, nextCursor: null, limitReason: 'context' };
  assert.ok(parseProjectReadValue('browseProject', { snapshotId: 'snapshot_1', coverage: partial, entries: [file] }));
});

test('rule presence and scalar chunk byte lengths cannot contradict their declared state', () => {
  const loaded = { source: 'AGENTS.md', relativeDirectory: '', state: 'loaded', version: hash, normalizedSha256: hash, text: '规则😀' };
  const absent = { source: 'docs/AGENTS.md', relativeDirectory: 'docs', state: 'absent', version: null, normalizedSha256: null, text: null };
  assert.ok(parseProjectReadEvent(event('project.rules', { rules: [loaded, absent] })));
  for (const rule of [{ ...loaded, version: null }, { ...absent, text: '' }, { ...loaded, source: 'docs/AGENTS.md' }, { ...loaded, text: 'x'.repeat(8193) }, { ...loaded, text: 'bad\u0000' }]) badEvent('project.rules', { rules: [rule] });
  badEvent('project.rules', { rules: [loaded, loaded] });
  const many = Array.from({ length: 17 }, (_, i) => ({ ...absent, source: 'dir' + i + '/AGENTS.md', relativeDirectory: 'dir' + i }));
  badEvent('project.rules', { rules: many });
  const aggregate = [0, 1, 2].map(i => ({ ...loaded, source: 'd' + i + '/AGENTS.md', relativeDirectory: 'd' + i, text: 'x'.repeat(6000) }));
  badEvent('project.rules', { rules: aggregate });
  const chunk = { ruleId: 'rule_1', source: 'AGENTS.md', relativeDirectory: '', version: hash, normalizedSha256: hash, offsetBytes: 0, endBytes: 4, totalBytes: 4, text: '😀', complete: true };
  const result = { ok: true, value: { kind: 'read', phase: 'rules', snapshotId: 'snapshot_1', coverage: { ...coverage, complete: false, returned: 0, nextCursor: 'cursor_1', limitReason: 'rules' }, rules: [chunk], resume: null, citation: null, empty: false, next: { line: 1, column: 1 } } };
  assert.ok(parseProjectReadToolResult(result));
  for (const invalid of [{ ...chunk, endBytes: 2 }, { ...chunk, complete: false }, { ...chunk, text: '\ud800' }, { ...chunk, offsetBytes: -1 }, { ...chunk, text: 'x'.repeat(4097), endBytes: 4097, totalBytes: 4097 }]) assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, rules: [invalid] } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, citation: preview } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, empty: true } }), null);
});

test('search matches must agree with their citation identity and lie inside its scalar range', () => {
  const searchPreview = { ...preview, source: 'search', excerpt: 'a😀targetz', range: { start: { line: 7, column: 1 }, end: { line: 7, column: 10 } } };
  const match = { fileId: 'file_1', relativePath: 'notes.md', version: hash, match: { start: { line: 7, column: 3 }, end: { line: 7, column: 9 } }, citation: searchPreview };
  const result = { ok: true, value: { kind: 'search', phase: 'data', snapshotId: 'snapshot_1', coverage, rules: [], resume: null, matches: [match] } };
  assert.ok(parseProjectReadToolResult(result));
  const call = { sessionId: 'session_1', messageId: 'message_1', callId: 'call_search', toolName: 'project_search', arguments: { directoryId: null, cursor: null, refresh: false, query: 'target' }, result };
  assert.ok(parseProjectReadEvent(event('tool.completed', call)));
  badEvent('tool.completed', { ...call, arguments: { ...call.arguments, query: 'wrong' } });
  for (const invalid of [{ ...match, fileId: 'other' }, { ...match, version: 'b'.repeat(64) }, { ...match, relativePath: 'other.md' }, { ...match, match: { start: { line: 7, column: 3 }, end: { line: 7, column: 11 } } }, { ...match, citation: { ...searchPreview, source: 'read' } }]) assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, matches: [invalid] } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, phase: 'scan' } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, matches: [match, match], coverage: { ...coverage, returned: 2 } } }), null);
});

test('tool arguments and completion events bind tool name, file version, start position and deterministic sum', () => {
  assert.ok(parseProjectReadToolResult(listResult)); assert.ok(parseProjectReadToolResult(readResult));
  assert.ok(parseProjectReadEvent(event('tool.completed', readCall)));
  badEvent('tool.completed', { ...readCall, toolName: 'project_search' });
  badEvent('tool.completed', { ...readCall, arguments: { ...readCall.arguments, fileId: 'different' } });
  badEvent('tool.completed', { ...readCall, arguments: { ...readCall.arguments, start: { line: 3, column: 5 } } });
  badEvent('tool.completed', { ...readCall, result: listResult });
  const args = { values: [-1000000, 1000000, 7] };
  const sum = { ok: true, value: { kind: 'sum', sum: 7, count: 3, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' } };
  const call = { ...readCall, toolName: 'pilot_sum', arguments: args, result: sum };
  assert.ok(parseProjectReadEvent(event('tool.completed', call)));
  badEvent('tool.completed', { ...call, result: { ...sum, value: { ...sum.value, sum: 8 } } });
  badEvent('tool.completed', { ...call, result: { ...sum, value: { ...sum.value, count: 2 } } });
  for (const values of [[], Array(33).fill(1), [1000001], [NaN], [Infinity], [-0], [1.5], ['1']]) assert.equal(parseProjectReadToolArguments('pilot_sum', { values }), null);
  assert.ok(parseProjectReadToolArguments('pilot_sum', { values: Array(32).fill(1000000) }));
  for (const tool of ['project_list', 'project_find', 'project_search'] as const) {
    const base = { directoryId: null, cursor: null, refresh: true, ...(tool !== 'project_list' ? { query: 'target' } : {}) };
    assert.ok(parseProjectReadToolArguments(tool, base));
    assert.ok(parseProjectReadToolArguments(tool, { ...base, cursor: 'cursor_1' }));
    assert.ok(parseProjectReadToolArguments(tool, { ...base, directoryId: 'dir_1' }));
    assert.equal(parseProjectReadToolArguments(tool, { ...base, path: 'notes.md' }), null);
  }
  assert.ok(parseProjectReadToolArguments('project_read', { ...readCall.arguments, version: null, cursor: 'cursor_1' }));
  assert.equal(parseProjectReadToolArguments('project_read', { ...readCall.arguments, version: 'unverified', cursor: 'cursor_1' }), null);
  assert.equal(parseProjectReadToolArguments('project_search', { directoryId: null, cursor: null, refresh: false, query: 'a\nb' }), null);
  assert.ok(parseProjectReadToolArguments('project_search', { directoryId: null, cursor: null, refresh: false, query: '😀'.repeat(64) }));
  assert.ok(parseProjectReadToolArguments('project_search', { directoryId: null, cursor: null, refresh: false, query: '  \t' }));
  assert.equal(parseProjectReadToolArguments('project_search', { directoryId: null, cursor: null, refresh: false, query: '😀'.repeat(65) }), null);
  assert.equal(parseProjectReadToolArguments('shell' as C.ProjectReadToolName, {}), null);
});

test('resume points are logical positions with query/tool agreement and no old authority fields', () => {
  const next = { line: 4, column: 2 };
  const resume = { toolName: 'project_read', relativePath: 'notes.md', version: hash, next, query: null, relativeDirectory: '' };
  const result = { ok: true, value: { kind: 'read', phase: 'data', snapshotId: 'snapshot_1', coverage: { ...coverage, complete: false, nextCursor: 'cursor_new', limitReason: 'page', remaining: { directories: 0, files: 1, position: next } }, rules: [], resume, citation: preview, empty: false, next } };
  assert.ok(parseProjectReadToolResult(result));
  for (const invalid of [{ ...resume, fileId: 'old_file' }, { ...resume, cursor: 'old_cursor' }, { ...resume, query: 'search' }, { ...resume, toolName: 'project_search' }, { ...resume, relativePath: 'other.md' }, { ...resume, relativeDirectory: 'outside' }, { ...resume, next: { line: 5, column: 1 } }]) assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, resume: invalid } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, empty: true } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, coverage } }), null);
  assert.equal(parseProjectReadToolResult({ ...result, value: { ...result.value, citation: null, resume: null } }), null);
});

test('all event variants parse their exact discriminated data and reject cross-variant fields', () => {
  const sample: { [K in keyof C.ProjectReadEventData]: C.ProjectReadEventData[K] } = {
    'work.prepared':{workCycle:{workspaceId:'workspace_1'},continuedFrom:null},
    'run.accepted': accepted.data, 'run.started': started.data, 'model.step': { step: 1 }, 'model.response': { request: 1, responseModel: null, usage: { inputTokens: 0, outputTokens: 0 } },
    'message.delta': { messageId: 'message_1', step: 1, text: '已核对合成资料。' }, 'project.rules': { rules: [] }, 'tool.started': { sessionId: 'session_1', messageId: 'message_1', callId: 'call_1', toolName: 'pilot_sum', arguments: { values: [1] } },
    'tool.completed': readCall, 'question.asked': { questionId: 'question_1', prompt: '查哪一节？' }, 'question.answered': { questionId: 'question_1', answer: '第二节。' }, 'question.delivered': { questionId: 'question_1' },
    'budget.updated': accounting, 'cleanup.started': { reason: 'completed' }, 'cleanup.completed': { outcome: 'confirmed' }, 'run.completed': { citations: ['citation_1'] },
    'run.failed': { code: 'SOURCE_CHANGED', stage: 'tool' }, 'run.stopped': { reason: 'user' }, 'run.interrupted': { reason: 'restart' },
  };
  for (const type of Object.keys(sample) as (keyof C.ProjectReadEventData)[]) {
    assert.ok(parseProjectReadEvent(event(type, sample[type], type === 'run.accepted' ? 1 : 3)), type);
    assert.equal(parseProjectReadEvent(event(type, { ...sample[type], unexpected: true }, type === 'run.accepted' ? 1 : 3)), null, type);
  }
  assert.equal(parseProjectReadEvent({ ...started, type: 'run.future' }), null);
  assert.equal(parseProjectReadEvent({ ...started, sequence: 1 }), null);
  assert.equal(parseProjectReadEvent({ ...accepted, sequence: 2 }), null);
  assert.equal(parseProjectReadEvent({ ...started, time: '2026-02-30T12:00:00.000Z' }), null);
  assert.equal(parseProjectReadEvent({ ...started, time: '2026-09-11T20:00:00+08:00' }), null);
  badEvent('question.delivered', { questionId: 'question_1', answer: 'extra' });
});

test('history pages enforce count, sequence, run identity, continuation and terminal suffix coherence', () => {
  const page = values.readRun;
  for (const invalid of [{ ...page, nextAfter: 1 }, { ...page, hasMore: true }, { ...page, events: [started, accepted] }, { ...page, events: [{ ...accepted, runId: 'other' }, started] }, { ...page, run: { ...summary, continuedFrom: 'parent', continuation: { fromRunId: 'other', evidenceCount: 1, confirmedQuestions: 0, resumedFilePositions: 0, restartedQueries: 0 } } }, { ...page, run: { ...summary, status: 'completed', cleanupState: 'pending' } }]) assert.equal(parseProjectReadValue('readRun', invalid), null);
  const events = Array.from({ length: 64 }, (_, i) => event('model.step', { step: 1 }, i + 2));
  assert.ok(parseProjectReadResult('readRun', { ok: true, value: { run: { ...summary, eventCount: 65 }, events, nextAfter: 65, hasMore: false } }));
  assert.equal(parseProjectReadValue('readRun', { run: { ...summary, eventCount: 66 }, events: [...events, event('model.step', { step: 1 }, 66)], nextAfter: 66, hasMore: false }), null);
  assert.ok(parseProjectReadValue('readRun', { run: { ...summary, status: 'stopped', eventCount: 5 }, events: [event('run.stopped', { reason: 'user' }, 4), event('cleanup.completed', { outcome: 'confirmed' }, 5)], nextAfter: 5, hasMore: false }));
  assert.equal(parseProjectReadValue('readRun', { run: { ...summary, status: 'stopped', eventCount: 5 }, events: [event('run.stopped', { reason: 'user' }, 4), event('message.delta', { messageId: 'message_1', step: 1, text: 'late' }, 5)], nextAfter: 5, hasMore: false }), null);
  const runs = Array.from({ length: 32 }, (_, i) => ({ ...summary, runId: 'run_' + i, clientRequestId: 'client_' + i }));
  assert.ok(parseProjectReadValue('listRuns', { runs, nextBefore: null }));
  assert.equal(parseProjectReadValue('listRuns', { runs: [...runs, { ...summary, runId: 'run_33', clientRequestId: 'client_33' }], nextBefore: null }), null);
  assert.equal(parseProjectReadValue('listRuns', { runs: [summary, summary], nextBefore: null }), null);
});

test('deletion dependency failures are exact, unique and exclusive to deletion', () => {
  const result = { ok: false, error: { code: 'RUN_HAS_DEPENDENTS', dependentRunIds: Array.from({ length: 31 }, (_, i) => 'child_' + i) } };
  assert.ok(parseProjectReadResult('deleteRun', result));
  assert.equal(parseProjectReadResult('stopRun', result), null);
  for (const invalid of [{ ok: false, error: { code: 'RUN_HAS_DEPENDENTS' } }, { ...result, error: { ...result.error, dependentRunIds: [] } }, { ...result, error: { ...result.error, dependentRunIds: ['child', 'child'] } }, { ...result, error: { ...result.error, dependentRunIds: Array.from({ length: 32 }, (_, i) => 'child_' + i) } }, { ...result, error: { ...result.error, code: 'CONFLICT' } }]) assert.equal(parseProjectReadResult('deleteRun', invalid), null);
  assert.equal(parseProjectReadRequest('deleteRun', { ...requests.deleteRun, expectedEventCount: 1025 }), null);
  assert.equal(parseProjectReadValue('deleteRun', { deleted: false }), null);
});

test('status availability and citation inspection cannot report incompatible success facts', () => {
  for (const invalid of [{ ...status, project: null }, { ...status, model: null }, { ...status, availability: 'not_bound' }, { ...status, cleanupState: 'pending' }, { ...status, reason: 'ROOT_CHANGED' }, { ...status, activeTask: { mode: 'project_read', runId: 'run_1', project, status: 'running', cleanupState: 'idle' } }]) assert.equal(parseProjectReadValue('getStatus', invalid), null);
  assert.ok(parseProjectReadValue('getStatus', { ...status, canStart: false, availability: 'busy', reason: 'BUSY', activeTask: { mode: 'calculation', runId: 'pilot_1', project: null, status: 'running', cleanupState: 'idle' } }));
  assert.equal(parseProjectReadValue('getStatus', { ...status, canStart: false, activeTask: { mode: 'calculation', runId: 'pilot_1', project, status: 'running', cleanupState: 'idle' } }), null);
  assert.equal(parseProjectReadValue('checkCitation', { citationId: 'citation_1', state: 'current', reason: 'SOURCE_CHANGED' }), null);
  assert.equal(parseProjectReadValue('checkCitation', { citationId: 'citation_1', state: 'changed', reason: null }), null);
  assert.ok(parseProjectReadValue('checkCitation', { citationId: 'citation_1', state: 'unavailable', reason: 'FILE_UNAVAILABLE' }));
});

test('JSON byte accounting includes escapes, property names and whole envelopes, with safe structural rejection', () => {
  for (const value of [null, true, 42, 0.25, '甲😀\n"\\', { 中文: ['x', '\t', '\u0000'], a: { value: 1 } }, { a: { x: 1 }, b: { x: 1 } }]) {
    const expected = Buffer.byteLength(JSON.stringify(value), 'utf8');
    assert.equal(projectReadJsonBytes(value), expected); assert.equal(projectReadFitsJsonBudget(value, expected), true); assert.equal(projectReadFitsJsonBudget(value, expected - 1), false);
  }
  const shared = { x: 1 }; assert.equal(projectReadJsonBytes({ a: shared, b: shared }), 25);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const value of [cycle, undefined, NaN, Infinity, -0, 1n, Symbol('x'), () => 1, '\ud800', { x: undefined }, new Map(), new Uint8Array([1])]) assert.equal(projectReadJsonBytes(value), null);
  for (const limit of [-1, 0.5, NaN, Infinity, 67108865]) assert.equal(projectReadFitsJsonBudget({}, limit), false);
  const base = event('message.delta', { messageId: 'message_1', step: 1, text: '' }) as { data: { messageId: string; step: number; text: string } };
  const exactText = 'x'.repeat(32768 - Buffer.byteLength(JSON.stringify(base)));
  const atLimit = { ...base, data: { ...base.data, text: exactText } };
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit)), 32768); assert.ok(parseProjectReadEvent(atLimit));
  assert.equal(parseProjectReadEvent({ ...atLimit, data: { ...atLimit.data, text: exactText + 'x' } }), null);
  const escaped = { ...base, data: { ...base.data, text: '\\'.repeat(16384) } };
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) > 32768); assert.equal(parseProjectReadEvent(escaped), null);
  const inflatedRequest = { ...requests.startRun, goal: '\\'.repeat(4096), constraint: '\\'.repeat(4096) };
  assert.ok(Buffer.byteLength(JSON.stringify(inflatedRequest)) > 16384); assert.equal(parseProjectReadRequest('startRun', inflatedRequest), null);
});

test('tool and history page envelopes respect their independent complete byte budgets', () => {
  const bigPreview = { ...preview, excerpt: '\\'.repeat(6000), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6001 } }, totalLines: 1, fileBytes: 10000 };
  const tooBig = { ok: true, value: { kind: 'read', phase: 'data', snapshotId: 'snapshot_1', coverage, rules: [], resume: null, citation: bigPreview, empty: false, next: null } };
  assert.ok(Buffer.byteLength(JSON.stringify(tooBig)) > 12288); assert.equal(parseProjectReadToolResult(tooBig), null);
  const smallPreview = { ...bigPreview, excerpt: '\\'.repeat(5000), range: { start: { line: 1, column: 1 }, end: { line: 1, column: 5001 } } };
  assert.ok(parseProjectReadToolResult({ ...tooBig, value: { ...tooBig.value, citation: smallPreview } }));
  const events = Array.from({ length: 9 }, (_, i) => event('message.delta', { messageId: 'message_' + i, step: 1, text: 'x'.repeat(30000) }, i + 2));
  for (const item of events) assert.ok(parseProjectReadEvent(item));
  const result = { ok: true, value: { run: { ...summary, eventCount: 10 }, events, nextAfter: 10, hasMore: false } };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 262144); assert.equal(parseProjectReadResult('readRun', result), null);
  assert.ok(parseProjectReadResult('readRun', { ...result, value: { ...result.value, events: events.slice(0, 8), nextAfter: 9, hasMore: true } }));
});
