import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadToolCall, type ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadRequest, parseProjectReadResult } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { createProjectReadStore, parseProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { WorkCycleError, type WorkCycleWorkspaceFactory } from '../apps/desktop/src/main/agent-work-cycle/types';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { makeTaskDeletion, inspectTaskCapacity, reclaimTaskStorage } from '../apps/desktop/src/main/agent-project-read/capacity';

const product = path.resolve('C:/work/analog_ai_workbench');
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => r.ok ? r.value : assert.fail(JSON.stringify(r));
function fixture() {
  const base = path.join(product, '.local', 'agent-project-read-tests', randomUUID());
  assert.ok(base.startsWith(product + path.sep)); const source = path.join(base, 'source'); fs.mkdirSync(source, { recursive: true });
  return { base, source, root: captureFolderRoot(randomUUID(), randomUUID(), source) };
}
function harness(f: ReturnType<typeof fixture>, action: (input: ProjectReadEngineInput) => Promise<void> = async input => {
  const result = await input.callbacks.tool({ sessionId: 'capacity-session', messageId: 'm1', callId: 'write-' + randomUUID(), toolName: 'work_write', arguments: { relativePath: 'result.txt', expectedVersion: null, text: 'Capacity test private result\n' } });
  assert.equal(result.ok, true);
}, factory: WorkCycleWorkspaceFactory = createWorkCycleWorkspace) {
  const store = createProjectReadStore(product, path.join(f.base, 'agent-project-read')), arbiter = createAgentRuntimeArbiter(); let starts = 0;
  const models: ProjectReadModelSnapshots = { status: () => ({ model, canStart: true, reason: null }), freeze: () => model,
    get: () => ({ apiKey: 'synthetic-only', model, maxRequests: 24, maxOutputTokens: 1000, requestTimeoutMs: 1000 }), forget() {}, close() {} };
  const engine: ProjectReadEngine = { status: () => ({ model, canStart: true, processState: 'ready', reason: null }), health: async () => true,
    accept: () => model, canDeliver: () => true, accounting: () => ({ providerAttempts: 0, httpDispatches: 0, contextBytes: 0 }),
    async start(input) { starts++; input.callbacks.notice({ type: 'started', sessionId: 'capacity-session' }); input.callbacks.notice({ type: 'step', step: 1, usage: null }); await action(input); if (!input.signal.aborted) input.callbacks.notice({ type: 'completed' }); },
    answer: async () => {}, stop: async () => {}, dispose() {}, shutdown: async () => {} };
  const paths = { workspaces: path.join(f.base, 'agent-work-cycle', 'workspaces'), commandRecords: path.join(f.base, 'agent-command', 'runs') };
  const host = createProjectReadHost({ store, arbiter, models, bindings: { snapshotBinding: () => ({ ok: true, value: { folder: f.root, name: 'Synthetic capacity' } }) }, createEngine: () => engine,
    commands: { directory: paths.commandRecords, drivers: [] },
    workCycle: { directory: paths.workspaces, createWorkspace: factory, createRunner: () => ({ available: () => ({ available: true, language: 'javascript', isolation: 'windows-appcontainer' }), run: async () => assert.fail('No native execution authorized in unit tests'), close: async () => {} }) } });
  const request = { contractVersion: V, projectId: f.root.projectId, bindingId: f.root.bindingId, clientRequestId: randomUUID(), model, goal: 'Capacity private test', constraint: '', continuedFrom: null };
  return { host, store, paths, request, starts: () => starts,
    async wait(runId: string) { const deadline = performance.now() + 5000; while (performance.now() < deadline) { const run = store.load().runs.find(r => r.run.runId === runId)!.run; if (['completed','failed'].includes(run.status) && run.cleanupState === 'idle') return run; await new Promise(resolve => setTimeout(resolve, 5)); } return assert.fail('Host completion timed out'); },
    capacity: async () => ok(await host.invoke('getTaskCapacity', { contractVersion: V, projectId: f.root.projectId }, () => true)),
    async close() { host.revoke(); await host.shutdown(); await arbiter.close(); store.close(); },
  };
}

test('capacity strict bridge and explicit version prevent stale deletion; native-free work files reclaimed', async () => {
  const f = fixture(), h = harness(f); try {
    const { runId } = ok(await h.host.invoke('startWorkRun', h.request, () => true)); const run = await h.wait(runId);
    const report = await h.capacity(), row = report.runs[0]!; assert.equal(row.canDelete, true); assert.equal(row.complete, true);
    assert.ok(row.workspaceBytes >= Buffer.byteLength('Capacity test private result\n')); assert.ok(row.taskBytes > 0); assert.equal(row.totalBytes, row.taskBytes + row.workspaceBytes + row.logBytes);
    assert.ok(parseProjectReadResult('getTaskCapacity', { ok: true, value: report }));
    assert.equal(parseProjectReadRequest('deleteRun', { contractVersion: V, runId, expectedEventCount: run.eventCount, expectedCapacityVersion: 'forged' }), null);
    for (const version of [undefined, 'a'.repeat(64)]) assert.equal((await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: run.eventCount, ...(version ? { expectedCapacityVersion: version } : {}) }, () => true)).ok, false);
    const root = path.join(h.paths.workspaces, run.workCycle!.workspaceId); assert.ok(fs.existsSync(root));
    ok(await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true));
    assert.equal(fs.existsSync(root), false); assert.equal(fs.existsSync(path.join(h.paths.commandRecords, runId)), false);
    assert.equal((await h.capacity()).runs.length, 0); assert.equal(h.store.load().runs.length, 0); assert.equal(h.starts(), 1);
  } finally { await h.close(); }
});

test('continued child protects parent files; child then parent can be reclaimed without touching source', async () => {
  const f = fixture(), h = harness(f, async input => { const files = ok(await input.callbacks.tool({ sessionId:'capacity-session',messageId:'m1',callId:randomUUID(),toolName:'work_list',arguments:{} }));
    if (files.kind !== 'work_list') return assert.fail(); if (!files.files.length) ok(await input.callbacks.tool({sessionId:'capacity-session',messageId:'m1',callId:randomUUID(),toolName:'work_write',arguments:{relativePath:'seed.txt',expectedVersion:null,text:'private'}}));
  }); try {
    fs.writeFileSync(path.join(f.source, 'original.txt'), 'unchanged');
    const parent = ok(await h.host.invoke('startWorkRun', h.request, () => true)).runId, p = await h.wait(parent);
    const base = ok(await h.host.invoke('prepareWorkContinuation', { contractVersion: V, projectId: f.root.projectId, bindingId: f.root.bindingId, runId: parent, expectedEventCount: p.eventCount }, () => true));
    const child = ok(await h.host.invoke('startWorkRun', { ...h.request, clientRequestId: randomUUID(), goal: 'Continue private files', continuedFrom: parent, expectedEventCount: p.eventCount, baselineVersion: base.baseline.baselineVersion }, () => true)).runId; await h.wait(child);
    const report = await h.capacity(), row = report.runs.find(r => r.runId === parent)!; assert.equal(row.blockedReason, 'referenced'); assert.deepEqual(row.dependentRunIds, [child]);
    const denied = await h.host.invoke('deleteRun', { contractVersion: V, runId: parent, expectedEventCount: p.eventCount, expectedCapacityVersion: row.capacityVersion }, () => true); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'RUN_HAS_DEPENDENTS');
    for (const runId of [child, parent]) { const entry = (await h.capacity()).runs.find(r => r.runId === runId)!; ok(await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: entry.expectedEventCount, expectedCapacityVersion: entry.capacityVersion }, () => true)); }
    assert.equal(fs.readFileSync(path.join(f.source, 'original.txt'), 'utf8'), 'unchanged');
  } finally { await h.close(); }
});

test('failure after first unlink keeps durable inventory and surviving bytes; reopen never deletes until explicit retry', async () => {
  const f = fixture(), h = harness(f); let runId = '', root = '', before = 0;
  try {
    runId = ok(await h.host.invoke('startWorkRun', h.request, () => true)).runId; const run = await h.wait(runId); root = path.join(h.paths.workspaces, run.workCycle!.workspaceId);
    const row = (await h.capacity()).runs[0]!; before = row.totalBytes;
    const original = fs.unlinkSync, calls: string[] = [];
    fs.unlinkSync = ((target: fs.PathLike) => { if (String(target).startsWith(root + path.sep)) { calls.push(String(target)); if (calls.length === 2) throw Object.assign(Error('Synthetic reclaim failure'), { code: 'EACCES' }); } original(target); }) as typeof fs.unlinkSync;
    try { const denied = await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true); assert.equal(denied.ok, false); assert.equal(calls.length, 2); }
    finally { fs.unlinkSync = original; }
    const journal = h.store.load().deletions?.[0]; assert.equal(journal?.state, 'failed'); assert.equal(h.store.load().runs.length, 1);
    assert.ok(Object.isFrozen(journal)); assert.ok(Object.isFrozen(journal.targets)); assert.ok(Object.isFrozen(journal.targets[0]?.entries[0]));
    const pending = (await h.capacity()).runs[0]!; assert.equal(pending.deletionState, 'failed'); assert.equal(pending.canDelete, true);
    assert.equal((await h.host.invoke('listWorkFiles', { contractVersion: V, runId }, () => true)).ok, false);
  } finally { await h.close(); }
  const reopened = harness(f, async () => assert.fail('No replay')); try {
    const bytesBefore = fs.readFileSync(path.join(f.base, 'agent-project-read', 'runs.json')); const row = (await reopened.capacity()).runs[0]!;
    assert.equal(row.deletionState, 'failed'); assert.equal(row.canDelete, true); assert.equal(fs.existsSync(root), true); assert.ok(row.taskBytes > 0); assert.ok(before > 0);
    assert.deepEqual(fs.readFileSync(path.join(f.base, 'agent-project-read', 'runs.json')), bytesBefore); assert.equal(reopened.starts(), 0);
    ok(await reopened.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true)); assert.equal(fs.existsSync(root), false);
  } finally { await reopened.close(); }
});

test('unconfirmed owned write may be deleted after clean stop; replacement, foreign lock and omitted target fail closed', async () => {
  const f = fixture(), h = harness(f, async input => { await assert.rejects(input.callbacks.tool({sessionId:'capacity-session',messageId:'m',callId:randomUUID(),toolName:'work_write',arguments:{relativePath:'unconfirmed.txt',expectedVersion:null,text:'not adopted'}})); }, async options => {
    const workspace = await createWorkCycleWorkspace(options); return { ...workspace, confirm: async () => { throw new WorkCycleError('STORAGE_FAILED'); } };
  }); try {
    const runId = ok(await h.host.invoke('startWorkRun', h.request, () => true)).runId; const run = await h.wait(runId), stored = h.store.load().runs[0]!, root = path.join(h.paths.workspaces, run.workCycle!.workspaceId);
    const clean = inspectTaskCapacity(stored, h.paths, false, []); assert.equal(clean.entry.canDelete, true);
    const deletion = makeTaskDeletion(stored, clean.targets), missing = { ...deletion, targets: deletion.targets.filter(t => t.kind !== 'command_records') };
    assert.equal(inspectTaskCapacity(stored, h.paths, false, [], missing).entry.canDelete, false);
    const changed = path.join(root, 'replacement.txt'); fs.writeFileSync(changed, 'new, not in inventory');
    assert.throws(() => reclaimTaskStorage(h.paths, deletion), /CONFLICT/u); assert.ok(fs.existsSync(path.join(root, 'workspace.json')));
    fs.unlinkSync(changed); fs.writeFileSync(path.join(root, 'writer.lock'), JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    assert.equal((await h.capacity()).runs[0]!.canDelete, false); fs.unlinkSync(path.join(root, 'writer.lock'));
    const row = (await h.capacity()).runs[0]!; assert.equal(row.canDelete, true);
    ok(await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true));
    assert.equal(fs.existsSync(root), false);
  } finally { await h.close(); }
});

test('final ledger commit failure leaves pending plan recoverable after reopen with no automatic deletion', async () => {
  const f = fixture(), h = harness(f); let runId = '';
  try {
    runId = ok(await h.host.invoke('startWorkRun', h.request, () => true)).runId; await h.wait(runId); const row = (await h.capacity()).runs[0]!;
    const rename = fs.renameSync; let commits = 0;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { if (String(to) === path.join(f.base, 'agent-project-read', 'runs.json') && ++commits === 2) throw Object.assign(Error('Synthetic final ledger commit failed'), { code: 'EACCES' }); rename(from, to); }) as typeof fs.renameSync;
    try { const result = await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true); assert.equal(result.ok, false); assert.equal(commits, 2); }
    finally { fs.renameSync = rename; }
    const disk = JSON.parse(fs.readFileSync(path.join(f.base, 'agent-project-read', 'runs.json'), 'utf8')); assert.equal(disk.deletions[0].state, 'pending'); assert.equal(disk.runs.length, 1);
  } finally { await h.close(); }
  const reopened = harness(f, async () => assert.fail('No replay'));
  try { const before = fs.readFileSync(path.join(f.base, 'agent-project-read', 'runs.json')); const row = (await reopened.capacity()).runs[0]!;
    assert.equal(row.deletionState, 'pending'); assert.equal(row.canDelete, true); assert.equal(row.workspaceBytes, 0); assert.deepEqual(fs.readFileSync(path.join(f.base, 'agent-project-read', 'runs.json')), before);
    ok(await reopened.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true)); assert.equal(reopened.store.load().runs.length, 0);
  } finally { await reopened.close(); }
});

test('active task remains protected while a model action holds its lease', async () => {
  let release: () => void = () => {}; const f = fixture(), h = harness(f, async () => new Promise<void>(resolve => { release = resolve; }));
  try { const runId = ok(await h.host.invoke('startWorkRun', h.request, () => true)).runId; await new Promise(resolve => setTimeout(resolve, 15));
    const row = (await h.capacity()).runs[0]!; assert.equal(row.canDelete, false); assert.equal(row.blockedReason, 'active');
    const denied = await h.host.invoke('deleteRun', { contractVersion: V, runId, expectedEventCount: row.expectedEventCount, expectedCapacityVersion: row.capacityVersion }, () => true); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'BUSY');
    release(); await h.wait(runId);
  } finally { release(); await h.close(); }
});
