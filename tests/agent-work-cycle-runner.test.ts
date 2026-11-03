import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { createWindowsWorkCycleRunner, createWorkCycleRunner, createWorkCycleRunnerForTests, parseWorkCycleNativeReport, WORK_CYCLE_RUNNER_IDENTITY } from '../apps/desktop/src/main/agent-work-cycle/runner';
import { WORK_CYCLE_LIMITS as L } from '../apps/desktop/src/shared/agent/agent-work-cycle';
import { PROJECT_READ_LIMITS as P } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { WorkCycleSnapshot } from '../apps/desktop/src/main/agent-work-cycle/types';

const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const code = (wanted: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === wanted;
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
class ProcessStub extends EventEmitter {
  pid = 424242; stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kills = 0; commands: string[] = [];
  constructor() { super(); this.stdin.on('data', (data: Buffer) => this.commands.push(data.toString('utf8'))); }
  kill() { this.kills++; return true; }
  finish(value: unknown, exit = 0) { this.stdout.write(JSON.stringify(value)); this.stdout.end(); this.stderr.end(); this.emit('close', exit, null); }
}
const report = (executionId: string, signature: string, extra: Record<string, unknown> = {}) => ({ version: 1, executionId, signature, termination: 'exited', exitCode: 0, durationMs: 7, stdoutHex: Buffer.from('42\n').toString('hex'), stderrHex: '', stdoutTruncated: false, stderrTruncated: false, cleanupConfirmed: true, appContainer: true, capabilityCount: 0, atomicJob: true, lowIntegrity: true, profileDeleted: true, aclRestored: true, activeProcesses: 0, ...extra });
function fixture(hooks: Pick<Parameters<typeof createWorkCycleRunnerForTests>[0], 'beforePrepare' | 'beforeResult'> = {}) {
  const product = path.resolve(process.cwd()); assert.equal(path.basename(product), 'analog_ai_workbench');
  const directory = path.join(product, '.local', 'agent-work-cycle-runner-tests', randomUUID()); assert.ok(directory.startsWith(product + path.sep)); assert.equal(fs.existsSync(directory), false); fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'source'); fs.mkdirSync(source); const runtime = path.join(source, 'node.exe'), native = path.join(source, 'runner.exe'), proof = path.join(source, 'proof.json');
  fs.writeFileSync(runtime, 'MOCK NODE'); fs.writeFileSync(path.join(source, 'LICENSE'), 'MOCK LICENSE'); fs.writeFileSync(native, 'MOCK NATIVE');
  const proofText = JSON.stringify({ status: 'PASS', nativeSha256: hash('MOCK NATIVE'), runtimeSha256: hash('MOCK NODE'), appContainer: true, capabilityCount: 0, atomicJob: true, cleanupConfirmed: true, aclRestored: true, profileDeleted: true }); fs.writeFileSync(proof, proofText);
  const identity = { version: WORK_CYCLE_RUNNER_IDENTITY.version, runtime, runtimeBytes: 9, runtimeSha256: hash('MOCK NODE'), licenseSha256: hash('MOCK LICENSE'), native, nativeSha256: hash('MOCK NATIVE'), proof, proofSha256: hash(proofText) };
  const executionId = `wce-${randomUUID()}`, parent = path.join(directory, 'snapshots', executionId), inputDirectory = path.join(parent, 'input'), outputDirectory = path.join(parent, 'output'); fs.mkdirSync(inputDirectory, { recursive: true }); fs.mkdirSync(outputDirectory);
  const program = 'console.log(42);\n', version = hash(program); fs.writeFileSync(path.join(inputDirectory, 'analysis.js'), program);
  const snapshot: WorkCycleSnapshot = { executionId, inputDirectory, outputDirectory, scriptRelativePath: 'analysis.js', script: { fileId: 'file-script', version }, inputs: [{ fileId: 'file-script', relativePath: 'analysis.js', version, bytes: Buffer.byteLength(program) }] };
  const removed = new Set<string>(), removals: { kind: 'unlink' | 'rmdir'; path: string }[] = [], ready = defer(), spawns: { program: string; args: string[]; options: SpawnOptionsWithoutStdio; child: ProcessStub }[] = [];
  // This removal dependency never deletes real fixture data. It models the observed operations only.
  const removal = { exists: (name: string) => !removed.has(name) && fs.existsSync(name), entries: (name: string) => fs.readdirSync(name).filter(entry => !removed.has(path.join(name, entry))), unlink: (name: string) => { removals.push({ kind: 'unlink', path: name }); removed.add(name); }, rmdir: (name: string) => { removals.push({ kind: 'rmdir', path: name }); removed.add(name); } };
  const spawn = (program: string, args: string[], options: SpawnOptionsWithoutStdio) => { const child = new ProcessStub(); spawns.push({ program, args, options, child }); ready.resolve(); return child as unknown as ChildProcessWithoutNullStreams; };
  const options = { directory, identity, spawn, removal, ...hooks };
  return { directory, identity, snapshot, program, spawns, removals, removed, options, ready: ready.promise, open: () => createWorkCycleRunnerForTests(options) };
}

test('runner stays unavailable with absent mock native/proof pins', async () => {
  assert.equal(createWorkCycleRunner, createWindowsWorkCycleRunner);
  const f = fixture(), runner = createWorkCycleRunnerForTests({ ...f.options, identity: { ...f.identity, nativeSha256: null, proofSha256: null } });
  assert.deepEqual(runner.available(), { available: false, language: 'javascript', isolation: 'windows-appcontainer' });
  await assert.rejects(runner.run(f.snapshot, new AbortController().signal), code('ENGINE_FAILED'));
  assert.equal(f.spawns.length, 0); assert.equal(f.removals.length, 0); assert.equal(fs.existsSync(path.join(f.directory, 'executions')), false);
  await runner.close(); assert.equal(runner.available().available, false);
});

test('runner strictly parses 18 native keys, actual values, cleanup proof and UTF8 log boundaries', () => {
  const executionId = `wce-${randomUUID()}`, signature = hash('snapshot'), good = report(executionId, signature), result = parseWorkCycleNativeReport(good, executionId, signature);
  assert.equal(result.stdout, '42\n'); assert.equal(result.exitCode, 0); assert.equal(result.cleanupConfirmed, true);
  for (const bad of [{ ...good, extra: true }, { ...good, executionId: 'foreign' }, { ...good, signature: hash('other') }, { ...good, cleanupConfirmed: 'true' }, { ...good, exitCode: null }, { ...good, durationMs: -0 }, { ...good, stdoutHex: 'ff' }, { ...good, stdoutHex: 'a' }, { ...good, stdoutHex: '61'.repeat(L.logBytes + 1) }]) assert.throws(() => parseWorkCycleNativeReport(bad, executionId, signature));
  const partial = Buffer.concat([Buffer.from('x'.repeat(L.logBytes - 1)), Buffer.from([0xe2])]); const clipped = parseWorkCycleNativeReport({ ...good, stdoutHex: partial.toString('hex'), stdoutTruncated: true }, executionId, signature); assert.equal(clipped.stdout, 'x'.repeat(L.logBytes - 1)); assert.equal(clipped.stdout.includes('\ufffd'), false);
  assert.equal(parseWorkCycleNativeReport({ ...good, activeProcesses: 1 }, executionId, signature).cleanupConfirmed, false);
  assert.equal(parseWorkCycleNativeReport({ ...good, atomicJob: false }, executionId, signature).termination, 'isolation_failed');
});

test('runner binds positional CLI, exact bytes and durable result; mock cleanup targets only three owned files', async () => {
  const f = fixture(), runner = f.open(); assert.equal(runner.available().available, true); const pending = runner.run(f.snapshot, new AbortController().signal); await f.ready; const call = f.spawns[0]!;
  assert.equal(call.program, f.identity.native); assert.deepEqual(call.args.slice(2, 5), [f.snapshot.inputDirectory, f.snapshot.outputDirectory, f.snapshot.executionId]); assert.equal(call.args[7], f.snapshot.scriptRelativePath); assert.equal(call.args[8], f.snapshot.script.version); assert.equal(call.args[9], `${f.snapshot.script.version}:${Buffer.byteLength(f.program)}:analysis.js`); assert.match(call.args[6]!, /^[0-9a-f]{32}$/u);
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true); assert.deepEqual(Object.keys(call.options.env!).sort(), ['SystemDrive', 'SystemRoot', 'windir']); assert.equal(fs.readFileSync(path.join(call.args[1]!, 'program.cjs'), 'utf8'), f.program);
  call.child.finish(report(f.snapshot.executionId, call.args[5]!)); const result = await pending; assert.equal(result.stdout, '42\n'); assert.equal(result.cleanupConfirmed, true); assert.equal(f.removals.length, 4); assert.deepEqual(f.removals.filter(item => item.kind === 'unlink').map(item => path.basename(item.path)), ['node.exe', 'LICENSE', 'program.cjs']); assert.ok(f.removals.every(item => item.path === call.args[1] || path.dirname(item.path) === call.args[1]));
  assert.equal(fs.existsSync(path.join(call.args[1]!, 'node.exe')), true, 'removal mock leaves the small fixture physically intact'); assert.equal(fs.readFileSync(f.identity.runtime, 'utf8'), 'MOCK NODE'); assert.ok(fs.existsSync(path.join(call.args[0]!, 'result.json'))); await runner.close();
});

test('runner concurrent/reopened duplicate execution reuses one durable result without a second spawn', async () => {
  const f = fixture(), runner = f.open(), signal = new AbortController().signal, one = runner.run(f.snapshot, signal), two = runner.run(structuredClone(f.snapshot), signal); await f.ready; const call = f.spawns[0]!; call.child.finish(report(f.snapshot.executionId, call.args[5]!)); const result = await one; assert.deepEqual(await two, result); assert.equal(f.spawns.length, 1); await runner.close();
  const reopened = f.open(); assert.deepEqual(await reopened.run(f.snapshot, signal), result); assert.equal(f.spawns.length, 1); assert.equal(f.removals.length, 4);
  const receiptPath = path.join(call.args[0]!, 'result.json'), receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); receipt.result.unexpected = true; fs.writeFileSync(receiptPath, JSON.stringify(receipt)); await assert.rejects(reopened.run(f.snapshot, signal)); assert.equal(f.spawns.length, 1); await reopened.close();
});

test('runner preparation stop blocks launch, consumes intent, and close waits through result persistence', async () => {
  const prepareEntered = defer(), prepareRelease = defer(), resultEntered = defer(), resultRelease = defer();
  const f = fixture({ beforePrepare: async () => { prepareEntered.resolve(); await prepareRelease.promise; }, beforeResult: async () => { resultEntered.resolve(); await resultRelease.promise; } }), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal);
  await prepareEntered.promise; const secondOwner = f.open(); await assert.rejects(secondOwner.run(f.snapshot, new AbortController().signal), code('CLEANUP_FAILED')); await secondOwner.close();
  let closed = false; const closing = runner.close().then(() => { closed = true; }); prepareRelease.resolve(); await resultEntered.promise; assert.equal(closed, false); assert.equal(f.spawns.length, 0); resultRelease.resolve(); const result = await pending; await closing; assert.equal(result.termination, 'cancelled'); assert.equal(result.cleanupConfirmed, true); assert.equal(f.removals.length, 0);
  assert.ok(fs.existsSync(path.join(f.directory, 'executions', f.snapshot.executionId, 'result.json'))); await assert.rejects(runner.run(f.snapshot, new AbortController().signal), code('CANCELLED'));
});

test('runner AbortSignal sends C and never returns late successful termination', async () => {
  const f = fixture(), runner = f.open(), abort = new AbortController(), pending = runner.run(f.snapshot, abort.signal); await f.ready; const call = f.spawns[0]!; abort.abort(); assert.deepEqual(call.child.commands, ['C']); call.child.finish(report(f.snapshot.executionId, call.args[5]!)); const result = await pending; assert.equal(result.termination, 'cancelled'); assert.equal(result.exitCode, 0); assert.equal(result.cleanupConfirmed, true); await runner.close();
});

test('runner close after native exit still waits for durable result and suppresses late delivery', async () => {
  const entered = defer(), release = defer(), f = fixture({ beforeResult: async () => { entered.resolve(); await release.promise; } }), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal); await f.ready; const call = f.spawns[0]!; call.child.finish(report(f.snapshot.executionId, call.args[5]!)); await entered.promise;
  let closed = false; const closing = runner.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false); release.resolve(); assert.equal((await pending).termination, 'cancelled'); await closing; assert.ok(fs.existsSync(path.join(call.args[0]!, 'result.json')));
});

test('runner wire/stderr overflow cannot accept a buffered successful report or clean resources', async () => {
  for (const channel of ['stdout', 'stderr'] as const) {
    const f = fixture(), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal); await f.ready; const call = f.spawns[0]!; call.child.stdout.write(JSON.stringify(report(f.snapshot.executionId, call.args[5]!))); call.child[channel].write(Buffer.alloc(channel === 'stdout' ? 16385 : 4097)); call.child.emit('close', 0, null); const result = await pending;
    assert.equal(result.termination, 'limit'); assert.equal(result.cleanupConfirmed, false); assert.equal(f.removals.length, 0); assert.equal(runner.available().available, false); await assert.rejects(runner.close(), code('CLEANUP_FAILED'));
  }
});

test('runner watchdog and bounded kill use virtual time and retain uncertain cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1789280000000 });
  const f = fixture(), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal); await f.ready; const call = f.spawns[0]!;
  t.mock.timers.tick(L.nativeCallMs - L.cleanupMs); assert.deepEqual(call.child.commands, ['C']); assert.equal(call.child.kills, 0); t.mock.timers.tick(L.cleanupMs); const result = await pending; assert.equal(call.child.kills, 1); assert.equal(result.cleanupConfirmed, false); assert.equal(f.removals.length, 0); await assert.rejects(runner.close(), code('CLEANUP_FAILED'));
});

test('runner outer watchdog cannot be turned into success by a late exited report', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1789280000000 });
  const f = fixture(), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal); await f.ready; const call = f.spawns[0]!;
  t.mock.timers.tick(L.nativeCallMs - L.cleanupMs); call.child.finish(report(f.snapshot.executionId, call.args[5]!)); const result = await pending;
  assert.equal(result.termination, 'timed_out'); assert.equal(result.exitCode, 0); assert.equal(result.cleanupConfirmed, true); await runner.close();
});

test('runner rechecks native identity after preparation before allowing spawn', async () => {
  const entered = defer(), release = defer(), f = fixture({ beforePrepare: async () => { entered.resolve(); await release.promise; } }), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal);
  await entered.promise; fs.writeFileSync(f.identity.native, 'changed mock native'); release.resolve(); const result = await pending;
  assert.equal(f.spawns.length, 0); assert.equal(result.termination, 'isolation_failed'); assert.equal(result.cleanupConfirmed, true); assert.equal(f.removals.length, 4); await runner.close();
});

test('runner requires cleanup proof and unchanged owned copies before any mock unlink', async () => {
  for (const kind of ['unrestored', 'changed-copy', 'malformed']) {
    const f = fixture(), runner = f.open(), pending = runner.run(f.snapshot, new AbortController().signal); await f.ready; const call = f.spawns[0]!;
    if (kind === 'changed-copy') fs.writeFileSync(path.join(call.args[1]!, 'node.exe'), 'changed mock copy');
    call.child.finish(report(f.snapshot.executionId, call.args[5]!, kind === 'unrestored' ? { aclRestored: false } : kind === 'malformed' ? { additionalField: 'rejected' } : {})); const result = await pending;
    assert.equal(result.cleanupConfirmed, false); assert.equal(f.removals.length, 0); await assert.rejects(runner.close(), code('CLEANUP_FAILED'));
  }
});

test('runner checks exact input membership and pinned sources before preparing an execution', async () => {
  const f = fixture(), runner = f.open(); await assert.rejects(runner.run({ ...f.snapshot, scriptRelativePath: 'analysis.JS' }, new AbortController().signal), code('INVALID_REQUEST')); fs.writeFileSync(path.join(f.snapshot.inputDirectory, 'undeclared.txt'), 'extra synthetic data'); await assert.rejects(runner.run(f.snapshot, new AbortController().signal), code('CONFLICT')); assert.equal(f.spawns.length, 0); assert.equal(fs.existsSync(path.join(f.directory, 'executions')), false); await runner.close();
  const g = fixture(), other = g.open(); fs.writeFileSync(g.identity.runtime, 'changed mock runtime'); assert.equal(other.available().available, false); await assert.rejects(other.run(g.snapshot, new AbortController().signal), code('ENGINE_FAILED')); assert.equal(g.spawns.length, 0); await other.close();
});

test('runner applies bounded retained receipt admission without launching or removing old directories', async () => {
  const f = fixture(), executions = path.join(f.directory, 'executions'); fs.mkdirSync(executions); for (let i = 0; i < P.runs * L.executions; i++) fs.mkdirSync(path.join(executions, `wce-${randomUUID()}`));
  const runner = f.open(); assert.equal(runner.available().available, false); await assert.rejects(runner.run(f.snapshot, new AbortController().signal), code('BUDGET_EXCEEDED')); assert.equal(f.spawns.length, 0); assert.equal(f.removals.length, 0); await runner.close();
});
