import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { WorkCycleError, type WorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/types';
import type { WorkCycleImportSource } from '../apps/desktop/src/shared/agent/agent-work-cycle';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hasCode = (code: string) => (error: unknown) => error instanceof WorkCycleError && error.code === code;
function fixture(hooks?: Parameters<typeof createWorkCycleWorkspace>[0]['hooks']) {
  const product = path.resolve(process.cwd());
  assert.equal(product.toLowerCase(), 'c:\\work\\analog_ai_workbench');
  const root = path.join(product, '.local', 'agent-work-cycle-tests', randomUUID());
  assert.equal(fs.existsSync(root), false);
  const workspaceId = `wc-${randomUUID()}`, directory = path.join(root, workspaceId);
  const options = { directory, workspaceId, runId: `run-${randomUUID()}`, readOnly: false,
    signal: new AbortController().signal, ...(hooks ? { hooks } : {}) };
  return { directory, open: () => createWorkCycleWorkspace(options),
    reopen: (readOnly = true) => createWorkCycleWorkspace({ ...options, readOnly, hooks: {}, signal: new AbortController().signal }) };
}
function diskState(directory: string): string[] {
  const result: string[] = [];
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) walk(target);
      else result.push(`${path.relative(directory, target)}:${hash(fs.readFileSync(target))}`);
    }
  }
  walk(directory); return result.sort();
}
async function imported(w: WorkCycleWorkspace, callId: string, bytes: Buffer) {
  const source: WorkCycleImportSource = { projectId: 'security-project', bindingId: 'security-binding',
    identity: hash('synthetic-identity'), fileId: 'security-source', relativePath: 'large.txt', version: hash(bytes), bytes: bytes.length };
  const args = { fileId: source.fileId, version: source.version, relativePath: source.relativePath, expectedVersion: null };
  const result = await w.importFile(callId, args, source, bytes); await w.confirm(callId);
  return { result, source, args };
}

test('C1 edit security: durable receipts bind original tool and arguments across newer versions and history', async t => {
  const f = fixture(); let w = await f.open(); t.diagnostic(`synthetic workspace: ${f.directory}`);
  const importedBytes = Buffer.from('original');
  try {
    const seed = await imported(w, 'original-call', importedBytes);
    const args = { fileId: seed.result.file.fileId, expectedVersion: seed.result.file.version, oldText: 'original', newText: 'first' };
    const beforeCollision = diskState(f.directory);
    await assert.rejects(w.edit('original-call', args), hasCode('CONFLICT'));
    assert.deepEqual(diskState(f.directory), beforeCollision);
    const first = await w.edit('edit-first', args); await w.confirm('edit-first');
    const nextArgs = { ...args, expectedVersion: first.file.version, oldText: 'first', newText: 'latest' };
    const latest = await w.edit('edit-latest', nextArgs); await w.confirm('edit-latest');
    await w.close(); w = await f.reopen(false);
    const currentDisk = diskState(f.directory);
    const replay = await w.edit('edit-first', { newText: args.newText, oldText: args.oldText, expectedVersion: args.expectedVersion, fileId: args.fileId });
    assert.deepEqual(replay, { ...first, file: { ...first.file, confirmation: 'confirmed' } });
    assert.equal(w.read(latest.file.fileId, latest.file.version).text, 'latest');
    await assert.rejects(w.edit('fresh-stale', args), hasCode('CONFLICT'));
    await assert.rejects(w.edit('edit-first', { ...args, newText: 'substituted' }), hasCode('CONFLICT'));
    await assert.rejects(w.write('edit-first', { relativePath: 'large.txt', expectedVersion: args.expectedVersion, text: 'first' }), hasCode('CONFLICT'));
    await assert.rejects(w.importFile('edit-first', seed.args, seed.source, importedBytes), hasCode('CONFLICT'));
    assert.deepEqual(diskState(f.directory), currentDisk);
    await w.close();
    const closedDisk = diskState(f.directory); w = await f.reopen();
    await assert.rejects(w.edit('edit-first', args), hasCode('CAPABILITY_DENIED'));
    assert.equal(w.read(latest.file.fileId, latest.file.version).text, 'latest');
    assert.equal(w.change(first.changeId).before, 'original');
    await w.close(); assert.deepEqual(diskState(f.directory), closedDisk);
  } finally { await w.close(); }
});
