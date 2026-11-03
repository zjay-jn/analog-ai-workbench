import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WorkCycleContinuationRef, WorkCycleRecovery, WorkCycleRecoveryCommand } from '../../shared/agent/agent-work-cycle';
import { parseWorkCycleContinuationRef } from '../../shared/agent/agent-project-read-validation';
import { parseCommandArguments } from '../../shared/agent/agent-command-validation';
import type { ProjectReadStoredRun } from '../agent-project-read/store';
import type { CommandRecord } from '../agent-command/types';
import { commandRequestSignature, validateCommandRecord } from '../agent-command/state';
import { WorkCycleError, type WorkCycleBaseline } from './types';

const fail = (): never => { throw new WorkCycleError('CLEANUP_FAILED'); };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
export const workRecoveryDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function interruptedWorkController(parent: ProjectReadStoredRun) {
  const run = parent.run, started = run.events.filter(e => e.type === 'run.started');
  if (!run.workCycle || run.status !== 'interrupted' || run.cleanupState !== 'failed'
    || !run.events.some(e => e.type === 'run.interrupted' && e.data.reason === 'restart') || started.length !== 1) return fail();
  const controller = started[0]?.type === 'run.started' ? started[0].data.controller : undefined;
  return controller ?? fail();
}
function commandClaims(parent: ProjectReadStoredRun, commands: readonly WorkCycleRecoveryCommand[]): void {
  const claims = new Map<string, string>(), unresolved = new Set<string>();
  const mutations = new Set(['work_write', 'work_edit', 'work_import', 'work_run']);
  for (const event of parent.run.events) {
    if (event.type === 'tool.started') {
      if (mutations.has(event.data.toolName)) unresolved.add(event.data.callId);
      if (event.data.toolName === 'command_start') {
        const args = parseCommandArguments('command_start', event.data.arguments); if (!args || args.workspaceId !== parent.run.workCycle?.workspaceId) fail();
        const signature = commandRequestSignature(parent.run.runId, args!);
        if (claims.has(args!.requestId) && claims.get(args!.requestId) !== signature) fail();
        claims.set(args!.requestId, signature);
      }
    }
    if (event.type !== 'tool.completed') continue;
    if (mutations.has(event.data.toolName)) {
      // A failed response cannot establish that an interrupted mutation had no effect.
      if (!event.data.result.ok) fail();
      unresolved.delete(event.data.callId);
      if (event.data.result.ok && event.data.result.value.kind === 'work_run' && !event.data.result.value.execution.cleanupConfirmed) fail();
    }
    const result = event.data.result;
    if (result.ok && (result.value.kind === 'command_start' || result.value.kind === 'command_status' || result.value.kind === 'command_stop')) {
      const observed = result.value.execution;
      const command = commands.find(c => c.executionId === observed.executionId);
      if (!command || command.requestId !== observed.requestId || command.signature !== observed.signature || command.revision < observed.revision
        || observed.exit?.shellExited && command.shellExitCode !== observed.exit.shellExitCode
        || observed.cleanup.state === 'confirmed' && command.cleanupProofSha256 !== observed.cleanup.proofSha256) fail();
    }
  }
  if (unresolved.size || claims.size !== commands.length) fail();
  for (const command of commands) if (claims.get(command.requestId) !== command.signature) fail();
}
function version(parent: ProjectReadStoredRun, source: WorkCycleContinuationRef, recovery: Omit<WorkCycleRecovery, 'version'>): string {
  return workRecoveryDigest({ schema: 'aaw.work.interrupted-continuation.v1', project: parent.run.project, root: parent.root,
    status: parent.run.status, cleanupState: parent.run.cleanupState,
    source: { runId: source.runId, workspaceId: source.workspaceId, eventCount: source.eventCount, baselineVersion: source.baselineVersion }, recovery });
}
/** Pure cold-history validation: frozen evidence only, never current mutable command revisions or native I/O. */
export function verifyFrozenWorkRecovery(parent: ProjectReadStoredRun, source: WorkCycleContinuationRef): void {
  const parsed = parseWorkCycleContinuationRef(source), recovery = parsed?.recovery;
  if (!parsed || !recovery || source.runId !== parent.run.runId || source.workspaceId !== parent.run.workCycle?.workspaceId
    || source.eventCount !== parent.run.eventCount || recovery.parentEventsSha256 !== workRecoveryDigest(parent.run.events)) fail();
  const { resultVersion: _result, ...controller } = recovery!.controller;
  if (!isDeepStrictEqual(controller, interruptedWorkController(parent))) fail();
  const { version: expected, ...facts } = recovery!;
  if (version(parent, source, facts) !== expected) fail();
  commandClaims(parent, recovery!.commands);
}
/** Inputs are a byte-verified workspace baseline, validated/log-verified repository, and exact guardian exit proof. */
export function reviewInterruptedWork(parent: ProjectReadStoredRun, baseline: WorkCycleBaseline, records: readonly CommandRecord[], controller: WorkCycleRecovery['controller']): WorkCycleContinuationRef {
  const { resultVersion: _result, ...ref } = controller;
  if (!isDeepStrictEqual(ref, interruptedWorkController(parent)) || baseline.runId !== parent.run.runId || baseline.workspaceId !== parent.run.workCycle?.workspaceId) fail();
  const commands: WorkCycleRecoveryCommand[] = records.map(record => {
    validateCommandRecord(record); const e = record.execution;
    for (const event of parent.run.events) if (event.type === 'tool.completed' && event.data.result.ok) {
      const value = event.data.result.value;
      if ((value.kind === 'command_start' || value.kind === 'command_status' || value.kind === 'command_stop') && value.execution.executionId === e.executionId) {
        const old = value.execution;
        if (old.runId !== e.runId || old.workspaceId !== e.workspaceId || old.revision === e.revision && !isDeepStrictEqual(old, e)
          || old.artifacts.some(a => !e.artifacts.some(b => isDeepStrictEqual(a, b)))) fail();
      }
    }
    if (e.runId !== parent.run.runId || e.workspaceId !== baseline.workspaceId || e.phase !== 'terminal' || e.cleanup.state !== 'confirmed'
      || !e.cleanup.proofSha256 || !e.job.emptyConfirmed || e.job.activeProcesses !== 0 || !e.exit || !e.completedAt
      || !(e.exit.shellExited && e.exit.shellExitCode !== null || e.exit.termination === 'failed_start' && e.startedAt === null)
      || !e.logs.stdout.closed || !e.logs.stderr.closed || e.changes.acceptance !== 'not_requested' || e.changes.state === 'pending') fail();
    const files = baseline.files.filter(({ file }) => file.origin.kind === 'command' && file.origin.executionId === e.executionId);
    if (files.length !== e.artifacts.length) fail();
    for (const artifact of e.artifacts) if (!files.some(({ file }) => file.confirmation === 'confirmed' && file.fileId === artifact.fileId && file.version === artifact.version
      && file.origin.kind === 'command' && file.origin.manifestVersion === e.changes.manifestVersion)) fail();
    return { executionId: e.executionId, requestId: e.requestId, signature: e.signature, revision: e.revision, recordVersion: workRecoveryDigest(record),
      cleanupProofSha256: e.cleanup.proofSha256!, termination: e.exit!.termination, shellExitCode: e.exit!.shellExitCode };
  }).sort((a, b) => a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0);
  for (const { file } of baseline.files) if (file.origin.kind === 'command' && !commands.some(c => c.executionId === (file.origin as {executionId:string}).executionId)) fail();
  const source = { runId: parent.run.runId, workspaceId: baseline.workspaceId, eventCount: parent.run.eventCount, baselineVersion: baseline.version };
  const facts = { parentEventsSha256: workRecoveryDigest(parent.run.events), controller, commands };
  const result = { ...source, recovery: { version: version(parent, source, facts), ...facts } };
  verifyFrozenWorkRecovery(parent, result); return Object.freeze(result);
}
