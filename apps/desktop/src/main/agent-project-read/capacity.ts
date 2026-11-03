import fs from 'node:fs';
import path from 'node:path';
import {runtimePaths} from '../runtime-paths';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TaskCapacity, TaskCapacityBytes, TaskCapacityBlock, TaskCapacityEntry } from '../../shared/agent/agent-task-capacity';
import type { ProjectReadStoredRun } from './store';
import { CAPACITY_LIMITS as L, capacityRelativePath, parseTaskDeletion, type CapacityFile, type CapacityTarget, type CapacityTargetKind, type TaskDeletion } from './capacity-journal';
import { inspectNativePath, nativeRead } from '../agent-command/native-files';
import { createCommandRepository } from '../agent-command/store';
import { commandOutstanding } from '../agent-command/state';
import { inspectWorkCycleReclamationManifest } from '../agent-work-cycle/workspace';
import { WorkCycleError } from '../agent-work-cycle/types';
import type { CommandRecord } from '../agent-command/types';

export type TaskCapacityPaths = Readonly<{
  workspaces?: string; commandRecords?: string; workExecutions?: string; commandExecutions?: string;
}>;
export type TaskCapacitySnapshot = Readonly<{ entry: TaskCapacityEntry; targets: readonly CapacityTarget[] }>;
const errorCode = (e: unknown): unknown => e && typeof e === 'object' && 'code' in e ? e.code : null;
const fail = (code: 'STORAGE_FAILED' | 'CONFLICT' | 'CLEANUP_FAILED' | 'UNSUPPORTED_PATH' = 'STORAGE_FAILED'): never => { throw new WorkCycleError(code); };
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty = (): TaskCapacityBytes => ({ taskBytes: 0, logBytes: 0, workspaceBytes: 0, totalBytes: 0 });
const plainId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u.test(value) && value !== '.' && value !== '..';

function targetPath(paths: TaskCapacityPaths, kind: CapacityTargetKind, id: string): string {
  const product = runtimePaths().storageRoot;
  const root = paths[kind === 'workspace' ? 'workspaces' : kind === 'command_records' ? 'commandRecords' : kind === 'work_execution' ? 'workExecutions' : 'commandExecutions'];
  if (!root || !plainId(id)) return fail('UNSUPPORTED_PATH');
  const base = path.resolve(root), relative = path.relative(product, base).replaceAll('\\', '/');
  // Only application-owned storage trees; a renderer cannot supply any of these roots.
  const suffix = kind === 'workspace' ? '/agent-work-cycle/workspaces' : kind === 'command_records' ? '/agent-command/runs'
    : kind === 'work_execution' ? '/agent-work-cycle-runner/executions' : '/agent-command-runner/executions';
  if (root !== base || !relative.startsWith('.local/') || relative.includes('..') || !('/' + relative).endsWith(suffix)) return fail('UNSUPPORTED_PATH');
  return path.join(base, id);
}
function category(kind: CapacityTargetKind, relative: string): CapacityFile['category'] {
  if (kind === 'command_records') return /(?:^|\/)chunk-[a-f0-9-]{36}\.bin$/u.test(relative) ? 'logBytes' : 'taskBytes';
  if (kind === 'command_execution') return /^control\/(?:stdout|stderr)\.bin$/u.test(relative) ? 'logBytes'
    : relative.startsWith('control/') || relative === 'baseline-manifest.json' ? 'taskBytes' : 'workspaceBytes';
  if (kind === 'work_execution') return relative.startsWith('runtime/') ? 'workspaceBytes' : 'taskBytes';
  return relative.startsWith('objects/') || relative.startsWith('executions/') ? 'workspaceBytes' : 'taskBytes';
}
function fromStat(relativePath: string, kind: CapacityFile['kind'], stat: fs.BigIntStats, owner: CapacityTargetKind): CapacityFile {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return { relativePath, kind, dev: String(stat.dev), ino: String(stat.ino), bytes: kind === 'file' ? Number(stat.size) : 0,
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), category: category(owner, relativePath) };
}
function sameEntry(expected: CapacityFile, actual: CapacityFile): boolean {
  return expected.relativePath === actual.relativePath && expected.kind === actual.kind && expected.dev === actual.dev && expected.ino === actual.ino
    && (expected.kind === 'directory' || expected.bytes === actual.bytes && expected.mtimeNs === actual.mtimeNs && expected.ctimeNs === actual.ctimeNs);
}
function scan(paths: TaskCapacityPaths, kind: CapacityTargetKind, id: string, budget: { count: number; deadline: number }, output: CapacityTarget[]): CapacityTarget {
  const root = targetPath(paths, kind, id), entries: CapacityFile[] = [], target: CapacityTarget = { kind, id, entries }; output.push(target);
  const walk = (relative: string): void => {
    if (++budget.count > L.entries || performance.now() > budget.deadline || !capacityRelativePath(relative)) return fail();
    const file = relative ? path.join(root, ...relative.split('/')) : root;
    let stat: fs.BigIntStats;
    try { stat = fs.lstatSync(file, { bigint: true }); } catch (e) { if (relative === '' && errorCode(e) === 'ENOENT') return; throw e; }
    const directory = stat.isDirectory();
    const before = inspectNativePath(file, directory).stat;
    if (!directory && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)) return fail();
    const entry = fromStat(relative, directory ? 'directory' : 'file', before, kind); entries.push(entry);
    if (directory) {
      const handle = fs.opendirSync(file);
      try { let child: fs.Dirent | null; while ((child = handle.readSync()) !== null) walk(relative ? relative + '/' + child.name : child.name); }
      finally { handle.closeSync(); }
    }
    const after = inspectNativePath(file, directory).stat;
    if (!sameEntry(entry, fromStat(relative, entry.kind, after, kind)) || directory && (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)) return fail('CONFLICT');
  };
  walk(''); return target;
}
function readJson(root: string, relative: string): any {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(nativeRead(path.join(root, ...relative.split('/')), L.jsonBytes)));
}
function executionIds(stored: ProjectReadStoredRun): { work: Set<string>; commands: Set<string> } {
  const work = new Set<string>(), commands = new Set<string>();
  for (const e of stored.run.events) if (e.type === 'tool.completed' && e.data.result.ok) {
    const value = e.data.result.value;
    if (value.kind === 'work_run') work.add(value.execution.executionId);
    if ((value.kind === 'command_start' || value.kind === 'command_status' || value.kind === 'command_stop') && value.execution.runId === stored.run.runId) commands.add(value.execution.executionId);
  }
  return { work, commands };
}
/** A journal can refer only to this task's existing ledger identities and configured roots. */
export function assertTaskDeletionOwner(stored: ProjectReadStoredRun, deletion: TaskDeletion, paths?: TaskCapacityPaths): void {
  if (!parseTaskDeletion(deletion) || deletion.runId !== stored.run.runId || deletion.expectedEventCount !== stored.run.eventCount
    || deletion.workspaceId !== (stored.run.workCycle?.workspaceId ?? null) || stored.run.cleanupState !== 'idle'
    || !['completed','failed','stopped','interrupted'].includes(stored.run.status)) return fail();
  const ids = executionIds(stored);
  for (const t of deletion.targets) if (t.kind === 'work_execution' && !ids.work.has(t.id) || t.kind === 'command_execution' && !ids.commands.has(t.id)) return fail();
  const targets = new Set(deletion.targets.map(t => t.kind + ':' + t.id));
  if ([...ids.work].some(id => !targets.has('work_execution:' + id)) || [...ids.commands].some(id => !targets.has('command_execution:' + id))
    || paths?.commandRecords && !targets.has('command_records:' + stored.run.runId)) return fail();
}

/** No source project, WSL directory, arbitrary orphan, native binary or shared runtime is enumerated here. */
export function inspectTaskCapacity(stored: ProjectReadStoredRun, paths: TaskCapacityPaths, retained: boolean, dependentRunIds: readonly string[], deletion?: TaskDeletion, sharedBudget?: { count: number; deadline: number }): TaskCapacitySnapshot {
  const run = stored.run, targets: CapacityTarget[] = [], budget = sharedBudget ?? { count: 0, deadline: performance.now() + L.scanMs };
  let complete = true, blockedReason: TaskCapacityBlock = retained || ['preparing','running','waiting_user'].includes(run.status) ? 'active'
    : run.cleanupState === 'pending' || !!run.workCycle && run.cleanupState !== 'idle' ? 'cleanup_unconfirmed' : dependentRunIds.length ? 'referenced' : null;
  const unknown = (): void => { blockedReason ??= 'storage_unknown'; };
  try {
    if (deletion) {
      assertTaskDeletionOwner(stored, deletion, paths);
      for (const old of deletion.targets) {
        const actual = scan(paths, old.kind, old.id, budget, targets), byPath = new Map(old.entries.map(e => [e.relativePath, e]));
        if (actual.entries.some(e => !byPath.has(e.relativePath) || !sameEntry(byPath.get(e.relativePath)!, e))) blockedReason ??= 'storage_changed';
      }
    } else if (run.workCycle) {
      const work = scan(paths, 'workspace', run.workCycle.workspaceId, budget, targets), workRoot = targetPath(paths, 'workspace', run.workCycle.workspaceId);
      const ids = executionIds(stored), records = new Map<string, CommandRecord>();
      if (!work.entries.length) { if(!run.origin||run.events.some(e=>e.type==='tool.started'&&/^(work_|command_)/u.test(e.data.toolName)))unknown(); }
      else {
        const state = inspectWorkCycleReclamationManifest(readJson(workRoot, 'workspace.json'), run.runId, run.workCycle.workspaceId);
        if (!state.clear || state.executionIds.some(id => !ids.work.has(id))) unknown();
        for (const id of state.executionIds) ids.work.add(id);
      }
      if (paths.commandRecords) {
        const commands = scan(paths, 'command_records', run.runId, budget, targets);
        if (!commands.entries.length && ids.commands.size) unknown();
        if (commands.entries.length) {
          const repository = createCommandRepository({ directory: targetPath(paths, 'command_records', run.runId), runId: run.runId, readOnly: true });
          try { for (const row of repository.load()) {
            records.set(row.execution.executionId, row);
            if (commandOutstanding(row.execution) || row.execution.workspaceId !== run.workCycle.workspaceId || !ids.commands.has(row.execution.executionId)) unknown();
            ids.commands.add(row.execution.executionId);
          } } finally { repository.close(); }
        }
      } else if (ids.commands.size) unknown();
      for (const id of ids.work) {
        if (!paths.workExecutions) { unknown(); continue; }
        const target = scan(paths, 'work_execution', id, budget, targets);
        if (!target.entries.length) { unknown(); continue; }
        const root = targetPath(paths, 'work_execution', id), intent = readJson(root, 'intent.json'), result = readJson(root, 'result.json');
        if (intent.executionId !== id || intent.snapshot?.executionId !== id || intent.snapshot?.inputDirectory !== path.join(workRoot, 'executions', id, 'input')
          || intent.snapshot?.outputDirectory !== path.join(workRoot, 'executions', id, 'output') || result.executionId !== id || result.signature !== intent.signature
          || result.nonce !== intent.nonce || result.result?.cleanupConfirmed !== true || result.runtimeDisposed !== true) unknown();
      }
      for (const id of ids.commands) {
        if (!paths.commandExecutions) { unknown(); continue; }
        const target = scan(paths, 'command_execution', id, budget, targets);
        if (!target.entries.length) { unknown(); continue; }
        const root = targetPath(paths, 'command_execution', id), intent = readJson(root, 'control/intent.json'), result = readJson(root, 'control/driver-result.json'), record = records.get(id);
        if (!record || intent.record?.execution?.runId !== run.runId || intent.record?.execution?.workspaceId !== run.workCycle.workspaceId || intent.record?.execution?.executionId !== id
          || !isDeepStrictEqual(intent.record?.intent, record.intent) || intent.record?.execution?.signature !== record.execution.signature
          || result.executionId !== id || result.signature !== record.execution.signature || result.nonce !== record.intent.nonce || result.cleanupConfirmed !== true || result.runtimeDisposed !== true
          || createHash('sha256').update(nativeRead(path.join(root, 'control', 'driver-result.json'), L.jsonBytes)).digest('hex') !== record.execution.cleanup.proofSha256) unknown();
      }
      if (targets.some(t => t.entries.some(e => /(?:^|\/)writer\.lock$/u.test(e.relativePath) || e.relativePath === 'runtime'))) unknown();
    }
  } catch (e) { complete = false; blockedReason ??= errorCode(e) === 'CONFLICT' ? 'storage_changed' : 'storage_unknown'; }
  const totals = { ...empty(), taskBytes: Buffer.byteLength(JSON.stringify(stored)) + (deletion ? Buffer.byteLength(JSON.stringify(deletion)) : 0) };
  for (const target of targets) for (const entry of target.entries) if (entry.kind === 'file') totals[entry.category] += entry.bytes;
  totals.totalBytes = totals.taskBytes + totals.logBytes + totals.workspaceBytes;
  const entry: TaskCapacityEntry = { ...totals, runId: run.runId, projectId: run.project.projectId, expectedEventCount: run.eventCount,
    capacityVersion: digest({ stored, deletion: deletion ?? null, targets, complete, blockedReason, dependentRunIds }), complete, canDelete: complete && blockedReason === null,
    blockedReason, dependentRunIds, deletionState: deletion?.state ?? 'none' };
  return { entry, targets };
}
export function taskCapacityReport(entries: readonly TaskCapacityEntry[]): TaskCapacity {
  const totals = { ...empty() }; for (const e of entries) for (const key of ['taskBytes','logBytes','workspaceBytes','totalBytes'] as const) totals[key] += e[key];
  return { runs: entries, totals, complete: entries.every(e => e.complete), measuredAt: new Date().toISOString(), scope: 'tool_tasks', byteMeasure: 'logical_file_bytes' };
}
export function makeTaskDeletion(stored: ProjectReadStoredRun, targets: readonly CapacityTarget[]): TaskDeletion {
  const deletion: TaskDeletion = { runId: stored.run.runId, workspaceId: stored.run.workCycle?.workspaceId ?? null, expectedEventCount: stored.run.eventCount,
    createdAt: new Date().toISOString(), state: 'pending', targets };
  assertTaskDeletionOwner(stored, deletion); return deletion;
}
/** Explicit bounded unlink/rmdir only. Unknown additions/links/replacements stop the transaction. */
export function reclaimTaskStorage(paths: TaskCapacityPaths, deletion: TaskDeletion, hooks?: Readonly<{ beforeUnlink?: (file: string) => void }>): void {
  if (!parseTaskDeletion(deletion)) return fail();
  const budget = { count: 0, deadline: performance.now() + L.scanMs }, actual: CapacityTarget[] = [];
  for (const target of deletion.targets) {
    const current = scan(paths, target.kind, target.id, budget, actual), expected = new Map(target.entries.map(e => [e.relativePath, e]));
    if (current.entries.some(e => !expected.has(e.relativePath) || !sameEntry(expected.get(e.relativePath)!, e))) return fail('CONFLICT');
  }
  for (const target of deletion.targets) {
    const root = targetPath(paths, target.kind, target.id), expected = new Map(target.entries.map(e => [e.relativePath, e]));
    const check = (entry: CapacityFile): string | null => {
      if (performance.now() > budget.deadline) return fail('CLEANUP_FAILED');
      const file = entry.relativePath ? path.join(root, ...entry.relativePath.split('/')) : root;
      // Check each still-existing ancestor against the original inventory before addressing the leaf.
      const parts = entry.relativePath ? entry.relativePath.split('/') : [];
      for (let i = 0; i < parts.length; i++) {
        const relative = parts.slice(0, i).join('/'), ancestor = expected.get(relative); if (!ancestor || ancestor.kind !== 'directory') return fail();
        let stat: fs.BigIntStats; try { stat = inspectNativePath(relative ? path.join(root, ...relative.split('/')) : root, true).stat; }
        catch (e) { if (errorCode(e) === 'ENOENT') return null; throw e; }
        if (!sameEntry(ancestor, fromStat(relative, 'directory', stat, target.kind))) return fail('CONFLICT');
      }
      let stat: fs.BigIntStats; try { stat = inspectNativePath(file, entry.kind === 'directory').stat; }
      catch (e) { if (errorCode(e) === 'ENOENT') return null; throw e; }
      if (!sameEntry(entry, fromStat(entry.relativePath, entry.kind, stat, target.kind))) return fail('CONFLICT'); return file;
    };
    for (const entry of target.entries.filter(e => e.kind === 'file')) {
      const file = check(entry); if (file === null) continue;
      hooks?.beforeUnlink?.(file); if (check(entry) !== file) return fail('CONFLICT');
      fs.unlinkSync(file); try { fs.lstatSync(file); return fail('CLEANUP_FAILED'); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
    }
    for (const entry of [...target.entries].reverse().filter(e => e.kind === 'directory')) {
      const folder = check(entry); if (folder === null) continue;
      if (fs.readdirSync(folder).length) return fail('CONFLICT'); fs.rmdirSync(folder);
    }
    try { fs.lstatSync(root); return fail('CLEANUP_FAILED'); } catch (e) { if (errorCode(e) !== 'ENOENT') throw e; }
  }
}
