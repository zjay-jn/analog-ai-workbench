import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { WORK_CYCLE_LIMITS as L, type WorkCycleImportSource } from '../apps/desktop/src/shared/agent/agent-work-cycle';
import type { WorkCycleRunnerResult, WorkCycleSnapshot, WorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/types';

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const hasCode = (wanted: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === wanted;
const product = path.resolve(process.cwd());
function fixture(hooks?: Parameters<typeof createWorkCycleWorkspace>[0]['hooks']) {
  assert.equal(path.basename(product), 'analog_ai_workbench');
  const fixtureRoot = path.join(product, '.local', 'agent-work-continuation-workspace', randomUUID()), workspaceId = `wc-${randomUUID()}`, directory = path.join(fixtureRoot, 'agent-work-cycle', 'workspaces', workspaceId), abort = new AbortController();
  assert.ok(directory.startsWith(product + path.sep)); assert.equal(fs.existsSync(fixtureRoot), false);
  const options = { directory, workspaceId, runId: `run-${randomUUID()}`, signal: abort.signal, readOnly: false, ...(hooks ? { hooks } : {}) };
  return { fixtureRoot, directory, abort, options, open: () => createWorkCycleWorkspace(options), reopen: (readOnly = true) => createWorkCycleWorkspace({ ...options, signal: new AbortController().signal, readOnly, hooks: {} }) };
}
const goodRun = (snapshot: WorkCycleSnapshot, extra: Partial<WorkCycleRunnerResult> = {}): WorkCycleRunnerResult => ({ executionId: snapshot.executionId, language: 'javascript', isolation: 'windows-appcontainer', termination: 'exited', exitCode: 0, signal: null, durationMs: 12, stdout: 'done\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, cleanupConfirmed: true, ...extra });
async function script(workspace: WorkCycleWorkspace, text = 'console.log("analysis");\n') { const value = await workspace.write('call-script', { relativePath: 'analysis.js', expectedVersion: null, text }); await workspace.confirm('call-script'); return value.file; }
function diskFiles(root: string): string[] { const result: string[] = []; for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const target = path.join(root, entry.name); if (entry.isDirectory()) result.push(...diskFiles(target)); else result.push(`${path.relative(root, target)}:${hash(fs.readFileSync(target))}`); } return result.sort(); }

test('workspace durable create, full-text difference, CAS and exact duplicate receipts', async () => {
  const f = fixture(), w = await f.open();
  try {
    const args = { relativePath: 'notes.md', expectedVersion: null, text: 'before\n' }, first = await w.write('call-1', args);
    assert.equal(first.file.confirmation, 'unconfirmed'); assert.equal(first.file.version, hash(args.text)); assert.equal(fs.existsSync(path.join(f.directory, 'notes.md')), false);
    assert.deepEqual(await w.write('call-1', { text: args.text, expectedVersion: null, relativePath: args.relativePath }), first);
    await assert.rejects(w.write('call-1', { ...args, text: 'different' }), hasCode('CONFLICT'));
    await w.confirm('call-1'); assert.equal(w.list()[0]!.confirmation, 'confirmed');
    const second = await w.write('call-2', { relativePath: args.relativePath, expectedVersion: first.file.version, text: 'after\nsecond\n' });
    const diff = w.change(second.changeId); assert.equal(diff.before, args.text); assert.equal(diff.after, 'after\nsecond\n'); assert.equal(diff.previousVersion, first.file.version); assert.equal(diff.changed, true);
    assert.throws(() => w.read(first.file.fileId, first.file.version), hasCode('CONFLICT')); await assert.rejects(w.write('call-stale', { ...args, expectedVersion: first.file.version }), hasCode('CONFLICT'));
    assert.deepEqual(await w.write('call-1', args), { ...first, file: { ...first.file, confirmation: 'confirmed' } }); assert.equal(w.list()[0]!.version, second.file.version);
    const unchanged = await w.write('call-3', { relativePath: args.relativePath, expectedVersion: second.file.version, text: diff.after }); assert.equal(unchanged.changed, false); await w.confirm('call-2'); assert.equal(w.list()[0]!.confirmation, 'unconfirmed'); assert.equal(w.change(second.changeId).file.confirmation, 'confirmed'); await w.confirm('call-3');
  } finally { await w.close(); }
  const before = diskFiles(f.directory), history = await f.reopen();
  try { assert.equal(history.list()[0]!.confirmation, 'confirmed'); assert.equal(history.read(history.list()[0]!.fileId, history.list()[0]!.version).text, 'after\nsecond\n'); await assert.rejects(history.write('forbidden', { relativePath: 'no.txt', expectedVersion: null, text: 'no' }), hasCode('CAPABILITY_DENIED')); await assert.rejects(history.snapshot('forbidden', { fileId: 'unknown', version: hash('') }), hasCode('CAPABILITY_DENIED')); } finally { await history.close(); }
  assert.deepEqual(diskFiles(f.directory), before);
});

test('workspace rejects path aliases, parent-file conflicts and unsupported or sensitive names', async () => {
  const f = fixture(), w = await f.open(); try {
    for (const relativePath of ['../bad.js', '/bad.js', 'C:/bad.js', 'a\\bad.js', '.git/x.js', 'api.txt', 'COM¹.txt', 'LPT².txt', 'x.txt:stream', 'bad.exe', 'a/b/c/d/e.js', 'name. /x.js', 'artifacts/forged.txt']) await assert.rejects(w.write(`bad-${hash(relativePath)}`, { relativePath, expectedVersion: null, text: 'x' }));
    await w.write('one', { relativePath: 'Dir/a.js', expectedVersion: null, text: 'one' });
    await assert.rejects(w.write('alias', { relativePath: 'dir/b.js', expectedVersion: null, text: 'two' }), hasCode('CONFLICT'));
    await assert.rejects(w.write('parent', { relativePath: 'Dir/a.js/child.js', expectedVersion: null, text: 'two' }), hasCode('CONFLICT'));
    const values = await Promise.allSettled([w.write('race-1', { relativePath: 'same.txt', expectedVersion: null, text: 'one' }), w.write('race-2', { relativePath: 'same.txt', expectedVersion: null, text: 'two' })]); assert.equal(values.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(w.list().length, 2);
  } finally { await w.close(); }
});

test('workspace import preserves exact BOM and CRLF bytes beyond model write limit', async () => {
  const f = fixture(), w = await f.open(), bytes = Buffer.from('\ufeffname,value\r\n' + 'point,12\r\n'.repeat(1500));
  const source: WorkCycleImportSource = { projectId: 'project-1', bindingId: 'binding-1', identity: 'identity-1', fileId: 'signed-file-1', relativePath: 'deep/a/b/c/d/data.csv', version: hash(bytes), bytes: bytes.length };
  const args = { fileId: source.fileId, version: source.version, relativePath: 'data.csv', expectedVersion: null };
  try {
    await assert.rejects(w.write('too-long', { relativePath: 'long.csv', expectedVersion: null, text: bytes.toString('utf8') }), hasCode('FILE_LIMIT'));
    const imported = await w.importFile('import-1', args, source, bytes); assert.equal(imported.file.version, source.version); assert.deepEqual(Buffer.from(w.read(imported.file.fileId, imported.file.version).text), bytes); assert.equal(imported.file.origin.kind, 'import');
    await assert.rejects(w.importFile('wrong-bytes', { ...args, relativePath: 'other.csv' }, source, Buffer.from('forged')), hasCode('SOURCE_CHANGED'));
    await assert.rejects(w.importFile('wrong-source', args, { ...source, fileId: 'other' }, bytes), hasCode('SOURCE_CHANGED'));
    await w.confirm('import-1'); const entry = await script(w), snapshot = await w.snapshot('run-import', { fileId: entry.fileId, version: entry.version }); assert.deepEqual(fs.readFileSync(path.join(snapshot.inputDirectory, 'data.csv')), bytes);
  } finally { await w.close(); }
});

test('workspace enforces UTF8 byte limits and total file admission before publishing', async () => {
  const f = fixture(), w = await f.open(); try {
    const exact = '😀'.repeat(L.writeBytes / 4); await w.write('exact', { relativePath: 'unicode.txt', expectedVersion: null, text: exact });
    await assert.rejects(w.write('large', { relativePath: 'large.txt', expectedVersion: null, text: exact + 'x' }), hasCode('FILE_LIMIT'));
    await assert.rejects(w.write('surrogate', { relativePath: 'invalid.txt', expectedVersion: null, text: '\ud800' }), hasCode('UNSUPPORTED_TEXT'));
    for (let i = 1; i < L.files; i++) await w.write(`file-${i}`, { relativePath: `file-${i}.txt`, expectedVersion: null, text: 'small' });
    await assert.rejects(w.write('over-files', { relativePath: 'overflow.txt', expectedVersion: null, text: 'small' }), hasCode('BUDGET_EXCEEDED')); assert.equal(w.list().length, L.files);
  } finally { await w.close(); }
});

test('workspace snapshots require confirmed versions and accept independently read-back outputs', async () => {
  const f = fixture(), w = await f.open(); try {
    const entry = await w.write('call-script', { relativePath: 'analysis.js', expectedVersion: null, text: 'console.log(1);' });
    await assert.rejects(w.snapshot('run-unconfirmed', { fileId: entry.file.fileId, version: entry.file.version }), hasCode('CONFLICT')); await w.confirm('call-script');
    const snapshot = await w.snapshot('run-1', { fileId: entry.file.fileId, version: entry.file.version }); assert.deepEqual(await w.snapshot('run-1', { version: entry.file.version, fileId: entry.file.fileId }), snapshot);
    fs.writeFileSync(path.join(snapshot.outputDirectory, 'summary.json'), '{"total":42}\n'); fs.mkdirSync(path.join(snapshot.outputDirectory, 'reports')); fs.writeFileSync(path.join(snapshot.outputDirectory, 'reports', 'report.md'), '# Result\n42\n');
    const result = await w.acceptExecution(snapshot, goodRun(snapshot)); assert.equal(result.verified, true); assert.equal(result.artifacts.length, 2); assert.ok(result.artifacts.every(file => file.relativePath.startsWith(`artifacts/${snapshot.executionId}/`) && file.confirmation === 'unconfirmed'));
    assert.equal(w.read(result.artifacts.find(file => file.relativePath.endsWith('summary.json'))!.fileId, hash('{"total":42}\n')).text, '{"total":42}\n'); assert.deepEqual(await w.acceptExecution(snapshot, goodRun(snapshot)), result);
    await assert.rejects(w.acceptExecution(snapshot, goodRun(snapshot, { stdout: 'different' })), hasCode('CONFLICT')); await assert.rejects(w.snapshot('run-1', { fileId: entry.file.fileId, version: entry.file.version }), hasCode('CONFLICT')); await w.confirm('run-1'); assert.ok(w.list().every(file => file.confirmation === 'confirmed')); assert.ok((await w.acceptExecution(snapshot, goodRun(snapshot))).artifacts.every(file => file.confirmation === 'confirmed'));
    await w.close(); const history = await f.reopen(); try { assert.equal(history.list().length, 3); assert.equal(history.list().filter(file => file.origin.kind === 'execution').length, 2); } finally { await history.close(); }
  } finally { await w.close(); }
});

test('workspace never imports output until complete cleanup and successful actual exit', async () => {
  for (const extra of [{ cleanupConfirmed: false }, { exitCode: 1 }, { termination: 'timed_out' as const, exitCode: null }]) {
    const f = fixture(), w = await f.open(); try { const entry = await script(w), snapshot = await w.snapshot('run-failed', { fileId: entry.fileId, version: entry.version }); fs.writeFileSync(path.join(snapshot.outputDirectory, 'result.json'), '{}'); const result = await w.acceptExecution(snapshot, goodRun(snapshot, extra)); assert.equal(result.verified, false); assert.equal(result.artifacts.length, 0); assert.equal(w.list().length, 1); await w.confirm('run-failed'); } finally { await w.close(); }
  }
});

test('workspace rejects changed inputs and forged execution snapshots', async () => {
  const f = fixture(), w = await f.open(); try {
    const entry = await script(w), snapshot = await w.snapshot('run-change', { fileId: entry.fileId, version: entry.version });
    await assert.rejects(w.acceptExecution({ ...snapshot, outputDirectory: f.fixtureRoot }, goodRun(snapshot)), hasCode('CONFLICT'));
    fs.writeFileSync(path.join(snapshot.inputDirectory, 'analysis.js'), 'changed'); await assert.rejects(w.acceptExecution(snapshot, goodRun(snapshot)), hasCode('SOURCE_CHANGED')); assert.equal(w.list().length, 1);
  } finally { await w.close(); }
});

test('workspace binds the original ordinary execution input and output directories', async () => {
  for (const targetKind of ['inputDirectory', 'outputDirectory'] as const) {
    const f = fixture(), w = await f.open(); try { const entry = await script(w), snapshot = await w.snapshot('run-directory', { fileId: entry.fileId, version: entry.version }), target = snapshot[targetKind];
      fs.renameSync(target, target + '-old'); fs.mkdirSync(target); if (targetKind === 'inputDirectory') fs.writeFileSync(path.join(target, 'analysis.js'), w.read(entry.fileId, entry.version).text);
      await assert.rejects(w.acceptExecution(snapshot, goodRun(snapshot)), hasCode('ROOT_CHANGED'));
    } finally { await w.close(); }
  }
});

test('workspace rejects hard links, junctions and unsupported or oversized execution outputs', async () => {
  for (const mode of ['hardlink', 'junction', 'binary', 'large', 'count']) {
    const f = fixture(), w = await f.open(); try {
      const entry = await script(w), snapshot = await w.snapshot('run-invalid', { fileId: entry.fileId, version: entry.version });
      if (mode === 'hardlink') fs.linkSync(path.join(snapshot.inputDirectory, 'analysis.js'), path.join(snapshot.outputDirectory, 'result.js'));
      if (mode === 'junction') { const own = path.join(f.fixtureRoot, 'own-extra'); fs.mkdirSync(own); fs.writeFileSync(path.join(own, 'data.txt'), 'own synthetic data'); fs.symlinkSync(own, path.join(snapshot.outputDirectory, 'linked'), 'junction'); }
      if (mode === 'binary') fs.writeFileSync(path.join(snapshot.outputDirectory, 'result.txt'), Buffer.from([0, 255]));
      if (mode === 'large') fs.writeFileSync(path.join(snapshot.outputDirectory, 'large.txt'), 'x'.repeat(L.fileBytes + 1));
      if (mode === 'count') for (let i = 0; i <= L.artifactsPerExecution; i++) fs.writeFileSync(path.join(snapshot.outputDirectory, `f-${i}.txt`), 'x');
      await assert.rejects(w.acceptExecution(snapshot, goodRun(snapshot))); assert.equal(w.list().length, 1);
    } finally { await w.close(); }
  }
});

test('workspace detects immutable object tampering and refuses a second writable owner', async () => {
  const f = fixture(), w = await f.open(); try {
    const entry = await w.write('call-data', { relativePath: 'data.txt', expectedVersion: null, text: 'original' }); await assert.rejects(f.open(), hasCode('BUSY'));
    const object = fs.readdirSync(path.join(f.directory, 'objects'))[0]!; fs.writeFileSync(path.join(f.directory, 'objects', object), 'modified'); assert.throws(() => w.read(entry.file.fileId, entry.file.version), hasCode('SOURCE_CHANGED'));
  } finally { await w.close(); }
});

test('workspace failure before manifest replace leaves previous version; after replace remains unconfirmed', async () => {
  for (const phase of ['before', 'after']) {
    let inject = false; const f = fixture({ ...(phase === 'before' ? { beforeManifestReplace: () => { if (inject) throw new Error('synthetic failure'); } } : { afterManifestReplace: () => { if (inject) throw new Error('synthetic failure'); } }) }), w = await f.open();
    const first = await w.write('first', { relativePath: 'result.txt', expectedVersion: null, text: 'before' }); await w.confirm('first'); inject = true;
    await assert.rejects(w.write('second', { relativePath: 'result.txt', expectedVersion: first.file.version, text: 'after' }), hasCode('STORAGE_FAILED')); assert.throws(() => w.list(), hasCode('STORAGE_FAILED')); await w.close();
    const history = await f.reopen(); try { const actual = history.list()[0]!; assert.equal(history.read(actual.fileId, actual.version).text, phase === 'before' ? 'before' : 'after'); assert.equal(actual.confirmation, phase === 'before' ? 'confirmed' : 'unconfirmed'); } finally { await history.close(); }
    if (phase === 'after') { const recovered = await f.reopen(false); try { const result = await recovered.write('second', { relativePath: 'result.txt', expectedVersion: first.file.version, text: 'after' }); assert.equal(result.file.confirmation, 'unconfirmed'); await recovered.confirm('second'); assert.equal(recovered.list()[0]!.confirmation, 'confirmed'); } finally { await recovered.close(); } }
  }
});

test('workspace cancellation after publication refuses late success and read-only reopen does not replay', async () => {
  let abort: AbortController; const f = fixture({ afterManifestReplace: () => abort.abort() }); abort = f.abort; const w = await f.open();
  await assert.rejects(w.write('stopped', { relativePath: 'result.txt', expectedVersion: null, text: 'saved but not delivered' }), hasCode('CANCELLED')); await assert.rejects(w.write('late', { relativePath: 'late.txt', expectedVersion: null, text: 'late' }), hasCode('CANCELLED')); await w.close();
  const before = diskFiles(f.directory), history = await f.reopen(); try { assert.equal(history.list().length, 1); assert.equal(history.list()[0]!.confirmation, 'unconfirmed'); } finally { await history.close(); } assert.deepEqual(diskFiles(f.directory), before);
});

test('workspace binds manifest to exact workspace/run identity and cannot create on read-only open', async () => {
  const f = fixture(); await assert.rejects(f.reopen(), hasCode('STORAGE_FAILED')); assert.equal(fs.existsSync(f.directory), false); const w = await f.open(); await w.close();
  await assert.rejects(createWorkCycleWorkspace({ ...f.options, runId: 'another-run', readOnly: true }));
  await assert.rejects(createWorkCycleWorkspace({ ...f.options, directory: f.fixtureRoot, readOnly: true }), hasCode('UNSUPPORTED_PATH'));
});


function continuationChild(f: ReturnType<typeof fixture>, baseline: import('../apps/desktop/src/main/agent-work-cycle/types').WorkCycleBaseline, hooks?: Parameters<typeof createWorkCycleWorkspace>[0]['hooks']) {
  const workspaceId = `wc-${randomUUID()}`, abort = new AbortController(), directory = path.join(path.dirname(f.directory), workspaceId);
  assert.equal(fs.existsSync(directory), false);
  const seed = { source: { runId: baseline.runId, workspaceId: baseline.workspaceId, eventCount: 12, baselineVersion: baseline.version }, files: baseline.files };
  const options = { directory, runId: `run-${randomUUID()}`, workspaceId, signal: abort.signal, readOnly: false, seed, ...(hooks ? { hooks } : {}) };
  return { directory, abort, options, open: () => createWorkCycleWorkspace(options), reopen: (readOnly = true) => {
    const { seed: omitted, hooks: ignored, ...plain } = options;
    return createWorkCycleWorkspace({ ...plain, signal: new AbortController().signal, readOnly });
  } };
}
async function continuationParent() {
  const f = fixture(), w = await f.open(), bytes = Buffer.from('\ufeffconst value = "e\u0301 / é / 😀";\r\nconsole.log(value);\r\n');
  const source: WorkCycleImportSource = { projectId: 'continue-project', bindingId: 'continue-binding', identity: 'continue-identity', fileId: 'continue-source', relativePath: 'analysis.js', version: hash(bytes), bytes: bytes.length };
  await w.importFile('parent-import', { fileId: source.fileId, version: source.version, relativePath: source.relativePath, expectedVersion: null }, source, bytes); await w.confirm('parent-import'); await w.close();
  const parentBytes = diskFiles(f.directory), parent = await f.reopen(), baseline = await parent.exportConfirmedBase(); await parent.close();
  return { f, bytes, parentBytes, baseline };
}

test('workspace continuation preserves closed parent bytes and gates a fresh seed before explicit confirmation', async () => {
  const { f, bytes, parentBytes, baseline } = await continuationParent(), child = continuationChild(f, baseline), w = await child.open();
  try {
    assert.equal(baseline.version, hash(fs.readFileSync(path.join(f.directory, 'workspace.json')))); assert.deepEqual(w.ref.continuation, child.options.seed.source);
    const file = w.list()[0]!; assert.equal(file.confirmation, 'unconfirmed'); assert.equal(file.origin.kind, 'continuation'); assert.deepEqual(Buffer.from(w.read(file.fileId, file.version).text), bytes);
    await assert.rejects(w.write('pending-write', { relativePath: 'new.txt', expectedVersion: null, text: 'blocked' }), hasCode('CONFLICT'));
    await assert.rejects(w.edit('pending-edit', { fileId: file.fileId, expectedVersion: file.version, oldText: 'value', newText: 'other' }), hasCode('CONFLICT'));
    await assert.rejects(w.snapshot('pending-run', { fileId: file.fileId, version: file.version }), hasCode('CONFLICT'));
    await assert.rejects(w.exportConfirmedBase(), hasCode('CONFLICT'));
    await w.confirmSeed(); await w.confirmSeed(); assert.equal(w.list()[0]!.confirmation, 'confirmed');
    const edited = await w.edit('child-edit', { fileId: file.fileId, expectedVersion: file.version, oldText: 'console.log(value);', newText: 'console.log(value.length);' }); await w.confirm('child-edit');
    const diff = w.change(edited.changeId); assert.deepEqual(Buffer.from(diff.before!), bytes); assert.equal(diff.after, bytes.toString('utf8').replace('console.log(value);', 'console.log(value.length);'));
    const manifest = JSON.parse(fs.readFileSync(path.join(child.directory, 'workspace.json'), 'utf8')) as { seed: { files: unknown[]; state: string }; changes: unknown[]; executions: unknown[] };
    assert.equal(manifest.seed.state, 'ready'); assert.equal(manifest.seed.files.length, baseline.files.length); assert.equal(manifest.changes.length, 1); assert.equal(manifest.executions.length, 0);
    const nextBase = await w.exportConfirmedBase(); assert.equal(nextBase.runId, child.options.runId); assert.equal(nextBase.version, hash(fs.readFileSync(path.join(child.directory, 'workspace.json'))));
  } finally { await w.close(); }
  assert.deepEqual(diskFiles(f.directory), parentBytes);
  const childBytes = diskFiles(child.directory), history = await child.reopen();
  try { assert.equal(history.list()[0]!.confirmation, 'confirmed'); assert.deepEqual(history.ref.continuation, child.options.seed.source); } finally { await history.close(); }
  assert.deepEqual(diskFiles(child.directory), childBytes); assert.deepEqual(diskFiles(f.directory), parentBytes);
});

test('workspace continuation rejects copied material, wrong parent, changed bytes and stale manifests before directory creation', async () => {
  const { f, baseline, parentBytes } = await continuationParent();
  for (const change of ['clone', 'parent', 'version', 'directory']) {
    const child = continuationChild(f, baseline), options = { ...child.options };
    if (change === 'clone') options.seed = { ...options.seed, files: structuredClone(baseline.files) };
    if (change === 'parent') options.seed = { ...options.seed, source: { ...options.seed.source, runId: 'different-parent' } };
    if (change === 'version') options.seed = { ...options.seed, source: { ...options.seed.source, baselineVersion: hash('different-version') } };
    if (change === 'directory') options.directory = path.join(f.fixtureRoot, 'different', 'agent-work-cycle', 'workspaces', options.workspaceId);
    await assert.rejects(createWorkCycleWorkspace(options), hasCode('CONFLICT')); assert.equal(fs.existsSync(options.directory), false);
  }
  const child = continuationChild(f, baseline), first = baseline.files[0]!, original = first.bytes[0]!;
  first.bytes[0] = original ^ 1;
  await assert.rejects(child.open(), hasCode('SOURCE_CHANGED')); assert.equal(fs.existsSync(child.directory), false); first.bytes[0] = original;
  const file = first.file as { bytes: number }, length = file.bytes; file.bytes = L.fileBytes + 1;
  await assert.rejects(child.open(), hasCode('INVALID_REQUEST')); assert.equal(fs.existsSync(child.directory), false); file.bytes = length;
  assert.deepEqual(diskFiles(f.directory), parentBytes);
  const manifestPath = path.join(f.directory, 'workspace.json'); fs.appendFileSync(manifestPath, '\n');
  await assert.rejects(child.open(), hasCode('CONFLICT')); assert.equal(fs.existsSync(child.directory), false);
});

test('workspace continuation checks execution confirmation and cleanup even when file heads are confirmed', async () => {
  for (const mode of ['pending', 'unconfirmed', 'cleanup-failed', 'confirmed-failure']) {
    const f = fixture(), w = await f.open();
    try {
      const entry = await script(w), before = await w.exportConfirmedBase(), snapshot = await w.snapshot('parent-execution', { fileId: entry.fileId, version: entry.version });
      if (mode !== 'pending') await w.acceptExecution(snapshot, goodRun(snapshot, { exitCode: 1, cleanupConfirmed: mode !== 'cleanup-failed' }));
      if (mode === 'cleanup-failed' || mode === 'confirmed-failure') await w.confirm('parent-execution');
      assert.ok(w.list().every(file => file.confirmation === 'confirmed'));
      if (mode === 'confirmed-failure') { const after = await w.exportConfirmedBase(); assert.notEqual(after.version, before.version); assert.deepEqual(after.files, before.files); }
      else await assert.rejects(w.exportConfirmedBase(), hasCode(mode === 'cleanup-failed' ? 'CLEANUP_FAILED' : 'CONFLICT'));
    } finally { await w.close(); }
  }
});

test('workspace continuation failed or cancelled preparation cannot seed or activate on reopen', async () => {
  for (const phase of ['before', 'after']) for (const cause of ['failure', 'cancel']) {
    const { f, baseline, parentBytes } = await continuationParent(); let abort: AbortController;
    const interrupt = () => { if (cause === 'cancel') abort.abort(); else throw new Error('synthetic seed interruption'); };
    const child = continuationChild(f, baseline, phase === 'before' ? { beforeManifestReplace: interrupt } : { afterManifestReplace: interrupt }); abort = child.abort;
    await assert.rejects(child.open(), hasCode(cause === 'cancel' ? 'CANCELLED' : 'STORAGE_FAILED'));
    const manifest = JSON.parse(fs.readFileSync(path.join(child.directory, 'workspace.json'), 'utf8')) as { seed: { source: unknown; state: string }; files: unknown[]; changes: unknown[]; executions: unknown[] };
    assert.deepEqual(manifest.seed.source, child.options.seed.source); assert.equal(manifest.seed.state, 'preparing'); assert.equal(manifest.files.length, phase === 'before' ? 0 : baseline.files.length); assert.equal(manifest.changes.length, 0); assert.equal(manifest.executions.length, 0);
    assert.equal(fs.existsSync(path.join(child.directory, 'writer.lock')), false);
    const before = diskFiles(child.directory), history = await child.reopen();
    try { history.list(); await assert.rejects(history.confirmSeed(), hasCode('CAPABILITY_DENIED')); await assert.rejects(history.exportConfirmedBase(), hasCode('CONFLICT')); } finally { await history.close(); }
    assert.deepEqual(diskFiles(child.directory), before);
    const reopened = await child.reopen(false);
    try {
      await assert.rejects(reopened.confirmSeed(), hasCode('CONFLICT'));
      await assert.rejects(reopened.write('late', { relativePath: 'late.txt', expectedVersion: null, text: 'late' }), hasCode('CONFLICT'));
      await assert.rejects(reopened.snapshot('late-run', { fileId: 'unknown-file', version: hash('') }), hasCode('CONFLICT'));
      await assert.rejects(reopened.exportConfirmedBase(), hasCode('CONFLICT'));
    } finally { await reopened.close(); }
    const { hooks: ignored, ...retry } = child.options;
    await assert.rejects(createWorkCycleWorkspace({ ...retry, signal: new AbortController().signal }), hasCode('CONFLICT'));
    assert.deepEqual(diskFiles(child.directory), before); assert.deepEqual(diskFiles(f.directory), parentBytes);
  }
});

test('workspace edit preserves large imported bytes, complete differences and confirmed replay', async () => {
  const f = fixture(), w = await f.open();
  const original = Buffer.from('\ufeff// café 😀\r\n' + '// fixed padding\r\n'.repeat(700) + 'const total = 41;\r\nconsole.log(total);\r\n');
  const src: WorkCycleImportSource = { projectId: 'project-edit', bindingId: 'binding-edit', identity: 'identity-edit', fileId: 'project-file-edit', relativePath: 'analysis.js', version: hash(original), bytes: original.length };
  let editId = '', firstVersion = '', fileId = '';
  try {
    const imported = await w.importFile('edit-import', { fileId: src.fileId, version: src.version, relativePath: 'analysis.js', expectedVersion: null }, src, original);
    await w.confirm('edit-import'); fileId = imported.file.fileId;
    assert.ok(original.length > L.writeBytes);
    await assert.rejects(w.write('edit-whole-rejected', { relativePath: 'analysis.js', expectedVersion: imported.file.version, text: original.toString('utf8').replace('41;', '42;') }), hasCode('FILE_LIMIT'));
    const args = { fileId, expectedVersion: imported.file.version, oldText: 'total = 41;', newText: 'total = 42;' };
    const edited = await w.edit('edit-first', args); editId = edited.changeId; firstVersion = edited.file.version;
    const expected = Buffer.from(original.toString('utf8').replace(args.oldText, args.newText));
    assert.equal(edited.kind, 'work_edit'); assert.equal(edited.file.fileId, imported.file.fileId); assert.equal(edited.file.relativePath, 'analysis.js'); assert.equal(edited.file.origin.kind, 'write');
    assert.equal(edited.file.confirmation, 'unconfirmed'); assert.equal(edited.file.version, hash(expected)); assert.equal(edited.previousVersion, src.version); assert.equal(edited.changed, true);
    assert.deepEqual(Buffer.from(w.read(fileId, edited.file.version).text), expected);
    const diff = w.change(editId); assert.deepEqual(Buffer.from(diff.before!), original); assert.deepEqual(Buffer.from(diff.after), expected);
    assert.deepEqual(await w.edit('edit-first', { newText: args.newText, oldText: args.oldText, expectedVersion: args.expectedVersion, fileId }), edited);
    await assert.rejects(w.edit('edit-first', { ...args, newText: 'total = 99;' }), hasCode('CONFLICT'));
    await assert.rejects(w.write('edit-first', { relativePath: 'analysis.js', expectedVersion: edited.file.version, text: 'collision' }), hasCode('CONFLICT'));
    await assert.rejects(w.snapshot('edit-unconfirmed', { fileId, version: edited.file.version }), hasCode('CONFLICT'));
    await w.confirm('edit-first');
    const snapshot = await w.snapshot('edit-snapshot', { fileId, version: edited.file.version });
    assert.deepEqual(fs.readFileSync(path.join(snapshot.inputDirectory, 'analysis.js')), expected);
    const second = await w.edit('edit-second', { fileId, expectedVersion: edited.file.version, oldText: 'total = 42;', newText: 'total = 43;' });
    assert.equal(second.previousVersion, edited.file.version);
    assert.deepEqual(await w.edit('edit-first', args), { ...edited, file: { ...edited.file, confirmation: 'confirmed' } });
    assert.equal(w.list()[0]!.version, second.file.version);
    await w.confirm('edit-second');
  } finally { await w.close(); }
  const before = diskFiles(f.directory), history = await f.reopen();
  try {
    assert.equal(history.list()[0]!.confirmation, 'confirmed'); assert.equal(history.change(editId).file.version, firstVersion);
    assert.deepEqual(Buffer.from(history.change(editId).before!), original);
    await assert.rejects(history.edit('edit-history', { fileId, expectedVersion: history.list()[0]!.version, oldText: '43;', newText: '44;' }), hasCode('CAPABILITY_DENIED'));
  } finally { await history.close(); }
  assert.deepEqual(diskFiles(f.directory), before);
});

test('workspace edit rejects stale or foreign identity, absent or overlapping matches and malformed arguments without writes', async () => {
  const f = fixture(), other = fixture(), w = await f.open(), foreign = await other.open();
  try {
    const first = await w.write('edit-base', { relativePath: 'notes.txt', expectedVersion: null, text: '\ufeffaaa\r\nliteral $&.*[x] 😀\r\n' });
    const elsewhere = await foreign.write('edit-foreign', { relativePath: 'notes.txt', expectedVersion: null, text: '\ufeffaaa\r\nliteral $&.*[x] 😀\r\n' });
    const args = { fileId: first.file.fileId, expectedVersion: first.file.version, oldText: 'literal', newText: 'exact' }, before = diskFiles(f.directory);
    for (const [suffix, extra, expected] of [
      ['stale', { expectedVersion: hash('stale') }, 'CONFLICT'],
      ['foreign', { fileId: elsewhere.file.fileId }, 'CONFLICT'],
      ['missing', { oldText: 'LITERAL' }, 'CONFLICT'],
      ['overlap', { oldText: 'aa' }, 'CONFLICT'],
      ['empty', { oldText: '' }, 'INVALID_REQUEST'],
      ['null-version', { expectedVersion: null }, 'INVALID_REQUEST'],
      ['extra-path', { relativePath: 'notes.txt' }, 'INVALID_REQUEST'],
      ['surrogate-old', { oldText: '\ud800' }, 'UNSUPPORTED_TEXT'],
      ['surrogate-new', { newText: '\udc00' }, 'UNSUPPORTED_TEXT'],
      ['control', { newText: '\u0000' }, 'UNSUPPORTED_TEXT'],
    ] as const) await assert.rejects(w.edit(`edit-${suffix}`, { ...args, ...extra } as never), hasCode(expected));
    assert.deepEqual(diskFiles(f.directory), before);
    const literal = "$&$`$'\\", exact = await w.edit('edit-literal', { ...args, oldText: '$&.*[x]', newText: literal });
    assert.equal(w.read(first.file.fileId, exact.file.version).text, '\ufeffaaa\r\nliteral ' + literal + ' 😀\r\n');
    const deleted = await w.edit('edit-delete-fragment', { fileId: first.file.fileId, expectedVersion: exact.file.version, oldText: 'literal ', newText: '' });
    assert.equal(w.read(first.file.fileId, deleted.file.version).text, '\ufeffaaa\r\n' + literal + ' 😀\r\n');
  } finally { await w.close(); await foreign.close(); }
});

test('workspace edit admits exact UTF8 difference and result limits while preserving workspace capacity', async () => {
  const f = fixture(), w = await f.open();
  try {
    const oldText = '😀'.repeat(L.editBytes / 8), newText = '界'.repeat(1365) + 'x';
    assert.equal(Buffer.byteLength(oldText) + Buffer.byteLength(newText), L.editBytes);
    const first = await w.write('edit-utf8', { relativePath: 'unicode.txt', expectedVersion: null, text: oldText });
    const args = { fileId: first.file.fileId, expectedVersion: first.file.version, oldText, newText };
    const before = diskFiles(f.directory);
    await assert.rejects(w.edit('edit-byte-over', { ...args, newText: newText + 'x' }), hasCode('INVALID_REQUEST'));
    assert.deepEqual(diskFiles(f.directory), before);
    const edited = await w.edit('edit-byte-exact', args); assert.equal(edited.file.version, hash(newText));
  } finally { await w.close(); }
  const large = fixture(), full = await large.open();
  try {
    const bytes = Buffer.from('x'.repeat(L.fileBytes - 2) + 'A');
    const src: WorkCycleImportSource = { projectId: 'project-limit', bindingId: 'binding-limit', identity: 'identity-limit', fileId: 'source-limit', relativePath: 'large.txt', version: hash(bytes), bytes: bytes.length };
    const imported = await full.importFile('edit-limit-import', { fileId: src.fileId, version: src.version, relativePath: 'large.txt', expectedVersion: null }, src, bytes);
    const exact = await full.edit('edit-file-exact', { fileId: imported.file.fileId, expectedVersion: imported.file.version, oldText: 'A', newText: 'BC' }); assert.equal(exact.file.bytes, L.fileBytes);
    let before = diskFiles(large.directory);
    await assert.rejects(full.edit('edit-file-over', { fileId: exact.file.fileId, expectedVersion: exact.file.version, oldText: 'BC', newText: 'BCD' }), hasCode('FILE_LIMIT'));
    assert.deepEqual(diskFiles(large.directory), before);
    const shrunk = await full.edit('edit-shrink', { fileId: exact.file.fileId, expectedVersion: exact.file.version, oldText: 'BC', newText: 'A' });
    for (let i = 0; i < L.workspaceBytes / L.fileBytes - 1; i++) {
      const filler = Buffer.from('z'.repeat(L.fileBytes)), source = { ...src, fileId: `source-fill-${i}`, relativePath: `fill-${i}.txt`, version: hash(filler), bytes: filler.length };
      await full.importFile(`edit-fill-${i}`, { fileId: source.fileId, version: source.version, relativePath: source.relativePath, expectedVersion: null }, source, filler);
    }
    await full.write('edit-fill-final', { relativePath: 'last.txt', expectedVersion: null, text: 'z' });
    assert.equal(full.list().reduce((n, file) => n + file.bytes, 0), L.workspaceBytes); before = diskFiles(large.directory);
    await assert.rejects(full.edit('edit-workspace-over', { fileId: shrunk.file.fileId, expectedVersion: shrunk.file.version, oldText: 'A', newText: 'BC' }), hasCode('BUDGET_EXCEEDED'));
    assert.deepEqual(diskFiles(large.directory), before);
  } finally { await full.close(); }
});

test('workspace edit shares change budgets and preserves idempotency at the limit', async () => {
  const f = fixture(), w = await f.open();
  try {
    const first = await w.write('edit-budget-base', { relativePath: 'notes.txt', expectedVersion: null, text: 'unique' });
    const args = { fileId: first.file.fileId, expectedVersion: first.file.version, oldText: 'unique', newText: 'unique' };
    let last: Awaited<ReturnType<WorkCycleWorkspace['edit']>> | undefined;
    for (let i = 1; i < L.changes; i++) { last = await w.edit(`edit-budget-${i}`, args); assert.equal(last.changed, false); }
    const before = diskFiles(f.directory);
    await assert.rejects(w.edit('edit-budget-over', args), hasCode('BUDGET_EXCEEDED')); assert.deepEqual(diskFiles(f.directory), before);
    assert.deepEqual(await w.edit(`edit-budget-${L.changes - 1}`, args), last);
    await w.confirm(`edit-budget-${L.changes - 1}`); assert.equal((await w.edit(`edit-budget-${L.changes - 1}`, args)).file.confirmation, 'confirmed');
  } finally { await w.close(); }
});

test('workspace edit refuses execution artifacts and detects immutable object tampering', async () => {
  const f = fixture(), w = await f.open();
  try {
    const entry = await script(w), snapshot = await w.snapshot('edit-artifact-run', { fileId: entry.fileId, version: entry.version });
    fs.writeFileSync(path.join(snapshot.outputDirectory, 'result.txt'), 'fixed artifact');
    const execution = await w.acceptExecution(snapshot, goodRun(snapshot)), artifact = execution.artifacts[0]!, before = diskFiles(f.directory);
    await assert.rejects(w.edit('edit-artifact', { fileId: artifact.fileId, expectedVersion: artifact.version, oldText: 'fixed', newText: 'changed' }), hasCode('UNSUPPORTED_PATH'));
    assert.deepEqual(diskFiles(f.directory), before);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.directory, 'workspace.json'), 'utf8')) as { files: { file: { fileId: string }; object: string }[] };
    const object = manifest.files.find(item => item.file.fileId === entry.fileId)!.object;
    fs.writeFileSync(path.join(f.directory, 'objects', object), 'tampered synthetic input');
    await assert.rejects(w.edit('edit-tampered', { fileId: entry.fileId, expectedVersion: entry.version, oldText: 'analysis', newText: 'changed' }), hasCode('SOURCE_CHANGED'));
  } finally { await w.close(); }
});

test('workspace edit fault recovery keeps prepublication state or the durable unconfirmed receipt', async () => {
  for (const phase of ['before', 'after']) {
    let inject = false;
    const f = fixture(phase === 'before' ? { beforeManifestReplace: () => { if (inject) throw new Error('synthetic edit failure'); } } : { afterManifestReplace: () => { if (inject) throw new Error('synthetic edit failure'); } }), w = await f.open();
    const first = await w.write('edit-fault-base', { relativePath: 'notes.txt', expectedVersion: null, text: 'before' }); await w.confirm('edit-fault-base');
    const args = { fileId: first.file.fileId, expectedVersion: first.file.version, oldText: 'before', newText: 'after' }; inject = true;
    await assert.rejects(w.edit('edit-fault', args), hasCode('STORAGE_FAILED')); assert.throws(() => w.list(), hasCode('STORAGE_FAILED')); await w.close();
    const diskBefore = diskFiles(f.directory), history = await f.reopen();
    try { const file = history.list()[0]!; assert.equal(history.read(file.fileId, file.version).text, phase === 'before' ? 'before' : 'after'); assert.equal(file.confirmation, phase === 'before' ? 'confirmed' : 'unconfirmed'); } finally { await history.close(); }
    assert.deepEqual(diskFiles(f.directory), diskBefore);
    const recovered = await f.reopen(false);
    try { const result = await recovered.edit('edit-fault', args); assert.equal(result.file.confirmation, 'unconfirmed'); assert.equal(recovered.change(result.changeId).before, 'before'); assert.equal(recovered.change(result.changeId).after, 'after'); await recovered.confirm('edit-fault'); assert.equal((await recovered.edit('edit-fault', args)).file.confirmation, 'confirmed'); } finally { await recovered.close(); }
  }
});

test('workspace edit cancellation before or after publication refuses late success without replay', async () => {
  for (const phase of ['before', 'after']) {
    let inject = false, abort: AbortController;
    const stop = () => { if (inject) abort.abort(); };
    const f = fixture(phase === 'before' ? { beforeManifestReplace: stop } : { afterManifestReplace: stop }); abort = f.abort;
    const w = await f.open(), first = await w.write('edit-cancel-base', { relativePath: 'notes.txt', expectedVersion: null, text: 'before' }); await w.confirm('edit-cancel-base');
    const args = { fileId: first.file.fileId, expectedVersion: first.file.version, oldText: 'before', newText: 'after' }; inject = true;
    await assert.rejects(w.edit('edit-cancel', args), hasCode('CANCELLED')); await assert.rejects(w.edit('edit-cancel-late', args), hasCode('CANCELLED')); await w.close();
    const before = diskFiles(f.directory), history = await f.reopen();
    try { const file = history.list()[0]!; assert.equal(history.read(file.fileId, file.version).text, phase === 'before' ? 'before' : 'after'); assert.equal(file.confirmation, phase === 'before' ? 'confirmed' : 'unconfirmed'); } finally { await history.close(); }
    assert.deepEqual(diskFiles(f.directory), before);
  }
});
