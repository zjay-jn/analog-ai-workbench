import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type { ProjectReadActiveTask } from '../apps/desktop/src/shared/agent/agent-project-read';

const task = (mode: ProjectReadActiveTask['mode'], runId: string): ProjectReadActiveTask => ({ mode, runId, project: null, status: 'preparing', cleanupState: 'idle' });
test('runtime arbiter sum-project-sum recreates disposed profiles and blocks every active inspection/task', async () => {
  const arbiter = createAgentRuntimeArbiter(), events: string[] = [];
  const factory = (name: string) => () => ({ dispose() { events.push(name + ':dispose'); }, async shutdown() { events.push(name + ':shutdown'); } });
  const sum = arbiter.reserveRun(task('calculation', 'first'), () => {}); await arbiter.runtime(sum, factory('sum1'));
  assert.throws(() => arbiter.reserveInspection('project', () => {})); arbiter.update(sum, 'completed', 'idle'); arbiter.release(sum);
  const project = arbiter.reserveRun(task('project_read', 'second'), () => {}); await arbiter.runtime(project, factory('project1'));
  assert.deepEqual(events, ['sum1:dispose', 'sum1:shutdown']); arbiter.update(project, 'stopped', 'pending'); assert.throws(() => arbiter.release(project));
  arbiter.update(project, 'stopped', 'idle'); arbiter.release(project);
  const sum2 = arbiter.reserveRun(task('calculation', 'third'), () => {}); await arbiter.runtime(sum2, factory('sum2'));
  assert.deepEqual(events, ['sum1:dispose', 'sum1:shutdown', 'project1:dispose', 'project1:shutdown']); arbiter.update(sum2, 'completed', 'idle'); arbiter.release(sum2);
  let cancelled = false; const inspection = arbiter.reserveInspection('project', () => { cancelled = true; }); assert.throws(() => arbiter.reserveRun(task('calculation', 'fourth'), () => {}));
  arbiter.cancelInspection('other'); assert.equal(cancelled, false); arbiter.cancelInspection('project'); assert.equal(cancelled, true); arbiter.release(inspection);
  await arbiter.close(); assert.equal(events.at(-1), 'sum2:shutdown');
});
test('runtime arbiter cleanup failure prevents factory creation and cannot be released as success', async () => {
  const arbiter = createAgentRuntimeArbiter(); const first = arbiter.reserveRun(task('calculation', 'first'), () => {});
  await arbiter.runtime(first, () => ({ dispose() {}, async shutdown() { throw new Error('synthetic cleanup failure'); } })); arbiter.release(first);
  const second = arbiter.reserveRun(task('project_read', 'second'), () => {}); let created = false;
  await assert.rejects(arbiter.runtime(second, () => { created = true; return { dispose() {}, async shutdown() {} }; })); assert.equal(created, false); assert.equal(arbiter.snapshot().failed, true);
  assert.throws(() => arbiter.release(second)); await assert.rejects(arbiter.close());
});
