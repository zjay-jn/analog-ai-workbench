import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIoBudget, ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';
import { createProjectReadBroker, type ProjectReadPublication } from '../apps/desktop/src/main/cloud/project-read-broker';
import { parseProjectReadEvent } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import type { ProjectReadRef, ProjectReadRule, ProjectReadToolArguments, ProjectReadToolCall, ProjectReadToolName, ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';

const parent = path.resolve('C:/work/analog_ai_workbench/.local/agent-project-read-tests');
function fixture(hooks: { publish?: (value: ProjectReadPublication) => Promise<void>; canDeliver?: (value: ProjectReadPublication) => boolean } = {}) {
  const base = path.join(parent, randomUUID()), directory = path.join(base, 'source'); fs.mkdirSync(directory, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), directory), abort = new AbortController(), runId = randomUUID();
  const project: ProjectReadRef = { projectId: root.projectId, bindingId: root.bindingId, name: 'Synthetic', directoryName: 'source', directorySegments: ['source'], identity: createHash('sha256').update(JSON.stringify(root.chain)).digest('hex') };
  const index = createProjectReadIndex({ root, identity: project.identity, owner: { kind: 'run', id: runId }, signal: abort.signal });
  const published: ProjectReadPublication[] = [], ruleRecords: ProjectReadRule[] = [], systems: ProjectReadRule[] = [];
  const budget = createProjectReadIoBudget();
  const broker = createProjectReadBroker({ root, project, runId, signal: abort.signal, budget, index, authorize: call => call.sessionId === 'owned-session',
    publishRule: async rule => { ruleRecords.push(rule); }, installRootRule: async rule => { systems.push(rule); },
    canDeliver: hooks.canDeliver ?? (() => true), publish: async value => {
      assert.ok(parseProjectReadEvent({ runId, sequence: published.length + 2, time: new Date().toISOString(), type: 'tool.completed', data: { ...value.call, result: value.result } }), 'complete event rejected by independent parser');
      assert.equal(value.citations.length, value.locators.length);
      for (const c of value.citations) { assert.equal(c.runId, runId); assert.equal(c.excerptSha256, createHash('sha256').update(c.excerpt).digest('hex')); assert.equal(value.locators.find(item => item.citationId === c.citationId)?.file.fileIdentity, c.fileIdentity); }
      await hooks.publish?.(value); published.push(value);
    } });
  return { base, directory, root, abort, runId, project, index, broker, published, ruleRecords, systems, budget,
    async dispose() { abort.abort(); await broker.close(); const resolved = fs.realpathSync.native(base), relative = path.relative(parent, resolved); assert.equal(resolved, base); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(resolved, { recursive: true }); } };
}
function call<M extends ProjectReadToolName>(toolName: M, args: ProjectReadToolArguments[M], callId = randomUUID()): ProjectReadToolCall {
  return { toolName, arguments: args, callId, sessionId: 'owned-session', messageId: 'message-' + callId } as ProjectReadToolCall;
}
function successful(result: ProjectReadToolResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return assert.fail('failed tool'); return result.value; }
const hasCode = (code: string) => (e: unknown) => e instanceof ProjectReadFsError && e.code === code;

test('broker loads root before admission and metadata listing never publishes file evidence', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, 'AGENTS.md'), 'Root rule'); fs.writeFileSync(path.join(f.directory, 'data.txt'), 'ordinary');
    const request = call('project_list', { directoryId: null, cursor: null, refresh: false });
    await assert.rejects(f.broker.execute(request), hasCode('CAPABILITY_DENIED'));
    await f.broker.prepare(); assert.equal(f.systems[0]?.text, 'Root rule'); const readBefore = f.budget.evidence().physicalReadBytes;
    const result = successful(await f.broker.execute(request)); assert.equal(result.kind, 'list'); assert.equal(f.budget.evidence().physicalReadBytes, readBefore);
    assert.equal(f.published[0]?.citations.length, 0); assert.equal(f.ruleRecords.length, 1);
  } finally { await f.dispose(); }
});

test('broker makes body reachable after all 7 KiB ancestor rule chunks and reconstructs escaped long lines', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.directory, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(f.directory, 'a', 'AGENTS.md'), '"\\'.repeat(3584)); fs.writeFileSync(path.join(f.directory, 'a', 'b', 'AGENTS.md'), 'p'.repeat(7168));
    const raw = '"\\'.repeat(6000) + '😀尾\r\nlast\r\n'; fs.writeFileSync(path.join(f.directory, 'a', 'b', 'data.txt'), raw);
    await f.broker.prepare(); const found = successful(await f.broker.execute(call('project_find', { directoryId: null, query: 'data.txt', cursor: null, refresh: false })));
    assert.ok(found.kind === 'find'); if (found.kind !== 'find') return;
    const fileId = found.entries[0]!.fileId!, fragments: string[] = [], rules = new Map<string, string>(); let args: ProjectReadToolArguments['project_read'] = { fileId, version: null, start: { line: 1, column: 1 }, cursor: null }, dataStarted = false;
    for (let n = 0; n < 20; n++) {
      const value = successful(await f.broker.execute(call('project_read', args))); assert.equal(value.kind, 'read'); if (value.kind !== 'read') return;
      if (value.phase === 'rules') {
        assert.equal(dataStarted, false); assert.equal(value.citation, null); assert.equal(value.empty, false);
        for (const chunk of value.rules) { const prior = rules.get(chunk.source) ?? ''; assert.equal(Buffer.byteLength(prior), chunk.offsetBytes); rules.set(chunk.source, prior + chunk.text); }
      } else { dataStarted = true; assert.equal(rules.get('a/AGENTS.md'), '"\\'.repeat(3584)); assert.equal(rules.get('a/b/AGENTS.md'), 'p'.repeat(7168)); if (value.citation) fragments.push(value.citation.excerpt); }
      if (value.coverage.complete) break;
      args = { fileId, version: value.citation?.version ?? value.resume?.version ?? args.version, start: value.next!, cursor: value.coverage.nextCursor };
    }
    assert.equal(dataStarted, true); assert.equal(fragments.join(''), raw.replace(/\r\n/g, '\n'));
    assert.ok(f.published.every(item => Buffer.byteLength(JSON.stringify(item.result)) <= 12288));
  } finally { await f.dispose(); }
});

test('broker searches real text beyond 1 MiB and line 15000 with actual normalized coverage', async () => {
  const f = fixture();
  try {
    const raw = Array.from({ length: 16002 }, (_, i) => i === 15001 ? 'late answer 314159' : 'fixture '.repeat(12)).join('\r\n'); assert.ok(Buffer.byteLength(raw) > 1024 * 1024);
    fs.writeFileSync(path.join(f.directory, 'large.txt'), raw); await f.broker.prepare();
    let args: ProjectReadToolArguments['project_search'] = { directoryId: null, query: '314159', cursor: null, refresh: false }, saw = false, complete = false;
    for (let i = 0; i < 8; i++) {
      const value = successful(await f.broker.execute(call('project_search', args))); assert.equal(value.kind, 'search'); if (value.kind !== 'search') return;
      if (value.matches.length) { assert.equal(value.matches[0]?.match.start.line, 15002); saw = true; assert.ok(value.coverage.scannedBytes <= Buffer.byteLength(raw.replace(/\r\n/g, '\n'))); }
      if (value.coverage.complete) { assert.equal(value.coverage.scannedFiles, 1); assert.equal(value.coverage.scannedBytes, Buffer.byteLength(raw.replace(/\r\n/g, '\n'))); complete = true; break; }
      args = { ...args, cursor: value.coverage.nextCursor };
    }
    assert.equal(saw, true); assert.equal(complete, true); assert.equal(f.budget.evidence().physicalReadBytes, Buffer.byteLength(raw) * 2);
  } finally { await f.dispose(); }
});

test('broker continuation binds exact parameters and concurrent duplicate call waits for one durable result', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let hold = false;
  const f = fixture({ publish: async () => { if (hold) await held; } });
  try {
    fs.writeFileSync(path.join(f.directory, 'data.txt'), 'abc '.repeat(5000)); await f.broker.prepare();
    const found = successful(await f.broker.execute(call('project_find', { directoryId: null, query: 'data', cursor: null, refresh: false }))); if (found.kind !== 'find') return assert.fail('find');
    const request = call('project_read', { fileId: found.entries[0]!.fileId!, version: null, cursor: null, start: { line: 1, column: 1 } }); hold = true;
    const first = f.broker.execute(request), duplicate = f.broker.execute(request); assert.equal(first, duplicate);
    await new Promise<void>(resolve => setTimeout(resolve, 40)); assert.equal(f.published.length, 1); release(); const result = successful(await first); hold = false;
    assert.equal(f.published.length, 2); assert.equal(await f.broker.execute(request), await first); assert.equal(f.published.length, 2);
    if (result.kind !== 'read' || !result.citation) return assert.fail('read');
    const bad = await f.broker.execute(call('project_read', { fileId: result.citation.fileId, version: result.citation.version, cursor: result.coverage.nextCursor, start: { line: 1, column: 2 } }));
    assert.deepEqual(bad, { ok: false, error: { code: 'CURSOR_STALE' }, coverage: null });
    const next = successful(await f.broker.execute(call('project_read', { fileId: result.citation.fileId, version: result.citation.version, cursor: result.coverage.nextCursor, start: result.next! })));
    assert.equal(next.kind, 'read');
  } finally { release(); await f.dispose(); }
});

test('broker failed persistence or exhausted next-request reservation releases no citation', async () => {
  let deny = false, failWrite = false;
  const f = fixture({ canDeliver: value => !deny || value.citations.length === 0, publish: async value => { if (failWrite && value.citations.length) throw new Error('synthetic store unavailable'); } });
  try {
    fs.writeFileSync(path.join(f.directory, 'data.txt'), 'sample'); await f.broker.prepare();
    const found = successful(await f.broker.execute(call('project_find', { directoryId: null, query: 'data', cursor: null, refresh: false }))); if (found.kind !== 'find') return assert.fail('find');
    const args = { fileId: found.entries[0]!.fileId!, version: null, cursor: null, start: { line: 1, column: 1 } };
    deny = true; const result = await f.broker.execute(call('project_read', args)); assert.equal(result.ok, false); assert.equal(f.published.flatMap(row => row.citations).length, 0);
    deny = false; failWrite = true; await assert.rejects(f.broker.execute(call('project_read', args)), hasCode('STORAGE_FAILED')); assert.equal(f.published.flatMap(row => row.citations).length, 0);
  } finally { await f.dispose(); }
});

test('broker partial search resumes within the same verified file and never counts cached tail as searched', async () => {
  const f = fixture();
  try {
    const raw = Array.from({ length: 45 }, (_, i) => 'match-' + i + '😀').join('\n'); fs.writeFileSync(path.join(f.directory, 'many.txt'), raw); await f.broker.prepare();
    const args: ProjectReadToolArguments['project_search'] = { directoryId: null, query: 'match', cursor: null, refresh: false };
    const first = successful(await f.broker.execute(call('project_search', args))); if (first.kind !== 'search') return assert.fail('search');
    assert.ok(first.matches.length > 0 && first.matches.length <= 20); assert.equal(first.coverage.scannedFiles, 0); assert.ok(first.coverage.scannedBytes < Buffer.byteLength(raw)); assert.equal(first.resume?.next.line, first.matches.length);
    assert.equal(f.budget.evidence().physicalReadBytes, Buffer.byteLength(raw) * 2);
    let previous = first, count = first.matches.length;
    for (let n = 0; n < 8 && !previous.coverage.complete; n++) {
      const next = successful(await f.broker.execute(call('project_search', { ...args, cursor: previous.coverage.nextCursor })));
      if (next.kind !== 'search') return assert.fail('search');
      if (next.matches.length) assert.equal(next.matches[0]?.match.start.line, count + 1);
      assert.ok(next.coverage.scannedBytes >= previous.coverage.scannedBytes); count += next.matches.length; previous = next;
    }
    assert.equal(count, 45); assert.equal(previous.coverage.complete, true); assert.equal(previous.coverage.scannedBytes, Buffer.byteLength(raw));
  } finally { await f.dispose(); }
});
