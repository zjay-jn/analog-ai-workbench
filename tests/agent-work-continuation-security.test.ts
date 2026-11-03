import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { WorkCycleError, type WorkCycleSeed } from '../apps/desktop/src/main/agent-work-cycle/types';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hasCode = (code: string) => (error: unknown) => error instanceof WorkCycleError && error.code === code;
function fixture(siblingDirectory?: string) {
  const product = path.resolve(process.cwd());
  assert.equal(product.toLowerCase(), 'c:\\work\\analog_ai_workbench');
  const root = siblingDirectory ? path.dirname(siblingDirectory) : path.join(product, '.local', 'agent-work-cycle-tests', randomUUID());
  if (!siblingDirectory) assert.equal(fs.existsSync(root), false);
  assert.ok(root.startsWith(path.join(product, '.local', 'agent-work-cycle-tests') + path.sep));
  const workspaceId = `wc-${randomUUID()}`, runId = `run-${randomUUID()}`, directory = path.join(root, workspaceId);
  return { directory, runId, workspaceId,
    open: (readOnly = false, seed?: WorkCycleSeed) => createWorkCycleWorkspace({ directory, runId, workspaceId,
      readOnly, signal: new AbortController().signal, ...(seed ? { seed } : {}) }) };
}
function diskState(directory: string): string[] {
  const result: string[] = [];
  function walk(at: string): void {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const target = path.join(at, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) walk(target);
      else result.push(`${path.relative(directory, target)}:${hash(fs.readFileSync(target))}`);
    }
  }
  walk(directory); return result.sort();
}

test('C1 continuation security: hidden unconfirmed history survives reopen and parent receipts never become child authority', async t => {
  const parent = fixture(), child = fixture(parent.directory);
  t.diagnostic(`synthetic parent: ${parent.directory}`); t.diagnostic(`synthetic child: ${child.directory}`);
  let source = await parent.open();
  try {
    const old = await source.write('parent-unconfirmed', { relativePath: 'analysis.js', expectedVersion: null, text: 'const answer = 1;\r\n' });
    const latest = await source.write('parent-latest', { relativePath: 'analysis.js', expectedVersion: old.file.version, text: 'const answer = 2;\r\n' });
    await source.confirm('parent-latest');
    assert.equal(source.list()[0]!.confirmation, 'confirmed');
    assert.equal(source.change(old.changeId).file.confirmation, 'unconfirmed');
    await source.close();
    const rejectedDisk = diskState(parent.directory); source = await parent.open(true);
    await assert.rejects(source.exportConfirmedBase(), hasCode('CONFLICT'));
    await source.close(); assert.deepEqual(diskState(parent.directory), rejectedDisk);
    assert.equal(fs.existsSync(child.directory), false);

    // Resolve this synthetic receipt explicitly; export itself must never repair it.
    source = await parent.open(); await source.confirm('parent-unconfirmed'); await source.close();
    const parentDisk = diskState(parent.directory); source = await parent.open(true);
    const baseline = await source.exportConfirmedBase();
    assert.equal(baseline.runId, parent.runId); assert.equal(baseline.workspaceId, parent.workspaceId);
    assert.equal(baseline.files.length, 1); assert.equal(baseline.files[0]!.file.version, latest.file.version);
    assert.equal(hash(baseline.files[0]!.bytes), latest.file.version);
    await source.close(); assert.deepEqual(diskState(parent.directory), parentDisk);

    const seed: WorkCycleSeed = { source: { runId: baseline.runId, workspaceId: baseline.workspaceId,
      eventCount: 12, baselineVersion: baseline.version }, files: baseline.files };
    const target = await child.open(false, seed);
    try {
      // The host's accepted ledger is outside this module test; only this fresh synthetic owner confirms the seed.
      await target.confirmSeed();
      const inherited = target.list()[0]!;
      assert.notEqual(inherited.fileId, latest.file.fileId);
      assert.equal(inherited.version, latest.file.version);
      assert.deepEqual(inherited.origin, { kind: 'continuation', source: { runId: parent.runId,
        workspaceId: parent.workspaceId, fileId: latest.file.fileId, version: latest.file.version, baselineVersion: baseline.version } });
      assert.throws(() => target.read(latest.file.fileId, latest.file.version), hasCode('CONFLICT'));
      assert.throws(() => target.change(latest.changeId), hasCode('CONFLICT'));
      const edited = await target.edit('parent-latest', { fileId: inherited.fileId, expectedVersion: inherited.version,
        oldText: 'answer = 2', newText: 'answer = 3' });
      assert.equal(edited.kind, 'work_edit'); assert.notEqual(edited.changeId, latest.changeId);
      assert.equal(target.read(edited.file.fileId, edited.file.version).text, 'const answer = 3;\r\n');
      await target.confirm('parent-latest');
      assert.deepEqual(diskState(parent.directory), parentDisk);
      assert.equal(Buffer.from(baseline.files[0]!.bytes).toString('utf8'), 'const answer = 2;\r\n');
    } finally { await target.close(); }
    assert.deepEqual(diskState(parent.directory), parentDisk);
  } finally { await source.close(); }
});
