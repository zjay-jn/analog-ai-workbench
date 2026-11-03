import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectFolderHost } from '../apps/desktop/src/main/cloud/project-folder-host';
import { emptyWorkspace, newProject } from '../apps/desktop/src/shared/agent/project-workspace';
import { captureProjectReadFile, createProjectReadIoBudget, createProjectReadOperation, createProjectTextReader, ProjectReadFsError, verifyProjectReadRoot, type ProjectReadTextSnapshot } from '../apps/desktop/src/main/cloud/project-read-files';
import { pageProjectText, searchProjectText } from '../packages/agent-adapters/src/project-read-text';
import { createProjectReadRules, projectReadRuleChunk } from '../apps/desktop/src/main/cloud/project-read-rules';
import type { ProjectReadRule, ProjectReadRuleChunk } from '../apps/desktop/src/shared/agent/agent-project-read';

const fixtureParent = path.resolve('C:/work/analog_ai_workbench/.local/agent-project-read-tests');
function fixture() {
  const base = path.join(fixtureParent, randomUUID()), directory = path.join(base, 'source');
  fs.mkdirSync(directory, { recursive: true });
  const root = captureFolderRoot(randomUUID(), randomUUID(), directory);
  return { base, directory, root, dispose() {
    const resolved = fs.realpathSync.native(base), relative = path.relative(fixtureParent, resolved);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    assert.equal(resolved, base); fs.rmSync(resolved, { recursive: true });
  } };
}
const hasCode = (code: string) => (error: unknown) => error instanceof ProjectReadFsError && error.code === code;

test('project rules load both 7 KiB ancestors, record absence and keep sibling scope separate', async () => {
  const f = fixture(), abort = new AbortController(), budget = createProjectReadIoBudget(), published: ProjectReadRule[] = [];
  const rules = createProjectReadRules({ root: f.root, signal: abort.signal, budget, publish: async rule => { published.push(rule); } });
  try {
    fs.mkdirSync(path.join(f.directory, 'parent', 'child'), { recursive: true }); fs.mkdirSync(path.join(f.directory, 'sibling'));
    fs.writeFileSync(path.join(f.directory, 'parent', 'AGENTS.md'), 'p'.repeat(7168));
    fs.writeFileSync(path.join(f.directory, 'parent', 'child', 'AGENTS.md'), 'c'.repeat(7168));
    fs.writeFileSync(path.join(f.directory, 'parent', 'child', 'data.txt'), 'data');
    fs.writeFileSync(path.join(f.directory, 'sibling', 'data.txt'), 'separate');
    const root = await rules.loadRoot(createProjectReadOperation(abort.signal)); assert.equal(root.rule.state, 'absent');
    const applicable = await rules.forFile(captureProjectReadFile(f.root, 'parent/child/data.txt'), createProjectReadOperation(abort.signal));
    assert.deepEqual(applicable.map(row => row.rule.source), ['AGENTS.md', 'parent/AGENTS.md', 'parent/child/AGENTS.md']);
    assert.equal(published.length, 3); assert.equal(budget.evidence().physicalReadBytes, 28672);
    assert.deepEqual(rules.evidence(), { loadedCount: 2, loadedRawBytes: 14336, observedSources: 3 });
    const sibling = await rules.forFile(captureProjectReadFile(f.root, 'sibling/data.txt'), createProjectReadOperation(abort.signal));
    assert.deepEqual(sibling.map(row => row.rule.source), ['AGENTS.md', 'sibling/AGENTS.md']);
    assert.ok(sibling.every(row => row.rule.state === 'absent')); assert.equal(rules.evidence().loadedCount, 2);
  } finally { await rules.close(); f.dispose(); }
});

test('project rules quote-heavy 8 KiB text progresses under complete envelope and double-escaped budgets', () => {
  const raw = '"\\'.repeat(4092) + '😀😀'; assert.equal(Buffer.byteLength(raw), 8192);
  const digest = createHash('sha256').update(raw).digest('hex');
  const rule: ProjectReadRule = { source: 'AGENTS.md', relativeDirectory: '', state: 'loaded', version: digest, normalizedSha256: digest, text: raw };
  const chunks: ProjectReadRuleChunk[] = []; let offset = 0;
  const fits = (chunk: ProjectReadRuleChunk) => {
    const envelope = { ok: true, value: { phase: 'rules', rules: [chunk], metadata: 'x'.repeat(4000) } };
    const toolJson = JSON.stringify(envelope);
    return Buffer.byteLength(toolJson) <= 12288 && Buffer.byteLength(JSON.stringify({ messages: [{ role: 'tool', content: toolJson }], reserve: 'x'.repeat(184000) })) <= 192 * 1024;
  };
  for (let count = 0; count < 20 && offset < 8192; count++) {
    const chunk = projectReadRuleChunk({ ruleId: 'rule-fixture', rule, offsetBytes: offset, fits });
    assert.ok(chunk.endBytes > offset); assert.ok(fits(chunk)); assert.equal(chunk.offsetBytes, offset);
    assert.equal(chunk.text.includes('\ufffd'), false); chunks.push(chunk); offset = chunk.endBytes;
  }
  assert.equal(offset, 8192); assert.equal(chunks.at(-1)!.complete, true); assert.ok(chunks.length > 2);
  assert.equal(chunks.map(chunk => chunk.text).join(''), raw);
  assert.throws(() => projectReadRuleChunk({ ruleId: 'rule-fixture', rule, offsetBytes: 8185, fits }), hasCode('INVALID_REQUEST'));
});

test('project rules reject oversized, changed and non-regular rule sources without publishing replacement', async () => {
  const f = fixture(), abort = new AbortController(), published: ProjectReadRule[] = [];
  const rules = createProjectReadRules({ root: f.root, signal: abort.signal, budget: createProjectReadIoBudget(), publish: async rule => { published.push(rule); } });
  try {
    const target = path.join(f.directory, 'AGENTS.md'); fs.writeFileSync(target, 'x'.repeat(8193));
    await assert.rejects(rules.loadRoot(createProjectReadOperation(abort.signal)), hasCode('RULES_LIMIT')); assert.equal(published.length, 0);
    fs.writeFileSync(target, 'first'); await rules.loadRoot(createProjectReadOperation(abort.signal)); assert.equal(published.length, 1);
    fs.writeFileSync(target, 'later'); await assert.rejects(rules.loadRoot(createProjectReadOperation(abort.signal)), hasCode('SOURCE_CHANGED')); assert.equal(published.length, 1);
    fs.unlinkSync(target); fs.mkdirSync(target); await assert.rejects(rules.loadRoot(createProjectReadOperation(abort.signal)), hasCode('RULES_UNAVAILABLE'));
  } finally { await rules.close(); f.dispose(); }
});

test('project rules publication failure and cancellation cannot make a record usable', async () => {
  const f = fixture(), abort = new AbortController(); let rejectWrite = true;
  const rules = createProjectReadRules({ root: f.root, signal: abort.signal, budget: createProjectReadIoBudget(), publish: async () => { if (rejectWrite) throw new Error('synthetic save failure'); abort.abort(); } });
  try {
    fs.writeFileSync(path.join(f.directory, 'AGENTS.md'), 'rule');
    await assert.rejects(rules.loadRoot(createProjectReadOperation(abort.signal)), hasCode('STORAGE_FAILED'));
    assert.deepEqual(rules.evidence(), { loadedCount: 0, loadedRawBytes: 0, observedSources: 0 }); rejectWrite = false;
    await assert.rejects(rules.loadRoot(createProjectReadOperation(abort.signal)), hasCode('CANCELLED'));
    assert.equal(rules.evidence().observedSources, 0); await rules.close(); await rules.close();
  } finally { await rules.close(); f.dispose(); }
});

test('project file reader resumes bounded double reads and exposes only the verified large-file version', async () => {
  const f = fixture();
  try {
    const lines = Array.from({ length: 16001 }, (_, index) => index === 15000 ? 'late verified target 314159' : 'synthetic ordinary record ' + 'x'.repeat(52));
    const raw = Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n');
    assert.ok(raw.length > 1024 * 1024); fs.writeFileSync(path.join(f.directory, 'large.txt'), raw);
    const file = captureProjectReadFile(f.root, 'large.txt'), abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = createProjectTextReader({ root: f.root, file, expectedVersion: null, signal: abort.signal, budget });
    let value: ProjectReadTextSnapshot | undefined, pending = 0;
    try {
      for (let count = 0; count < 100; count++) {
        const result = await reader.step(createProjectReadOperation(abort.signal, { bytes: 32768 }));
        if (result.kind === 'complete') { value = result.value; break; }
        pending++; assert.equal(Object.hasOwn(result, 'value'), false); assert.equal(Object.hasOwn(result, 'source'), false);
      }
    } finally { await reader.close(); }
    assert.ok(value); assert.ok(pending > 50);
    assert.equal(value.version, createHash('sha256').update(raw).digest('hex'));
    assert.notEqual(value.version, value.normalizedSha256); assert.equal(value.source.totalLines, 16002);
    assert.equal(budget.evidence().physicalReadBytes, raw.length * 2); assert.equal(budget.evidence().uncertainReadCalls, 0);
    const match = searchProjectText(value.source, 'late verified target', { line: 1, column: 1 }, { maxMatches: 2, maxLines: 20000, contextPoints: 8 });
    assert.equal(match.matches[0]!.range.start.line, 15001);
    const page = pageProjectText(value.source, match.matches[0]!.range.start, { maxBytes: 6144, maxLines: 1 });
    assert.equal(page.text, 'late verified target 314159\n');
  } finally { f.dispose(); }
});

test('project file changes between read slices reject without exposing a mixed snapshot or reading again', async () => {
  const f = fixture();
  try {
    const target = path.join(f.directory, 'changing.txt'); fs.writeFileSync(target, 'alpha\n'.repeat(20000));
    const file = captureProjectReadFile(f.root, 'changing.txt'), abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = createProjectTextReader({ root: f.root, file, expectedVersion: null, signal: abort.signal, budget });
    try {
      assert.equal((await reader.step(createProjectReadOperation(abort.signal, { bytes: 65536 }))).kind, 'pending');
      const before = budget.evidence().physicalReadBytes; fs.appendFileSync(target, 'external synthetic change\n');
      await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), hasCode('SOURCE_CHANGED'));
      assert.equal(budget.evidence().physicalReadBytes, before);
    } finally { await reader.close(); }
  } finally { f.dispose(); }
});

test('project async file read yields to cancellation after real I/O and closes its own handle', async () => {
  const f = fixture();
  try {
    const target = path.join(f.directory, 'cancel.txt'); fs.writeFileSync(target, 'cancel-boundary\n'.repeat(50000));
    const file = captureProjectReadFile(f.root, 'cancel.txt'), abort = new AbortController(), budget = createProjectReadIoBudget();
    let scheduled = false, delivered = false;
    const observed = { ...budget, reserve(bytes: number) {
      const settle = budget.reserve(bytes);
      return (actual: number | null) => { settle(actual); if (actual && !scheduled) { scheduled = true; setImmediate(() => { delivered = true; abort.abort(); }); } };
    } };
    const reader = createProjectTextReader({ root: f.root, file, expectedVersion: null, signal: abort.signal, budget: observed });
    await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), hasCode('CANCELLED'));
    await reader.close(); assert.equal(delivered, true); assert.ok(budget.evidence().physicalReadBytes > 0);
    assert.ok(budget.evidence().physicalReadBytes < file.size * 2);
    fs.renameSync(target, path.join(f.directory, 'closed.txt'));
  } finally { f.dispose(); }
});

test('project file I/O budget, version and encoding failures remain distinct and do not publish text', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.directory, 'plain.txt'), 'abc'); fs.writeFileSync(path.join(f.directory, 'invalid.txt'), new Uint8Array([0xc0, 0xaf]));
    const abort = new AbortController();
    for (const row of [
      { name: 'plain.txt', bytes: 5, version: null, code: 'BUDGET_EXCEEDED' },
      { name: 'plain.txt', bytes: 64, version: '0'.repeat(64), code: 'SOURCE_CHANGED' },
      { name: 'invalid.txt', bytes: 64, version: null, code: 'UNSUPPORTED_ENCODING' },
    ]) {
      const budget = createProjectReadIoBudget(row.bytes), file = captureProjectReadFile(f.root, row.name);
      const reader = createProjectTextReader({ root: f.root, file, expectedVersion: row.version, signal: abort.signal, budget });
      await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), hasCode(row.code)); await reader.close();
      assert.ok(budget.evidence().chargedBytes <= row.bytes);
    }
  } finally { f.dispose(); }
});

test('project file scope rejects traversal, junctions and hard links and detects replaced or missing roots', () => {
  const f = fixture();
  try {
    const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'notes.txt'), 'fixture-only');
    assert.throws(() => captureProjectReadFile(f.root, '../outside/notes.txt'), hasCode('UNSUPPORTED_PATH'));
    fs.symlinkSync(outside, path.join(f.directory, 'linked'), 'junction');
    assert.throws(() => captureProjectReadFile(f.root, 'linked/notes.txt'), hasCode('UNSUPPORTED_PATH'));
    fs.linkSync(path.join(outside, 'notes.txt'), path.join(f.directory, 'alias.txt'));
    assert.throws(() => captureProjectReadFile(f.root, 'alias.txt'), hasCode('UNSUPPORTED_PATH'));
    fs.renameSync(f.directory, path.join(f.base, 'previous-source'));
    assert.throws(() => verifyProjectReadRoot(f.root), hasCode('ROOT_UNAVAILABLE'));
    fs.mkdirSync(f.directory); assert.throws(() => verifyProjectReadRoot(f.root), hasCode('ROOT_CHANGED'));
  } finally { f.dispose(); }
});

test('project file upper boundary completes two actual reads and a larger file is refused before reading', async () => {
  const f = fixture();
  try {
    const target = path.join(f.directory, 'maximum.txt'), raw = Buffer.alloc(16 * 1024 * 1024, 0x61);
    fs.writeFileSync(target, raw);
    const file = captureProjectReadFile(f.root, 'maximum.txt'), abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = createProjectTextReader({ root: f.root, file, expectedVersion: null, signal: abort.signal, budget });
    const result = await reader.step(createProjectReadOperation(abort.signal)); await reader.close();
    assert.equal(result.kind, 'complete');
    if (result.kind !== 'complete') return assert.fail('supported maximum did not complete');
    assert.equal(result.value.source.totalLines, 1); assert.equal(result.value.source.text.length, raw.length);
    assert.ok(result.value.workingBytes <= 64 * 1024 * 1024);
    assert.equal(budget.evidence().physicalReadBytes, 32 * 1024 * 1024);
    assert.equal(pageProjectText(result.value.source, { line: 1, column: raw.length - 3 }, { maxBytes: 6144, maxLines: 200 }).text, 'aaaa');
    const before = budget.evidence(); fs.appendFileSync(target, 'b');
    assert.throws(() => captureProjectReadFile(f.root, 'maximum.txt'), hasCode('FILE_LIMIT')); assert.deepEqual(budget.evidence(), before);
  } finally { f.dispose(); }
});

test('main project binding snapshot reads only existing metadata, clones authority and rejects missing or revoked projects', () => {
  const f = fixture();
  try {
    const workspace = emptyWorkspace(); workspace.projects.push(newProject(f.root.projectId, 'Synthetic project'));
    let present = true;
    const host = createProjectFolderHost({
      store: { load: () => ({ version: 2, bindings: [f.root], creation: null }), save: () => assert.fail('metadata snapshot wrote a store') },
      hasProject: id => present && id === f.root.projectId,
      chooseFolder: async () => assert.fail('metadata snapshot selected a new directory'),
      workspace: { creationSnapshot: () => ({ ok: true, value: workspace }), createProject: () => ({ ok: false, error: { code: 'CAPABILITY_DENIED' } }) },
    });
    fs.renameSync(f.directory, path.join(f.base, 'temporarily-unavailable'));
    const first = host.snapshotBinding(f.root.projectId); assert.equal(first.ok, true);
    if (!first.ok) return assert.fail('stored binding unavailable before explicit root revalidation');
    assert.equal(first.value.name, 'Synthetic project'); first.value.folder.chain[0]!.ino = '999999';
    const second = host.snapshotBinding(f.root.projectId); assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.value.folder.chain[0]!.ino, f.root.chain[0]!.ino);
    present = false; assert.deepEqual(host.snapshotBinding(f.root.projectId), { ok: false, error: { code: 'NOT_BOUND' } });
    host.revoke(); assert.deepEqual(host.snapshotBinding(f.root.projectId), { ok: false, error: { code: 'CAPABILITY_DENIED' } });
  } finally { f.dispose(); }
});

test('project reader independently rejects a forged locator outside its root before any content I/O', async () => {
  const f = fixture();
  try {
    const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'notes.txt'), 'foreign synthetic text');
    const foreignRoot = captureFolderRoot(f.root.projectId, f.root.bindingId, outside);
    const file = captureProjectReadFile(foreignRoot, 'notes.txt'), abort = new AbortController(), budget = createProjectReadIoBudget();
    const reader = createProjectTextReader({ root: f.root, file, expectedVersion: null, signal: abort.signal, budget });
    await assert.rejects(reader.step(createProjectReadOperation(abort.signal)), hasCode('UNSUPPORTED_PATH'));
    await reader.close(); assert.equal(budget.evidence().readCalls, 0); assert.equal(budget.evidence().physicalReadBytes, 0);
  } finally { f.dispose(); }
});
