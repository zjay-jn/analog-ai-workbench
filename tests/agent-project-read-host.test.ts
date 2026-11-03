import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { parseProjectReadDisk, type ProjectReadDisk, type ProjectReadStore } from '../apps/desktop/src/main/agent-project-read/store';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadMethod, type ProjectReadRequests, type ProjectReadResult, type ProjectReadValues, type ProjectReadToolName, type ProjectReadToolArguments, type ProjectReadToolCall } from '../apps/desktop/src/shared/agent/agent-project-read';

const fixtureParent = path.resolve('C:/work/analog_ai_workbench/.local/agent-project-read-tests');
const MODEL = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const good = <T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>): T => { if (!result.ok) return assert.fail(JSON.stringify(result)); return result.value; };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 5));
function fixture(scenario: (input: ProjectReadEngineInput, ordinal: number) => Promise<void>, initial: ProjectReadDisk = { version: 1, runs: [] }) {
  const base = path.join(fixtureParent, randomUUID()), directory = path.join(base, 'source'); fs.mkdirSync(directory, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), directory), arbiter = createAgentRuntimeArbiter(); let saved = initial, nativeStarts = 0, nativeConstructors = 0, keyReads = 0;
  const snapshots = new Set<string>(), captured: ProjectReadEngineInput[] = [];
  const models: ProjectReadModelSnapshots = { status: () => ({ model: MODEL, canStart: true, reason: null }), freeze: id => { if (!snapshots.has(id)) { keyReads++; snapshots.add(id); } return MODEL; }, get: () => ({ apiKey: 'sk-synthetic-fixture', model: MODEL, maxRequests: 24, maxOutputTokens: 16384, requestTimeoutMs: 600000 }), forget: id => { snapshots.delete(id); }, close: () => { snapshots.clear(); } };
  const store: ProjectReadStore = { load: () => saved, save: value => { const parsed = parseProjectReadDisk(value); assert.ok(parsed, 'actual store schema rejected host transaction'); saved = parsed; }, close: () => {} };
  let active: ProjectReadEngineInput | undefined;
  let answerRelease: (() => void) | undefined;
  let answerAck: Promise<void> = Promise.resolve();
  const createEngine = (): ProjectReadEngine => {
    nativeConstructors++;
    return {
      status: () => ({ model: MODEL, canStart: true, processState: 'ready', reason: null }), health: async () => true, accept: models.freeze,
      canDeliver: () => true, accounting: id => ({ providerAttempts: captured.some(input => input.runId === id) ? 1 : 0, httpDispatches: captured.some(input => input.runId === id) ? 1 : 0, contextBytes: 1000 }),
      async start(input) {
        nativeStarts++; captured.push(input); active = input;
        input.callbacks.notice({ type: 'started', sessionId: 'session-' + input.runId }); input.callbacks.notice({ type: 'step', step: 1, usage: null }); input.callbacks.notice({ type: 'response', request: 1, responseModel: 'synthetic-provider', usage: null });
        await scenario(input, nativeStarts);
        if (!input.signal.aborted) { input.callbacks.notice({ type: 'text', messageId: 'final-' + input.runId, step: 1, text: 'Synthetic execution ended.' }); input.callbacks.notice({ type: 'completed' }); }
      },
      async answer(_run, questionId) { await answerAck; await active!.callbacks.questionDelivered(questionId); answerRelease?.(); },
      stop: async () => {}, dispose() {}, shutdown: async () => {},
    };
  };
  const bindings = { snapshotBinding: () => ({ ok: true as const, value: { folder: root, name: 'Synthetic project' } }) };
  const host = createProjectReadHost({ store, models, bindings, arbiter, createEngine });
  const invoke = <M extends ProjectReadMethod>(method: M, request: Omit<ProjectReadRequests[M], 'contractVersion'>) => host.invoke(method, { contractVersion: V, ...request }, () => true);
  const start = (continuedFrom: string | null = null) => invoke('startRun', { projectId: root.projectId, bindingId: root.bindingId, clientRequestId: randomUUID(), model: MODEL, goal: 'Read the later synthetic target.', constraint: 'Use actual verified fragments.', continuedFrom });
  return { base, directory, root, host, arbiter, store, models, bindings, createEngine, invoke, start, captured,
    saved: () => saved, counters: () => ({ nativeStarts, nativeConstructors, keyReads }),
    questionGate(ack: Promise<void>, release: () => void) { answerAck = ack; answerRelease = release; },
    async wait(runId: string, terminal = true) {
      for (let i = 0; i < 500; i++) { const run = saved.runs.find(row => row.run.runId === runId)?.run; if (run && (!terminal || ['completed', 'failed', 'stopped', 'interrupted'].includes(run.status) && run.cleanupState !== 'pending')) return run; await pause(); }
      return assert.fail('host did not reach expected state: ' + JSON.stringify(saved.runs.map(row => ({ status: row.run.status, cleanup: row.run.cleanupState, last: row.run.events.at(-1) }))));
    },
    async dispose() { host.revoke(); await host.shutdown().catch(() => {}); await arbiter.close().catch(() => {}); const resolved = fs.realpathSync.native(base), relative = path.relative(fixtureParent, resolved); assert.equal(resolved, base); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(resolved, { recursive: true }); },
  };
}
const tool = async <N extends ProjectReadToolName>(input: ProjectReadEngineInput, toolName: N, args: ProjectReadToolArguments[N]) => good(await input.callbacks.tool({ sessionId: 'session-' + input.runId, messageId: 'message-' + input.runId, callId: randomUUID(), toolName, arguments: args } as ProjectReadToolCall));
const stopped = (input: ProjectReadEngineInput) => new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); });

test('project host status/history have no source I/O and preparation failure is accepted then recorded before native start', async () => {
  const f = fixture(async () => assert.fail('native must not start'));
  try {
    const moved = path.join(f.base, 'temporarily-missing'); fs.renameSync(f.directory, moved);
    const status = good(await f.invoke('getStatus', { projectId: f.root.projectId })); assert.equal(status.availability, 'unchecked'); assert.equal(status.canStart, true); assert.deepEqual(f.counters(), { nativeStarts: 0, nativeConstructors: 0, keyReads: 0 });
    const accepted = good(await f.start()), run = await f.wait(accepted.runId); assert.equal(run.status, 'failed'); assert.equal(run.events[0]?.type, 'run.accepted'); assert.equal(f.counters().nativeStarts, 0);
    assert.ok(run.events.some(event => event.type === 'run.failed' && event.data.code === 'ROOT_UNAVAILABLE'));
    fs.renameSync(moved, f.directory); const recovered = good(await f.invoke('revalidateProject', { projectId: f.root.projectId, bindingId: f.root.bindingId })); assert.equal(recovered.canStart, true); assert.equal(recovered.availability, 'available');
  } finally { await f.dispose(); }
});

test('project host stops after a real fragment, starts a new run at line 201, reissues citations and enforces deletion dependencies', async () => {
  let firstReady!: () => void; const readReady = new Promise<void>(resolve => { firstReady = resolve; }); let resumedExcerpt = '';
  const f = fixture(async (input, ordinal) => {
    if (ordinal === 1) {
      const found = await tool(input, 'project_find', { directoryId: null, query: 'data.txt', cursor: null, refresh: false }); if (found.kind !== 'find') return assert.fail('find');
      const read = await tool(input, 'project_read', { fileId: found.entries[0]!.fileId!, version: null, cursor: null, start: { line: 1, column: 1 } }); if (read.kind !== 'read' || !read.citation) return assert.fail('read');
      input.callbacks.notice({ type: 'text', messageId: 'source-message', step: 1, text: 'Confirmed [资料:' + read.citation.citationId + ']' }); firstReady(); await stopped(input);
    } else {
      const position = input.prompt.initialUserText.indexOf('{"priorRunId"'); assert.ok(position >= 0); const context = JSON.parse(input.prompt.initialUserText.slice(position));
      assert.equal(context.resumedOperations.length, 1); assert.equal(context.restartRequired.length, 0); assert.equal(context.resumedOperations[0].arguments.start.line, 201);
      assert.equal(Object.hasOwn(context.citations[0], 'project'), false); assert.equal(Object.hasOwn(context.citations[0], 'fileIdentity'), false);
      const read = await tool(input, 'project_read', context.resumedOperations[0].arguments); if (read.kind !== 'read' || !read.citation) return assert.fail('resumed read'); resumedExcerpt = read.citation.excerpt;
    }
  });
  try {
    fs.writeFileSync(path.join(f.directory, 'data.txt'), Array.from({ length: 600 }, (_, i) => i === 349 ? 'later-target-271828' : 'synthetic line ' + (i + 1)).join('\n'));
    const first = good(await f.start()); await readReady; good(await f.invoke('stopRun', { runId: first.runId })); const old = await f.wait(first.runId); assert.equal(old.status, 'stopped'); assert.equal(old.cleanupState, 'idle');
    const oldEvidence = f.saved().runs.find(row => row.run.runId === first.runId)!.citations[0]!.citation;
    const second = good(await f.start(first.runId)), resumed = await f.wait(second.runId); assert.equal(resumed.status, 'completed'); assert.ok(resumedExcerpt.includes('later-target-271828'));
    const savedNew = f.saved().runs.find(row => row.run.runId === second.runId)!; assert.equal(savedNew.run.continuation?.resumedFilePositions, 1); assert.equal(savedNew.run.continuation?.restartedQueries, 0);
    const inherited = savedNew.citations.find(row => row.citation.origin)!.citation; assert.notEqual(inherited.citationId, oldEvidence.citationId); assert.notEqual(inherited.fileId, oldEvidence.fileId); assert.deepEqual(inherited.origin, { runId: first.runId, citationId: oldEvidence.citationId });
    const hidden = path.join(f.base, 'hidden-source'); fs.renameSync(f.directory, hidden);
    assert.equal(good(await f.invoke('resolveCitation', { runId: first.runId, citationId: oldEvidence.citationId })).excerpt, oldEvidence.excerpt);
    assert.equal(good(await f.invoke('readRun', { runId: second.runId, after: 0 })).run.status, 'completed'); fs.renameSync(hidden, f.directory);
    assert.equal(good(await f.invoke('checkCitation', { runId: first.runId, citationId: oldEvidence.citationId })).state, 'current');
    const parentDelete = await f.invoke('deleteRun', { runId: first.runId, expectedEventCount: old.eventCount }); assert.equal(parentDelete.ok, false); if (!parentDelete.ok) assert.equal(parentDelete.error.code, 'RUN_HAS_DEPENDENTS');
    good(await f.invoke('deleteRun', { runId: second.runId, expectedEventCount: resumed.eventCount })); good(await f.invoke('deleteRun', { runId: first.runId, expectedEventCount: old.eventCount })); assert.equal(f.saved().runs.length, 0);
  } finally { firstReady(); await f.dispose(); }
});

test('project host keeps answer submission waiting until confirmed delivery and exposes independent metadata inspection cancellation', async () => {
  let asked!: () => void, delivered!: () => void, ack!: () => void;
  const askedPromise = new Promise<void>(resolve => { asked = resolve; }), deliveredPromise = new Promise<void>(resolve => { delivered = resolve; }), ackPromise = new Promise<void>(resolve => { ack = resolve; });
  const f = fixture(async input => { input.callbacks.notice({ type: 'question', questionId: 'question-1', prompt: 'Choose fixture A or B in free text.' }); asked(); await Promise.race([deliveredPromise, stopped(input)]); }); f.questionGate(ackPromise, delivered);
  try {
    for (let i = 0; i < 125; i++) fs.writeFileSync(path.join(f.directory, 'file-' + i + '.txt'), 'fixture');
    const names = new Set<string>(); let cursor: string | null = null;
    do { const page: ProjectReadValues['browseProject'] = good(await f.invoke('browseProject', { projectId: f.root.projectId, bindingId: f.root.bindingId, directoryId: null, cursor, refresh: false })); page.entries.forEach(entry => names.add(entry.name)); cursor = page.coverage.nextCursor; } while (cursor);
    assert.equal(names.size, 125); assert.equal(f.counters().nativeStarts, 0); assert.equal((await f.start()).ok, false);
    good(await f.invoke('cancelInspection', { projectId: f.root.projectId })); for (let i = 0; i < 100 && f.arbiter.snapshot().busy; i++) await pause();
    const run = good(await f.start()); await askedPromise; good(await f.invoke('answerQuestion', { runId: run.runId, questionId: 'question-1', answer: 'fixture A' }));
    assert.equal(f.saved().runs[0]?.run.status, 'waiting_user'); assert.ok(f.saved().runs[0]?.run.events.some(event => event.type === 'question.answered')); assert.equal(f.saved().runs[0]?.run.events.some(event => event.type === 'question.delivered'), false);
    ack(); const finished = await f.wait(run.runId); assert.equal(finished.status, 'completed'); assert.equal(finished.events.filter(event => event.type === 'question.delivered').length, 1);
  } finally { ack(); delivered(); await f.dispose(); }
});

test('project host recovery keeps unknown old cleanup failed but makes unused terminal records deletable', async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(async input => { started(); await stopped(input); });
  try {
    const accepted = good(await f.start()); await ready; const interrupted = structuredClone(f.saved()); await f.host.shutdown();
    const arbiter = createAgentRuntimeArbiter(); let recovered = interrupted, engines = 0;
    const store: ProjectReadStore = { load: () => recovered, save: next => { const parsed = parseProjectReadDisk(next); assert.ok(parsed); recovered = parsed; }, close() {} };
    const host = createProjectReadHost({ store, models: f.models, bindings: f.bindings, arbiter, createEngine: () => { engines++; return f.createEngine(); } });
    const page = good(await host.invoke('readRun', { contractVersion: V, runId: accepted.runId, after: 0 }, () => true));
    assert.equal(page.run.status, 'interrupted'); assert.equal(page.run.cleanupState, 'failed'); assert.equal(engines, 0);
    const deleted = await host.invoke('deleteRun', { contractVersion: V, runId: accepted.runId, expectedEventCount: page.run.eventCount }, () => true); assert.equal(deleted.ok, true); assert.equal(recovered.runs.length, 0); await host.shutdown(); await arbiter.close();
  } finally { started(); await f.dispose(); }
});
