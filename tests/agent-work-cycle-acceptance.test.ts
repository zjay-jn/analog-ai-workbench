import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ProjectReadEvent, ProjectReadSummary } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { WorkCycleFileContent, WorkCycleChange } from '../apps/desktop/src/shared/agent/agent-work-cycle';

// This verifies real normal-chain evidence, never fabricates a host or executes a model program.
// An absent receipt is explicitly NOT_OBSERVED; run this target only after root's normal-chain launch.
const base = path.resolve('C:/work/analog_ai_workbench/.local/quality-evidence/20260913-agent-work-cycle-acceptance-01');
const selected = process.env.AAW_C1_ACCEPTANCE_RECEIPT;
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const read = (p: string): unknown => JSON.parse(fs.readFileSync(p, 'utf8'));
type Completed = Extract<ProjectReadEvent, { type: 'tool.completed' }>;
type Case = { id: string; runId: string; snapshot: { run: ProjectReadSummary; events: ProjectReadEvent[]; completeObservedPageChain: boolean }; files: WorkCycleFileContent[]; changes: WorkCycleChange[] };
type Message = { role: string; content?: string; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
type Request = { sequence: number; runId: string; body: { messages: Message[] } };
type Result = { phase: string; finished: boolean; failure: string | null; closed: boolean; dataRoot: string; dataUuid: string; transport: { syntheticRequests: number; externalRequests: number; inFlight: number; closed: boolean }; nativeStarts: number; nativeReceipts: {pid: number; exited: boolean}[]; cases: {id: string; runId: string}[] };

test('C1 actual normal chain: CSV variation, CAS syntax repair, verified artifacts, stop and cold reopen', { skip: !selected && 'NOT_OBSERVED: set AAW_C1_ACCEPTANCE_RECEIPT to the completed exercise/result.json' }, () => {
  assert(selected); const receipt = path.resolve(selected);
  assert.equal(receipt, path.join(base, 'raw/exercise/result.json'));
  const result = read(receipt) as Result;
  assert.equal(result.phase, 'exercise'); assert(result.finished && result.closed && !result.failure);
  assert.deepEqual(result.transport, { syntheticRequests: 24, externalRequests: 0, inFlight: 0, closed: true });
  assert.equal(result.dataRoot, path.resolve('C:/work/analog_ai_workbench/.local/agent-engine-live-tests', result.dataUuid));
  assert.equal(result.nativeStarts, result.nativeReceipts.length); assert(result.nativeStarts > 0);
  for (const native of result.nativeReceipts) assert(native.pid > 0 && native.exited, 'Real OpenCode process exit must be observed');
  const raw = path.dirname(receipt);
  const requests = fs.readdirSync(raw).filter(n => /^request-\d+\.json$/.test(n)).map(n => read(path.join(raw, n)) as Request).sort((a, b) => a.sequence - b.sequence);
  assert.equal(requests.length, 24);
  const oracle = read(path.join(base, 'oracle.json')) as Record<string, unknown>;
  const outcomes: unknown[] = []; let actualExecutions = 0;
  for (const [caseIndex, id] of ['baseline', 'changed', 'repair'].entries()) {
    const item = read(path.join(raw, id + '-case.json')) as Case;
    assert.equal(item.id, id); assert(item.snapshot.completeObservedPageChain);
    assert.equal(item.snapshot.run.runId, item.runId); assert(item.snapshot.run.workCycle);
    assert.equal(item.snapshot.run.status, 'completed'); assert.equal(item.snapshot.run.cleanupState, 'idle');
    item.snapshot.events.forEach((event, i) => { assert.equal(event.runId, item.runId); assert.equal(event.sequence, i + 1); });
    const completed = item.snapshot.events.filter((e): e is Completed => e.type === 'tool.completed');
    assert(completed.length > 0); const modelRequests = requests.filter(r => r.runId === item.runId);
    assert.equal(modelRequests.length, id === 'repair' ? 9 : 7);
    assert(modelRequests[0]!.body.messages.some(m => m.content?.includes('金额按整数分计算')), 'Actual initial request must carry the fixture rules');
    for (const e of completed) {
      assert(e.data.result.ok, 'Every completed tool in this successful chain must succeed');
      const delivered = modelRequests.find(r => r.body.messages.some(m => m.role === 'tool' && m.tool_call_id === e.data.callId && m.content && JSON.stringify(JSON.parse(m.content)) === JSON.stringify(e.data.result)));
      assert(delivered, 'Actual follow-up model request must contain this exact completed tool result');
      const call = delivered.body.messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === e.data.callId);
      assert(call); assert.equal(call.function.name, e.data.toolName); assert.deepEqual(JSON.parse(call.function.arguments), e.data.arguments);
    }
    for (const file of item.files) {
      assert(file.verified && file.file.confirmation === 'confirmed');
      assert.equal(sha(file.text), file.file.version); assert.equal(Buffer.byteLength(file.text), file.file.bytes);
    }
    const imported = item.files.find(f => f.file.relativePath === 'data.csv'); assert(imported);
    const sourceName = id === 'changed' ? 'measurements-changed.csv' : 'measurements.csv';
    const source = fs.readFileSync(path.join(base, 'fixture/project', sourceName));
    assert.deepEqual(Buffer.from(imported.text), source); assert.equal(imported.file.origin.kind, 'import');
    if (imported.file.origin.kind === 'import') { assert.equal(imported.file.origin.source.version, sha(source)); assert.equal(imported.file.origin.source.relativePath, sourceName); assert.equal(imported.file.origin.source.projectId, item.snapshot.run.project.projectId); }
    const executionEvents = completed.filter(e => e.data.toolName === 'work_run');
    assert.equal(executionEvents.length, id === 'repair' ? 2 : 1); actualExecutions += executionEvents.length;
    for (const [i, event] of executionEvents.entries()) {
      assert(event.data.result.ok && event.data.result.value.kind === 'work_run'); const execution = event.data.result.value.execution;
      assert.equal(execution.isolation, 'windows-appcontainer'); assert.equal(execution.language, 'javascript');
      assert.equal(execution.termination, 'exited'); assert(execution.cleanupConfirmed, 'Job/process cleanup must be confirmed');
      assert.deepEqual(execution.script, event.data.arguments);
      assert(execution.inputs.some(f => f.fileId === execution.script.fileId && f.version === execution.script.version));
      assert(execution.inputs.some(f => f.fileId === imported.file.fileId && f.version === imported.file.version));
      if (id === 'repair' && i === 0) { assert.notEqual(execution.exitCode, 0); assert(execution.stderr.includes('SyntaxError')); assert.equal(execution.artifacts.length, 0); }
      else { assert.equal(execution.exitCode, 0); assert(execution.verified); assert.equal(execution.artifacts.length, 2); for (const file of execution.artifacts) { assert.equal(file.origin.kind, 'execution'); assert(file.relativePath.startsWith('artifacts/' + execution.executionId + '/')); assert(item.files.some(f => f.file.fileId === file.fileId && f.file.version === file.version)); } }
    }
    if (id === 'repair') {
      const failed = executionEvents[0]!; assert(failed.data.result.ok && failed.data.result.value.kind === 'work_run');
      const change = item.changes.find(c => c.file.relativePath === 'analyze.js'); assert(change);
      assert.equal(change.previousVersion, failed.data.result.value.execution.script.version);
      assert(typeof change.before === 'string'); assert(change.before.includes('const deliberateSyntaxFailure = ;')); assert(!change.after.includes('const deliberateSyntaxFailure = ;'));
      assert.equal(sha(change.after), change.file.version); assert.equal(sha(change.before), change.previousVersion);
      const corrected = completed.find(e => e.sequence > failed.sequence && e.data.toolName === 'work_write' && e.data.arguments.expectedVersion === change.previousVersion); assert(corrected);
      assert(executionEvents[1]!.sequence > corrected.sequence);
    }
    const summary = item.files.find(f => f.file.relativePath.endsWith('/summary.json')), report = item.files.find(f => f.file.relativePath.endsWith('/report.md'));
    assert(summary && report); const expected = oracle[id === 'changed' ? 'changed' : 'baseline'];
    const parsed = JSON.parse(summary.text); assert.deepEqual(parsed, expected); outcomes.push(parsed);
    assert(report.text.startsWith('# 分类汇总报告\n')); assert(report.text.includes('空白和 NA'));
    for (const group of (parsed as {groups:{category:string;rowCount:number;numericCount:number;missingCount:number;sumCents:number;meanCents:number}[]}).groups) {
      assert(report.text.includes(`| ${group.category} | ${group.rowCount} | ${group.numericCount} | ${group.missingCount} | ${(group.sumCents / 100).toFixed(2)} | ${(group.meanCents / 100).toFixed(2)} |`));
    }
    assert.equal(result.cases[caseIndex]?.runId, item.runId);
  }
  assert.equal(actualExecutions, 4); assert.notDeepEqual(outcomes[0], outcomes[1]); assert.deepEqual(outcomes[0], outcomes[2]);
  const stopped = read(path.join(raw, 'stop-case.json')) as Case;
  assert.equal(stopped.snapshot.run.status, 'stopped'); assert.equal(stopped.snapshot.run.cleanupState, 'idle'); assert.equal(stopped.files.length, 0);
  assert(!stopped.snapshot.events.some(e => e.type === 'tool.started'));
  const reopened = read(path.join(base, 'raw/reopen/result.json')) as Result;
  assert(reopened.finished && reopened.closed && !reopened.failure); assert.equal(reopened.dataRoot, result.dataRoot);
  assert.equal(reopened.nativeStarts, 0); assert.equal(reopened.transport.syntheticRequests, 0); assert.equal(reopened.transport.externalRequests, 0); assert.equal(reopened.transport.inFlight, 0);
  for (const id of ['baseline', 'changed', 'repair', 'stop']) assert.deepEqual(read(path.join(base, 'raw/reopen', id + '-case.json')), read(path.join(raw, id + '-case.json')));
});
