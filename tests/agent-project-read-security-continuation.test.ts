import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { captureFolderRoot, folderDisplaySegments } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIoBudget, ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex } from '../apps/desktop/src/main/cloud/project-read-index';
import { createProjectReadBroker } from '../apps/desktop/src/main/cloud/project-read-broker';
import { prepareProjectReadContinuation, projectReadInitialUserText } from '../apps/desktop/src/main/agent-project-read/continuation';
import type { ProjectReadStoredRun, ProjectReadStoredCitation } from '../apps/desktop/src/main/agent-project-read/store';
import type * as C from '../apps/desktop/src/shared/agent/agent-project-read';

const product = path.resolve('C:/work/analog_ai_workbench'), parentDirectory = path.join(product, '.local/quality-evidence/20260911-agent-project-read-security-01/fixtures');
const time = '2026-09-11T12:00:00.000Z', later = '2026-09-11T12:01:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof ProjectReadFsError && error.code === expected;
const budgetLimit: C.ProjectReadBudget = { providerAttempts: 24, httpDispatches: 24, toolAttempts: 64, physicalReadBytes: 268435456, visitedCandidates: 100000, contextBytes: 196608, outputBytes: 65536, maxOutputTokens: 16384, deadlineMs: 14400000, waitMs: 1800000 };
const value = (result: C.ProjectReadToolResult) => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };
const listArgs = (cursor: string | null = null) => ({ directoryId: null, cursor, refresh: false });
const readArgs = (fileId: string): C.ProjectReadToolArguments['project_read'] => ({ fileId, version: null, start: { line: 1, column: 1 }, cursor: null });
function request<M extends C.ProjectReadToolName>(sessionId: string, toolName: M, arguments_: C.ProjectReadToolArguments[M]): C.ProjectReadToolCall { const callId = randomUUID(); return { sessionId, messageId: 'message-' + callId, callId, toolName, arguments: arguments_ } as C.ProjectReadToolCall; }
function under(target: string, parent: string) { const resolved = path.resolve(target), relative = path.relative(parent, resolved); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); return resolved; }
function noLinks(target: string): void { let at = path.parse(target).root; for (const part of target.slice(at.length).split(path.sep)) { at = path.join(at, part); if (fs.existsSync(at)) assert.equal(fs.lstatSync(at).isSymbolicLink(), false); } }

function createRun(root: ReturnType<typeof captureFolderRoot>, maximumCitationsPerResult = 64) {
  const runId = randomUUID(), sessionId = 'session-' + runId, signal = new AbortController(), budget = createProjectReadIoBudget();
  const segments = folderDisplaySegments(root.root), project: C.ProjectReadRef = { projectId: root.projectId, bindingId: root.bindingId, name: 'Independent continuation fixture', directoryName: segments.at(-1)!, directorySegments: segments, identity: sha(JSON.stringify(root.chain)) };
  const index = createProjectReadIndex({ root, identity: project.identity, owner: { kind: 'run', id: runId }, signal: signal.signal });
  const events: C.ProjectReadEvent[] = [], citations: ProjectReadStoredCitation[] = [];
  const add = <K extends keyof C.ProjectReadEventData>(type: K, data: C.ProjectReadEventData[K]) => events.push({ runId, sequence: events.length + 1, time, type, data } as C.ProjectReadEvent);
  add('run.accepted', { project, model: { provider: 'deepseek', model: 'deepseek-v4-flash' }, continuedFrom: null, budget: budgetLimit });
  const broker = createProjectReadBroker({ root, project, runId, signal: signal.signal, budget, index, authorize: call => call.sessionId === sessionId,
    publishRule: async rule => { add('project.rules', { rules: [rule] }); }, installRootRule: async () => {}, canDeliver: publication => publication.citations.length <= maximumCitationsPerResult,
    publish: async publication => { add('tool.completed', { ...publication.call, result: publication.result } as C.ProjectReadEventData['tool.completed']); for (const citation of publication.citations) { const locator = publication.locators.find(row => row.citationId === citation.citationId)!; citations.push({ citation, file: locator.file }); } },
  });
  const execute = async <M extends C.ProjectReadToolName>(toolName: M, arguments_: C.ProjectReadToolArguments[M]) => { const call = request(sessionId, toolName, arguments_); add('tool.started', call); return broker.execute(call); };
  return { root, runId, sessionId, signal, budget, index, broker, events, citations, add, execute,
    async prepare() { await broker.prepare(); add('run.started', { sessionId, engine: 'opencode', version: '1.18.17' }); },
    async finish(status: 'stopped' | 'completed' = 'stopped'): Promise<ProjectReadStoredRun> {
      const accounting = broker.accounting(); add('budget.updated', { providerAttempts: 0, httpDispatches: 0, toolAttempts: accounting.toolAttempts, physicalReadBytes: accounting.physicalReadBytes, visitedCandidates: accounting.visitedCandidates, contextBytes: null });
      add('cleanup.started', { reason: status === 'stopped' ? 'stop' : 'completed' }); await broker.close(); add('cleanup.completed', { outcome: 'confirmed' });
      if (status === 'stopped') add('run.stopped', { reason: 'user' }); else add('run.completed', { citations: citations.map(row => row.citation.citationId) });
      return { root, citations: [...citations], run: { runId, clientRequestId: 'request-' + runId, project, model: { provider: 'deepseek', model: 'deepseek-v4-flash' }, goal: 'Synthetic continuation task', constraint: '', continuedFrom: null, status, cleanupState: 'idle', createdAt: time, updatedAt: time, accounting: { providerAttempts: 0, httpDispatches: 0, toolAttempts: accounting.toolAttempts, physicalReadBytes: accounting.physicalReadBytes, visitedCandidates: accounting.visitedCandidates, contextBytes: null }, eventCount: events.length, continuation: null, events: [...events] } };
    },
  };
}
type Run = ReturnType<typeof createRun>;
async function fixture(body: (f: { base: string; write(name: string, text: string): void; make(maxCitations?: number): Run; opens: string[] }) => Promise<void>) {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), product.toLowerCase()); noLinks(parentDirectory);
  const base = under(path.join(parentDirectory, randomUUID()), parentDirectory); assert.equal(fs.existsSync(base), false); fs.mkdirSync(base, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), base), runs: Run[] = [], opens: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(asyncFs, 'open')!, open = asyncFs.open;
  Object.defineProperty(asyncFs, 'open', { ...descriptor, value: async (...parameters: Parameters<typeof asyncFs.open>) => { opens.push(under(String(parameters[0]), base)); return open(...parameters); } });
  try { await body({ base, opens, write(name, text) { const target = under(path.join(base, name), base); noLinks(path.dirname(target)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }, make(maximum = 64) { const run = createRun(root, maximum); runs.push(run); return run; } }); }
  finally { for (const run of runs) run.signal.abort(); await Promise.allSettled(runs.map(run => run.broker.close())); Object.defineProperty(asyncFs, 'open', descriptor); const resolved = fs.realpathSync.native(base); assert.equal(resolved.toLowerCase(), base.toLowerCase()); under(resolved, parentDirectory); noLinks(resolved); assert.match(path.basename(resolved), /^[0-9a-f-]{36}$/u); fs.rmSync(resolved, { recursive: true }); }
}
async function locate(run: Run): Promise<string> { const found = value(await run.execute('project_find', { ...listArgs(), query: 'document.txt' })); assert.equal(found.kind, 'find'); if (found.kind !== 'find') return assert.fail('find'); assert.equal(found.entries.length, 1); return found.entries[0]!.fileId!; }
async function readPages(run: Run, count: number) {
  let args = readArgs(await locate(run)), last: Extract<C.ProjectReadToolValue, { kind: 'read' }> | undefined;
  for (let n = 0; n < count; n++) {
    const output = value(await run.execute('project_read', args)); assert.equal(output.kind, 'read'); if (output.kind !== 'read') return assert.fail('read'); last = output;
    if (output.coverage.complete) break; assert.ok(output.next && output.coverage.nextCursor); args = { fileId: args.fileId, version: output.citation?.version ?? output.resume?.version ?? args.version, start: output.next, cursor: output.coverage.nextCursor };
  }
  assert.ok(last); return { last, args };
}
const prepare = (parent: ProjectReadStoredRun, next: Run) => prepareProjectReadContinuation({ parent, runId: next.runId, createdAt: later, broker: next.broker, index: next.index, budget: next.budget, signal: next.signal.signal });
const rows = (count: number) => Array.from({ length: count }, (_, n) => 'row-' + n + ' 甲🙂').join('\r\n');

test('independent continuation import: same-file citations share one double-read and acquire only new execution identities', async () => {
  await fixture(async f => {
    const raw = rows(1800); f.write('document.txt', raw); const old = f.make(); await old.prepare(); const prior = await readPages(old, 2); assert.ok(prior.last.resume && !prior.last.coverage.complete);
    old.add('message.delta', { messageId: 'old-prose-message', step: 1, text: 'Confirmed [资料:' + old.citations[0]!.citation.citationId + ']' });
    old.add('question.asked', { questionId: 'delivered-old-question', prompt: 'Which part?' }); old.add('question.answered', { questionId: 'delivered-old-question', answer: 'The remaining part.' }); old.add('question.delivered', { questionId: 'delivered-old-question' });
    old.add('question.asked', { questionId: 'undelivered-old-question', prompt: 'Pending answer?' }); old.add('question.answered', { questionId: 'undelivered-old-question', answer: 'Unconfirmed answer.' });
    const parent = await old.finish(), next = f.make(); await next.prepare(); const opened = f.opens.length, continued = await prepare(parent, next);
    assert.equal(continued.citations.length, 2); assert.equal(next.budget.evidence().physicalReadBytes, Buffer.byteLength(raw) * 2); assert.equal(f.opens.length - opened, 1);
    for (let n = 0; n < 2; n++) {
      const imported = continued.citations[n]!, original = parent.citations[n]!;
      assert.notEqual(imported.citation.citationId, original.citation.citationId); assert.notEqual(imported.citation.fileId, original.citation.fileId); assert.notEqual(imported.citation.snapshotId, original.citation.snapshotId);
      assert.equal(imported.citation.runId, next.runId); assert.equal(imported.citation.createdAt, later); assert.deepEqual(imported.citation.origin, { runId: old.runId, citationId: original.citation.citationId });
      assert.deepEqual(imported.file, original.file); assert.equal(imported.citation.excerpt, original.citation.excerpt); assert.equal(imported.citation.version, sha(raw));
    }
    assert.equal(continued.citations[0]!.citation.fileId, continued.citations[1]!.citation.fileId);
    assert.equal(continued.context.lastAssistantMessage, 'Confirmed [资料:' + continued.citations[0]!.citation.citationId + ']');
    assert.deepEqual(continued.context.confirmedQuestions, [{ prompt: 'Which part?', answer: 'The remaining part.' }]);
    const context = JSON.stringify(continued.context);
    for (const event of parent.run.events) if (event.type === 'tool.started') { assert.equal(context.includes(event.data.sessionId), false); assert.equal(context.includes(event.data.messageId), false); assert.equal(context.includes(event.data.callId), false); }
    for (const priorCitation of parent.citations) { assert.equal(context.includes(priorCitation.citation.fileId), false); assert.equal(context.includes(priorCitation.citation.snapshotId), false); assert.equal(context.includes(priorCitation.citation.citationId), false); }
    assert.equal(context.includes(prior.last.coverage.nextCursor!), false); assert.equal(continued.context.resumedOperations.length, 1);
    const resumed = continued.context.resumedOperations[0]!; assert.equal(resumed.toolName, 'project_read'); const arguments_ = resumed.arguments as C.ProjectReadToolArguments['project_read'];
    assert.deepEqual(arguments_.start, prior.last.resume.next); assert.equal(arguments_.version, prior.last.resume.version); assert.notEqual(arguments_.cursor, prior.last.coverage.nextCursor);
    assert.throws(() => next.index.resolveFile(parent.citations[0]!.citation.fileId), code('CURSOR_STALE'));
    const rejected = await next.execute('project_read', prior.args); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, 'CURSOR_STALE');
    const output = value(await next.execute('project_read', arguments_)); assert.equal(output.kind, 'read'); if (output.kind !== 'read') return assert.fail('read'); assert.ok(output.citation);
    assert.deepEqual(output.citation.range.start, prior.last.resume.next); assert.ok(output.citation.range.start.line > 1); assert.ok(output.citation.excerpt.startsWith('row-' + (output.citation.range.start.line - 1)));
    const initial = projectReadInitialUserText('Continue synthetic task', '', continued); assert.ok(initial.includes(JSON.stringify(continued.context.resumedOperations))); assert.equal(initial.includes('Unconfirmed answer.'), false);
  });
});

test('independent continuation restart truth: a resumed or later-completed read must not also request restarting that read', async t => {
  for (const completed of [false, true]) await t.test(completed ? 'later-completed' : 'resumed-read', async () => {
    await fixture(async f => {
      f.write('document.txt', rows(completed ? 250 : 600)); const old = f.make(); await old.prepare(); await readPages(old, completed ? 4 : 1);
      const parent = await old.finish(completed ? 'completed' : 'stopped'), next = f.make(); await next.prepare(); const continued = await prepare(parent, next);
      assert.equal(continued.context.resumedOperations.length, completed ? 0 : 1);
      assert.equal(continued.context.restartRequired.some(item => item.tool === 'project_read'), false, 'latest confirmed read state supersedes earlier partial read pages');
      assert.equal(continued.summary.restartedQueries, 0);
    });
  });
  await t.test('later-completed-search', async () => {
    await fixture(async f => {
      f.write('document.txt', 'needle-1\nneedle-2\nneedle-3\nneedle-4'); const old = f.make(3); await old.prepare();
      let args: C.ProjectReadToolArguments['project_search'] = { ...listArgs(), query: 'needle' }, complete = false;
      for (let n = 0; n < 8; n++) {
        const output = value(await old.execute('project_search', args)); assert.equal(output.kind, 'search'); if (output.kind !== 'search') return assert.fail('search');
        if (output.coverage.complete) { complete = true; break; } args = { ...args, cursor: output.coverage.nextCursor };
      }
      assert.equal(complete, true); const parent = await old.finish('completed'), next = f.make(); await next.prepare(); const continued = await prepare(parent, next);
      assert.equal(continued.context.resumedOperations.length, 0); assert.deepEqual(continued.context.restartRequired, []); assert.equal(continued.summary.restartedQueries, 0);
    });
  });
  await t.test('independent-read-chain', async () => {
    await fixture(async f => {
      f.write('document.txt', rows(600)); const old = f.make(); await old.prepare(); const fileId = await locate(old);
      const unfinished = value(await old.execute('project_read', readArgs(fileId))); assert.equal(unfinished.kind, 'read'); if (unfinished.kind !== 'read') return assert.fail('read'); assert.ok(unfinished.resume);
      const independent = value(await old.execute('project_read', { ...readArgs(fileId), start: { line: 401, column: 1 } })); assert.equal(independent.kind, 'read'); if (independent.kind !== 'read') return assert.fail('read'); assert.equal(independent.coverage.complete, true);
      const parent = await old.finish(), next = f.make(); await next.prepare(); const continued = await prepare(parent, next);
      assert.equal(continued.context.resumedOperations.length, 1, 'a different completed read chain must not erase the unfinished read');
      assert.deepEqual((continued.context.resumedOperations[0]!.arguments as C.ProjectReadToolArguments['project_read']).start, unfinished.resume.next);
      assert.deepEqual(continued.context.restartRequired, []);
    });
  });
  await t.test('rules-without-verified-position', async () => {
    await fixture(async f => {
      f.write('scope/AGENTS.md', 'r'.repeat(8192)); f.write('scope/document.txt', rows(300)); const old = f.make(); await old.prepare(); const first = await readPages(old, 1);
      assert.equal(first.last.phase, 'rules'); assert.equal(first.last.resume, null); assert.equal(old.citations.length, 0);
      const parent = await old.finish(), next = f.make(); await next.prepare(); const continued = await prepare(parent, next);
      assert.equal(continued.context.resumedOperations.length, 0); assert.equal(continued.context.restartRequired.length, 1); assert.equal(continued.context.restartRequired[0]?.tool, 'project_read'); assert.equal(continued.summary.restartedQueries, 1);
    });
  });
});

test('independent continuation restored search: starts at remaining file position and never claims whole-directory completion', async () => {
  await fixture(async f => {
    const raw = Array.from({ length: 30 }, (_, n) => 'needle-' + n + ' 甲🙂').join('\n'); f.write('scope/document.txt', raw);
    const old = f.make(3); await old.prepare(); const first = value(await old.execute('project_search', { ...listArgs(), query: 'needle' })); assert.equal(first.kind, 'search'); if (first.kind !== 'search') return assert.fail('search'); assert.equal(first.matches.length, 3); assert.ok(first.resume);
    const parent = await old.finish(); f.write('scope/added-later.txt', 'needle in a different file'); const next = f.make(); await next.prepare(); const continued = await prepare(parent, next);
    assert.equal(continued.context.resumedOperations.length, 1); assert.ok(continued.context.restartRequired.some(item => item.tool === 'project_search'));
    let args = continued.context.resumedOperations[0]!.arguments as C.ProjectReadToolArguments['project_search']; const lines: number[] = []; let final: Extract<C.ProjectReadToolValue, { kind: 'search' }> | undefined;
    for (let page = 0; page < 10; page++) {
      const output = value(await next.execute('project_search', args)); assert.equal(output.kind, 'search'); if (output.kind !== 'search') return assert.fail('search'); final = output;
      for (const match of output.matches) { assert.equal(match.relativePath, 'scope/document.txt'); lines.push(match.match.start.line); }
      if (output.coverage.nextCursor === null) break; args = { ...args, cursor: output.coverage.nextCursor };
    }
    assert.deepEqual(lines, Array.from({ length: 27 }, (_, n) => n + 4)); assert.ok(final); assert.equal(final.coverage.nextCursor, null); assert.equal(final.coverage.complete, false); assert.equal(final.coverage.limitReason, 'scope'); assert.equal(final.coverage.scannedFiles, 1);
    assert.equal(f.opens.some(file => file.endsWith(path.sep + 'added-later.txt')), false);
  });
});

test('independent continuation revalidation: file content, file object and prior rule changes cannot be adopted', async t => {
  for (const mutation of ['file-content', 'file-object', 'local-rule'] as const) await t.test(mutation, async () => {
    await fixture(async f => {
      const raw = rows(500); f.write('scope/document.txt', raw); if (mutation === 'local-rule') f.write('scope/AGENTS.md', 'first scoped rule');
      const old = f.make(); await old.prepare(); await readPages(old, mutation === 'local-rule' ? 2 : 1); const parent = await old.finish();
      if (mutation === 'file-content') f.write('scope/document.txt', raw.replace('row-0', 'ROW-0'));
      if (mutation === 'file-object') { fs.renameSync(under(path.join(f.base, 'scope/document.txt'), f.base), under(path.join(f.base, 'scope/retired.txt'), f.base)); f.write('scope/document.txt', raw); }
      if (mutation === 'local-rule') f.write('scope/AGENTS.md', 'other scoped rule');
      const next = f.make(); await next.prepare(); await assert.rejects(prepare(parent, next), code('SOURCE_CHANGED')); assert.equal(next.citations.length, 0);
    });
  });
});

test('independent continuation preflight: exact 128 MiB charge ceiling includes prior uncertain reads and deduplicates current evidence', async t => {
  for (const excess of [0, 1]) await t.test(excess ? 'one-byte-over' : 'exact-boundary', async () => {
    await fixture(async f => {
      const raw = rows(500); f.write('document.txt', raw); const old = f.make(); await old.prepare(); await readPages(old, 2); const parent = await old.finish(), next = f.make(); await next.prepare();
      // Synthetic prior uncertain read reservations exercise accounting without manufacturing 128 MiB of I/O.
      let consumed = 128 * 1024 * 1024 - 2 * Buffer.byteLength(raw) + excess;
      while (consumed > 0) { const count = Math.min(65536, consumed); next.budget.reserve(count)(null); consumed -= count; }
      const opened = f.opens.length;
      if (excess) { await assert.rejects(prepare(parent, next), code('BUDGET_EXCEEDED')); assert.equal(f.opens.length, opened); assert.equal(next.budget.evidence().physicalReadBytes, 0); }
      else { assert.equal((await prepare(parent, next)).citations.length, 2); assert.equal(next.budget.evidence().chargedBytes, 128 * 1024 * 1024); assert.equal(next.budget.evidence().physicalReadBytes, 2 * Buffer.byteLength(raw)); assert.equal(f.opens.length - opened, 1); }
    });
  });
});

test('independent continuation bounded history: nine citations, oversized last prose and 32 KiB facts fail explicitly', async t => {
  await t.test('nine-citations', async () => {
    await fixture(async f => { f.write('document.txt', rows(2200)); const old = f.make(); await old.prepare(); await readPages(old, 9); const parent = await old.finish(); assert.equal(parent.citations.length, 9); const next = f.make(); await next.prepare(); const opened = f.opens.length; await assert.rejects(prepare(parent, next), code('BUDGET_EXCEEDED')); assert.equal(f.opens.length, opened); });
  });
  await t.test('last-prose', async () => {
    await fixture(async f => { f.write('document.txt', 'small'); const old = f.make(); await old.prepare(); old.add('message.delta', { messageId: 'too-long-assistant', step: 1, text: 'x'.repeat(8193) }); const parent = await old.finish(), next = f.make(); await next.prepare(); await assert.rejects(prepare(parent, next), code('BUDGET_EXCEEDED')); });
  });
  await t.test('confirmed-facts', async () => {
    await fixture(async f => {
      for (let n = 0; n < 140; n++) f.write(`item-${n}-${'x'.repeat(180)}.txt`, 'synthetic'); const old = f.make(); await old.prepare(); let cursor: string | null = null, complete = false;
      for (let page = 0; page < 20; page++) { const output = value(await old.execute('project_list', listArgs(cursor))); assert.equal(output.kind, 'list'); if (output.kind !== 'list') return assert.fail('list'); cursor = output.coverage.nextCursor; if (output.coverage.complete) { complete = true; break; } }
      assert.equal(complete, true); const parent = await old.finish('completed'), next = f.make(); await next.prepare(); await assert.rejects(prepare(parent, next), code('BUDGET_EXCEEDED')); assert.equal(next.budget.evidence().physicalReadBytes, 0);
    });
  });
});

test('independent continuation cancellation and busy state prevent preflight admission', async t => {
  for (const state of ['cancelled', 'running', 'cleanup'] as const) await t.test(state, async () => {
    await fixture(async f => {
      f.write('document.txt', rows(500)); const old = f.make(); await old.prepare(); await readPages(old, 1); const stored = await old.finish(), next = f.make(); await next.prepare();
      const parent = state === 'running' ? { ...stored, run: { ...stored.run, status: 'running' as const } } : state === 'cleanup' ? { ...stored, run: { ...stored.run, cleanupState: 'pending' as const } } : stored;
      if (state === 'cancelled') next.signal.abort(); const opened = f.opens.length;
      await assert.rejects(prepare(parent, next), code(state === 'cancelled' ? 'CANCELLED' : 'BUSY')); assert.equal(f.opens.length, opened); assert.equal(next.citations.length, 0);
    });
  });
});

test('independent continuation failed cleanup: terminal records with unconfirmed cleanup cannot supply inherited evidence', async () => {
  await fixture(async f => {
    f.write('document.txt', rows(500)); const old = f.make(); await old.prepare(); await readPages(old, 1); const stored = await old.finish(), next = f.make(); await next.prepare();
    const parent = { ...stored, run: { ...stored.run, cleanupState: 'failed' as const } }, opened = f.opens.length;
    await assert.rejects(prepare(parent, next), code('BUSY')); assert.equal(f.opens.length, opened); assert.equal(next.citations.length, 0);
  });
});
