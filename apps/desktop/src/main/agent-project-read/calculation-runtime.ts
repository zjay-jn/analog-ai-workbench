import type { PilotEngine } from '../engine-pilot/engine';
import { OpenCodePilotError } from '../engine-pilot/opencode-client';
import type { AgentRuntimeArbiter, AgentRuntimeLease, AgentRuntimeResource } from './runtime-arbiter';

type Candidate = { engine: PilotEngine; retired: boolean; resource: AgentRuntimeResource };
type Run = { runId: string; lease: AgentRuntimeLease; candidate: Candidate; abort: AbortController; status: 'preparing' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'stopped'; job?: Promise<void>; cleanup?: Promise<void> };
const fail = (): never => { throw new OpenCodePilotError(); };

/** Keeps the legacy API/history while sharing project-task admission and rebuilding retired calculation runtimes. */
export function createArbitratedCalculationRuntime(options: Readonly<{ arbiter: AgentRuntimeArbiter; create: () => PilotEngine }>): PilotEngine {
  let disposed = false, candidate: Candidate | null = null, active: Run | null = null, shutdown: Promise<void> | undefined;
  const resources = new Set<Candidate>();
  const cold = (): Candidate => {
    if (disposed) return fail(); if (candidate && !candidate.retired) return candidate;
    const engine = options.create();
    const next: Candidate = { engine, retired: false, resource: { dispose() { next.retired = true; engine.dispose(); }, async shutdown() { try { await engine.shutdown?.(); } finally { resources.delete(next); } }, canReuse: () => !next.retired } };
    candidate = next; resources.add(next); return next;
  };
  const release = (run: Run, failed: boolean): void => {
    options.arbiter.update(run.lease, failed ? 'failed' : run.status, failed ? 'failed' : 'idle');
    if (!failed) { options.arbiter.release(run.lease); if (active === run) active = null; }
  };
  function stop(runId: string): Promise<void> {
    const run = active; if (!run || run.runId !== runId) return Promise.resolve(); if (run.cleanup) return run.cleanup;
    run.abort.abort(); if (!['completed', 'failed'].includes(run.status)) run.status = 'stopped';
    try { options.arbiter.update(run.lease, run.status, 'pending'); } catch {}
    const stopping = run.candidate.engine.stop(runId); void stopping.catch(() => {});
    run.cleanup = (async () => { let failed = false; try { await stopping; } catch { failed = true; } try { await run.job; } catch { /* The stop/cleanup result determines native resource ownership. */ } release(run, failed); if (failed) return fail(); })();
    void run.cleanup.catch(() => {}); return run.cleanup;
  }
  return {
    kind: 'opencode', version: '1.18.17',
    liveStatus() {
      if (disposed) return { canStart: false, processState: 'failed', availability: 'unavailable' };
      const value = cold().engine.liveStatus?.() ?? { canStart: false, processState: 'failed' as const, availability: 'unavailable' as const };
      const shared = options.arbiter.snapshot(); return shared.busy || shared.closed || shared.failed ? { ...value, canStart: false, availability: 'unavailable' } : value;
    },
    health: async () => !disposed && !options.arbiter.snapshot().busy && (cold().engine.liveStatus?.().canStart ?? false),
    executionLimits: () => cold().engine.executionLimits?.() ?? { deadlineMs: 4800000, waitMs: 1800000 },
    accept(runId, model) {
      if (disposed || active) return fail(); const abort = new AbortController(), lease = options.arbiter.reserveRun({ mode: 'calculation', runId, project: null, status: 'preparing', cleanupState: 'idle' }, () => abort.abort());
      try { const selected = cold(), accepted = selected.engine.accept?.(runId, model); if (!accepted) return fail(); active = { runId, lease, candidate: selected, abort, status: 'preparing' }; return accepted; }
      catch (error) { options.arbiter.release(lease); throw error; }
    },
    start(input) {
      const run = active; if (disposed || !run || run.runId !== input.runId || run.job || run.abort.signal.aborted) return fail();
      const aborted = () => run.abort.abort(); input.signal.addEventListener('abort', aborted, { once: true }); if (input.signal.aborted) aborted();
      const job = (async () => {
        try {
          await options.arbiter.runtime(run.lease, () => run.candidate.resource); if (disposed || run.abort.signal.aborted) return;
          await run.candidate.engine.start({ ...input, signal: run.abort.signal, callbacks: { ...input.callbacks, notice(event) {
            if (run.abort.signal.aborted || run.cleanup) return;
            if (event.type === 'started') run.status = 'running'; else if (event.type === 'question') run.status = 'waiting_user'; else if (event.type === 'completed') run.status = 'completed'; else if (event.type === 'failed') run.status = 'failed';
            try { options.arbiter.update(run.lease, run.status, event.type === 'failed' ? 'pending' : 'idle'); } catch {}
            input.callbacks.notice(event);
          } } });
        } finally { input.signal.removeEventListener('abort', aborted); }
      })(); run.job = job;
      void job.then(() => { if (!run.cleanup && active === run) { if (run.status !== 'completed') run.status = run.abort.signal.aborted ? 'stopped' : 'failed'; void stop(run.runId); } }, () => { if (!run.cleanup && active === run) { run.status = 'failed'; void stop(run.runId); } }).catch(() => {});
      return job;
    },
    async answer(runId, questionId, answer) { const run = active; if (!run || run.runId !== runId || run.abort.signal.aborted) return fail(); await run.candidate.engine.answer(runId, questionId, answer); run.status = 'running'; options.arbiter.update(run.lease, 'running', 'idle'); },
    stop,
    dispose() { if (disposed) return; disposed = true; if (active) void stop(active.runId); for (const value of resources) { value.retired = true; try { value.engine.dispose(); } catch {} } },
    shutdown() {
      if (shutdown) return shutdown; disposed = true; const stopping = active ? stop(active.runId) : Promise.resolve();
      shutdown = (async () => { let failed = false; try { await stopping; } catch { failed = true; } const results = await Promise.allSettled([...resources].map(async value => { let disposeFailed = false; try { value.resource.dispose(); } catch { disposeFailed = true; } await value.resource.shutdown(); if (disposeFailed) return fail(); })); if (failed || results.some(value => value.status === 'rejected')) return fail(); })(); void shutdown.catch(() => {}); return shutdown;
    },
  };
}
