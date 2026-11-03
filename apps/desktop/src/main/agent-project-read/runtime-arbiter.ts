import type { ProjectReadActiveTask, ProjectReadCleanupState, ProjectReadRunState } from '../../shared/agent/agent-project-read';
import { ProjectReadFsError } from '../cloud/project-read-files';

export type AgentRuntimeResource = Readonly<{ dispose(): void; shutdown(): Promise<void>; canReuse?(): boolean }>;
export type AgentRuntimeLease = Readonly<{ token: symbol }>;
type Held = { lease: AgentRuntimeLease; task: ProjectReadActiveTask | null; projectId: string | null; revoke: () => void };
const fail = (code: 'BUSY' | 'CANCELLED' | 'CLEANUP_FAILED'): never => { throw new ProjectReadFsError(code); };

/** Main-only global admission shared by old calculation tasks, project tasks and explicit inspections. */
export function createAgentRuntimeArbiter() {
  let held: Held | null = null, closed = false, failed = false;
  let cached: { mode: ProjectReadActiveTask['mode']; runtime: AgentRuntimeResource } | null = null;
  let transition: Promise<AgentRuntimeResource> | null = null, shutdown: Promise<void> | null = null;
  const alive = (): void => { if (closed) fail('CANCELLED'); if (failed) fail('CLEANUP_FAILED'); };
  const owns = (lease: AgentRuntimeLease): Held => { alive(); if (!held || held.lease !== lease) return fail('CANCELLED'); return held; };
  const reserve = (task: ProjectReadActiveTask | null, projectId: string | null, revoke: () => void): AgentRuntimeLease => {
    alive(); if (held || transition) return fail('BUSY');
    const lease = Object.freeze({ token: Symbol('agent-runtime-lease') }); held = { lease, task, projectId, revoke }; return lease;
  };
  return Object.freeze({
    reserveRun(task: ProjectReadActiveTask, revoke: () => void): AgentRuntimeLease { return reserve(Object.freeze({ ...task }), task.project?.projectId ?? null, revoke); },
    reserveInspection(projectId: string, revoke: () => void): AgentRuntimeLease { return reserve(null, projectId, revoke); },
    attachConversationScope(lease:AgentRuntimeLease,project:NonNullable<ProjectReadActiveTask['project']>):void{
      const owner=owns(lease);if(owner.task?.mode!=='conversation'||owner.task.project&&owner.task.project.identity!==project.identity)return fail('CANCELLED');
      owner.task=Object.freeze({...owner.task,project});owner.projectId=project.projectId;
    },
    async runtime<T extends AgentRuntimeResource>(lease: AgentRuntimeLease, factory: () => T): Promise<T> {
      const active = owns(lease); if (!active.task) return fail('BUSY');
      const mode = active.task.mode;
      if (transition) return fail('BUSY');
      if (cached?.mode === mode && cached.runtime.canReuse?.() !== false) return cached.runtime as T;
      const operation = (async (): Promise<AgentRuntimeResource> => {
        const previous = cached; cached = null;
        if (previous) {
          let cleanupFailed = false;
          try { previous.runtime.dispose(); } catch { cleanupFailed = true; }
          try { await previous.runtime.shutdown(); } catch { cleanupFailed = true; }
          if (cleanupFailed) { failed = true; return fail('CLEANUP_FAILED'); }
        }
        const owner = owns(lease); if (owner.task && !['preparing', 'running', 'waiting_user'].includes(owner.task.status)) return fail('CANCELLED'); const runtime = factory();
        if (closed || held?.lease !== lease) { runtime.dispose(); await runtime.shutdown(); return fail('CANCELLED'); }
        cached = { mode, runtime }; return runtime;
      })(); transition = operation;
      try { return await operation as T; } finally { if (transition === operation) transition = null; }
    },
    update(lease: AgentRuntimeLease, status: ProjectReadRunState, cleanupState: ProjectReadCleanupState): void {
      const owner = owns(lease); if (!owner.task) return fail('BUSY'); owner.task = Object.freeze({ ...owner.task, status, cleanupState });
    },
    release(lease: AgentRuntimeLease): void {
      const owner = owns(lease); if (transition || owner.task?.cleanupState === 'pending') return fail('BUSY');
      if (owner.task?.cleanupState === 'failed') { failed = true; return fail('CLEANUP_FAILED'); } held = null;
    },
    inspection(projectId: string): boolean { return held !== null && held.task === null && held.projectId === projectId; },
    cancelInspection(projectId: string): void { if (held?.task === null && held.projectId === projectId) held.revoke(); },
    snapshot: (): Readonly<{ busy: boolean; closed: boolean; failed: boolean; activeTask: ProjectReadActiveTask | null }> => Object.freeze({ busy: held !== null || transition !== null, closed, failed, activeTask: held?.task ? Object.freeze({ ...held.task }) : null }),
    close(): Promise<void> {
      if (shutdown) return shutdown; closed = true;
      try { held?.revoke(); } catch { failed = true; }
      const work = (async () => {
        try { await transition; } catch (error) { if (!(error instanceof ProjectReadFsError) || error.code !== 'CANCELLED') failed = true; }
        const current = cached; cached = null;
        if (current) { try { current.runtime.dispose(); } catch { failed = true; } try { await current.runtime.shutdown(); } catch { failed = true; } }
        held = null; if (failed) return fail('CLEANUP_FAILED');
      })(); shutdown = work; void work.catch(() => {}); return work;
    },
  });
}
export type AgentRuntimeArbiter = ReturnType<typeof createAgentRuntimeArbiter>;
