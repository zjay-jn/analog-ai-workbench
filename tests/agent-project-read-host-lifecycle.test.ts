import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore, type ProjectReadDisk, type ProjectReadStore } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadMethod, type ProjectReadRequests, type ProjectReadRun } from '../apps/desktop/src/shared/agent/agent-project-read';

const PRODUCT = path.resolve('C:/work/analog_ai_workbench');
const FIXTURES = path.join(PRODUCT, '.local', 'agent-project-read-tests');
const MODEL = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const good = <T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>): T => result.ok ? result.value : assert.fail(JSON.stringify(result));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Real disk transactions and run arbitration; only the model engine is synthetic. */
function fixture(scenario: (input: ProjectReadEngineInput) => Promise<void>, delayedStop = false) {
  const base = path.join(FIXTURES, randomUUID()), source = path.join(base, 'source');
  console.log('lifecycle fixture: ' + base);
  fs.mkdirSync(source, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), source);
  const diskStore = createProjectReadStore(PRODUCT, path.join(base, 'agent-project-read'));
  const arbiter = createAgentRuntimeArbiter(), stopEntered = gate(), stopRelease = gate();
  if (!delayedStop) stopRelease.release();
  let saved: ProjectReadDisk = { version: 1, runs: [] }, input: ProjectReadEngineInput | undefined;
  const changed = new Set<() => void>();
  const store: ProjectReadStore = {
    load() { saved = diskStore.load(); return saved; },
    save(next) { diskStore.save(next); saved = diskStore.load(); for (const notify of changed) notify(); },
    close() { diskStore.close(); },
  };
  const models: ProjectReadModelSnapshots = {
    status: () => ({ model: MODEL, canStart: true, reason: null }), freeze: () => MODEL,
    get: () => ({ apiKey: 'sk-synthetic-lifecycle-only', model: MODEL, maxRequests: 24, maxOutputTokens: 16384, requestTimeoutMs: 600000 }),
    forget() {}, close() {},
  };
  const engine: ProjectReadEngine = {
    status: () => ({ model: MODEL, canStart: true, processState: 'ready', reason: null }),
    health: async () => true, accept: () => MODEL, canDeliver: () => true,
    accounting: () => ({ providerAttempts: input ? 1 : 0, httpDispatches: input ? 1 : 0, contextBytes: 1000 }),
    async start(value) {
      input = value;
      value.callbacks.notice({ type: 'started', sessionId: 'session-' + value.runId });
      value.callbacks.notice({ type: 'step', step: 1, usage: null });
      value.callbacks.notice({ type: 'response', request: 1, responseModel: 'synthetic-lifecycle', usage: null });
      await scenario(value);
      if (!value.signal.aborted) {
        value.callbacks.notice({ type: 'text', messageId: 'answer-' + value.runId, step: 1, text: 'The synthetic operation has finished.' });
        value.callbacks.notice({ type: 'completed' });
      }
    },
    async stop() { stopEntered.release(); await stopRelease.promise; },
    async answer() { assert.fail('This lifecycle scenario never asks questions'); },
    dispose() {}, shutdown: async () => {},
  };
  const host = createProjectReadHost({ store, models, arbiter, createEngine: () => engine, bindings: { snapshotBinding: () => ({ ok: true, value: { folder: root, name: 'Lifecycle fixture' } }) } });
  const invoke = <M extends ProjectReadMethod>(method: M, request: Omit<ProjectReadRequests[M], 'contractVersion'>) => host.invoke(method, { contractVersion: V, ...request }, () => true);
  const current = (id: string): ProjectReadRun => {
    const run = saved.runs.find(row => row.run.runId === id)?.run; assert.ok(run); return run;
  };
  const settled = (id: string) => within(new Promise<ProjectReadRun>(resolve => {
    const check = () => { const run = current(id); if (['completed', 'failed', 'stopped', 'interrupted'].includes(run.status) && run.cleanupState !== 'pending') { changed.delete(check); resolve(run); } };
    changed.add(check); check();
  }), 'terminal run with completed cleanup');
  return {
    source, root, host, arbiter, invoke, current, settled, stopEntered, stopRelease,
    disk: () => diskStore.load(), input: () => { assert.ok(input); return input; },
    start: () => invoke('startRun', { clientRequestId: randomUUID(), projectId: root.projectId, bindingId: root.bindingId, model: MODEL, goal: 'Verify the private synthetic source.', constraint: 'Only use verified evidence.', continuedFrom: null }),
    async dispose() {
      stopRelease.release(); host.revoke();
      try { await host.shutdown(); } finally {
        try { await arbiter.close(); } finally {
          store.close();
          const resolved = fs.realpathSync.native(base), relative = path.relative(FIXTURES, resolved);
          assert.equal(resolved, base); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
          fs.rmSync(resolved, { recursive: true });
        }
      }
    },
  };
}

test('completion cleanup yields to an explicit stop or window close', { timeout: 20000 }, async t => {
  for (const action of ['stop', 'close'] as const) await t.test(action, async () => {
    const f = fixture(async () => {}, true);
    try {
      const { runId } = good(await f.start());
      await within(f.stopEntered.promise, 'engine completion cleanup to start');
      assert.equal(f.current(runId).status, 'running');
      assert.equal(f.current(runId).cleanupState, 'pending');
      if (action === 'stop') good(await f.invoke('stopRun', { runId })); else f.host.revoke();
      assert.equal(f.input().signal.aborted, true, 'stop/close must revoke immediately while completion cleanup is blocked');
      const expected = action === 'stop' ? 'stopped' : 'interrupted';
      assert.equal(f.current(runId).status, expected);
      assert.equal(f.current(runId).cleanupState, 'pending');
      f.input().callbacks.notice({ type: 'text', messageId: 'late-text', step: 1, text: 'This late text must not be persisted.' });
      f.stopRelease.release();
      const ended = await f.settled(runId);
      assert.equal(ended.status, expected);
      assert.equal(ended.cleanupState, 'idle');
      const terminals = ended.events.filter(e => ['run.completed', 'run.failed', 'run.stopped', 'run.interrupted'].includes(e.type));
      assert.deepEqual(terminals.map(e => e.type), [action === 'stop' ? 'run.stopped' : 'run.interrupted']);
      assert.equal(ended.events.some(e => e.type === 'message.delta' && e.data.messageId === 'late-text'), false);
      assert.equal(ended.events.filter(e => e.type === 'cleanup.started').length, 1);
      assert.equal(ended.events.filter(e => e.type === 'cleanup.completed').length, 1);
      assert.equal(f.disk().runs[0]?.run.status, expected, 'the actual persisted ledger must preserve the winning terminal');
    } finally { await f.dispose(); }
  });
});

test('citation inspection retains its target while the previous directory handle closes', { timeout: 15000 }, async t => {
  const closeEntered = gate(), closeRelease = gate();
  const f = fixture(async input => {
    const call = (toolName: 'project_find' | 'project_read', args: unknown) => input.callbacks.tool({ sessionId: 'session-' + input.runId, messageId: 'source-' + input.runId, callId: randomUUID(), toolName, arguments: args } as Parameters<ProjectReadEngineInput['callbacks']['tool']>[0]);
    const found = good(await call('project_find', { directoryId: null, query: 'proof.txt', cursor: null, refresh: false }));
    assert.equal(found.kind, 'find'); if (found.kind !== 'find') return;
    const entry = found.entries.find(e => e.name === 'proof.txt'); assert.ok(entry?.fileId);
    const read = good(await call('project_read', { fileId: entry.fileId, version: null, start: { line: 1, column: 1 }, cursor: null }));
    assert.equal(read.kind, 'read'); if (read.kind !== 'read') return;
    assert.ok(read.citation); assert.equal(read.citation.excerpt, 'Synthetic retained citation.');
  });
  let checking: ReturnType<typeof f.invoke<'checkCitation'>> | undefined;
  try {
    fs.writeFileSync(path.join(f.source, 'proof.txt'), 'Synthetic retained citation.');
    for (let i = 0; i < 125; i++) fs.writeFileSync(path.join(f.source, 'item-' + i + '.txt'), 'synthetic');
    const { runId } = good(await f.start()), ended = await f.settled(runId);
    assert.equal(ended.status, 'completed');
    const citation = f.disk().runs[0]!.citations[0]!.citation;
    const originalClose = fs.Dir.prototype.close;
    t.mock.method(fs.Dir.prototype, 'close', function (this: fs.Dir, ...args: unknown[]) {
      // Node's promise overload re-enters close(callback); preserve that callback.
      if (path.resolve(this.path) !== f.source || args.length) return Reflect.apply(originalClose, this, args);
      closeEntered.release(); return closeRelease.promise.then(() => Reflect.apply(originalClose, this, args));
    });
    const page = good(await f.invoke('browseProject', { projectId: f.root.projectId, bindingId: f.root.bindingId, directoryId: null, cursor: null, refresh: false }));
    assert.equal(page.coverage.complete, false, 'the old inspection must retain an unfinished real directory handle');
    assert.ok(page.coverage.nextCursor);
    checking = f.invoke('checkCitation', { runId, citationId: citation.citationId });
    await within(closeEntered.promise, 'old directory close to block the inspection handoff');
    const attemptedDelete = await f.invoke('deleteRun', { runId, expectedEventCount: ended.eventCount });
    assert.equal(attemptedDelete.ok, false, 'an admitted citation check must retain its target before waiting for another inspection');
    if (!attemptedDelete.ok) assert.equal(attemptedDelete.error.code, 'BUSY');
    assert.equal(f.disk().runs.some(row => row.run.runId === runId), true);
    closeRelease.release();
    assert.equal(good(await within(checking, 'retained citation check')).state, 'current');
    good(await f.invoke('deleteRun', { runId, expectedEventCount: ended.eventCount }));
    assert.equal(f.disk().runs.length, 0, 'retention must be released after the check finishes');
  } finally {
    closeRelease.release(); if (checking) await within(checking, 'pending inspection teardown').catch(() => {});
    await f.dispose();
  }
});
