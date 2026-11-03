import test from 'node:test';
import assert from 'node:assert/strict';
import { createArbitratedCalculationRuntime } from '../apps/desktop/src/main/agent-project-read/calculation-runtime';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type { PilotEngine } from '../apps/desktop/src/main/engine-pilot/engine';
import { pilotPrompt } from '../apps/desktop/src/main/engine-pilot/prompt';
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const task = (mode: 'calculation' | 'project_read', runId: string) => ({ mode, runId, project: null, status: 'preparing' as const, cleanupState: 'idle' as const });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fake(events: string[], name: string, cleanup: Promise<void> = Promise.resolve()): PilotEngine {
  return { kind: 'opencode', version: '1.18.17', liveStatus: () => ({ canStart: true, availability: 'available', processState: 'idle' }), health: async () => true,
    accept: () => { events.push(name + ':accept'); return model; }, async start(input) { events.push(name + ':start'); input.callbacks.notice({ type: 'started', sessionId: 'synthetic-session' }); input.callbacks.notice({ type: 'text', text: '3' }); input.callbacks.notice({ type: 'completed' }); },
    answer: async () => {}, async stop() { events.push(name + ':stop'); await cleanup; }, dispose() { events.push(name + ':dispose'); }, async shutdown() { events.push(name + ':shutdown'); },
  };
}
const input = (runId: string): Parameters<PilotEngine['start']>[0] => ({ runId, model, prompt: pilotPrompt('Add 1 and 2', ''), signal: new AbortController().signal, callbacks: { notice() {}, tool: async () => ({ count: 2, sum: 3, source: 'deterministic-local', toolVersion: 'pilot.sum.v1' }) } });

test('calculation adapter waits for cleanup, excludes project/inspection work, and recreates after profile retirement', async () => {
  const arbiter = createAgentRuntimeArbiter(), events: string[] = [], stopping = gate(); let created = 0;
  const runtime = createArbitratedCalculationRuntime({ arbiter, create: () => fake(events, 'sum' + ++created, created === 1 ? stopping.promise : Promise.resolve()) });
  assert.equal(runtime.liveStatus!().canStart, true); assert.equal(events.length, 0);
  runtime.accept!('pilot.one', model); const running = runtime.start(input('pilot.one')); await running;
  assert.throws(() => arbiter.reserveRun(task('project_read', 'project'), () => {})); assert.throws(() => arbiter.reserveInspection('project', () => {}));
  const closing = runtime.stop('pilot.one'); assert.equal(runtime.stop('pilot.one'), closing); stopping.resolve(); await closing;
  const project = arbiter.reserveRun(task('project_read', 'project'), () => {}); await arbiter.runtime(project, () => ({ dispose() { events.push('project:dispose'); }, async shutdown() { events.push('project:shutdown'); } })); arbiter.release(project);
  runtime.accept!('pilot.two', model); await runtime.start(input('pilot.two')); await runtime.stop('pilot.two');
  assert.equal(created, 2); assert.ok(events.indexOf('sum1:shutdown') < events.indexOf('sum2:start')); assert.ok(events.indexOf('project:shutdown') < events.indexOf('sum2:start'));
  await runtime.shutdown!(); await arbiter.close();
});

test('same-tick calculation stop cancels before delegate start and shutdown rejects later acceptance', async () => {
  const arbiter = createAgentRuntimeArbiter(), events: string[] = [], runtime = createArbitratedCalculationRuntime({ arbiter, create: () => fake(events, 'sum') });
  runtime.accept!('pilot.one', model); const running = runtime.start(input('pilot.one')); await runtime.stop('pilot.one'); await running;
  assert.equal(events.includes('sum:start'), false); assert.equal(arbiter.snapshot().busy, false);
  await runtime.shutdown!(); assert.throws(() => runtime.accept!('pilot.two', model)); await arbiter.close();
});

test('arbiter rebuilds an exhausted same-profile resource and still awaits shutdown after disposal throws', async () => {
  const arbiter = createAgentRuntimeArbiter(), events: string[] = []; let remaining = 32, created = 0;
  for (let i = 0; i < 33; i++) {
    const lease = arbiter.reserveRun(task('project_read', 'run-' + i), () => {});
    await arbiter.runtime(lease, () => { created++; remaining = 32; return { canReuse: () => remaining > 0, dispose() { events.push('dispose'); }, async shutdown() { events.push('shutdown'); } }; });
    remaining--; arbiter.update(lease, 'completed', 'idle'); arbiter.release(lease);
  }
  assert.equal(created, 2); assert.deepEqual(events, ['dispose', 'shutdown']); await arbiter.close();
  const broken = createAgentRuntimeArbiter(), first = broken.reserveRun(task('calculation', 'one'), () => {});
  await broken.runtime(first, () => ({ dispose() { throw Error('synthetic'); }, async shutdown() { events.push('broken:shutdown'); } })); broken.release(first);
  const next = broken.reserveRun(task('project_read', 'two'), () => {});
  await assert.rejects(broken.runtime(next, () => assert.fail('must not construct'))); assert.ok(events.includes('broken:shutdown')); await assert.rejects(broken.close());
});

test('stop while retiring the previous profile does not construct or execute a new runtime', async () => {
  const arbiter = createAgentRuntimeArbiter(), retirement = gate(), lease = arbiter.reserveRun(task('project_read', 'project'), () => {});
  await arbiter.runtime(lease, () => ({ dispose() {}, shutdown: () => retirement.promise })); arbiter.release(lease);
  const events: string[] = [], runtime = createArbitratedCalculationRuntime({ arbiter, create: () => fake(events, 'sum') });
  runtime.accept!('pilot.one', model); const running = runtime.start(input('pilot.one')); await tick(); const stopped = runtime.stop('pilot.one'); retirement.resolve();
  await assert.rejects(running); await stopped; assert.equal(events.includes('sum:start'), false); await runtime.shutdown!(); await arbiter.close();
});
