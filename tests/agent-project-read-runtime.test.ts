import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { PROJECT_READ_LIMITS as L, type ProjectReadModel } from '../apps/desktop/src/shared/agent/agent-project-read';
import { createProjectReadModelSnapshots, createProjectReadRuntime } from '../apps/desktop/src/main/agent-project-read/runtime';
import type { ProjectReadEngineInput, ProjectReadEngineNotice, ProjectReadNativeEngine } from '../apps/desktop/src/main/agent-project-read/engine';
import type { OpenCodeSupervisor, OpenCodeSupervisorExit } from '../apps/desktop/src/main/engine-pilot/opencode-supervisor';
import * as gatewayModule from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import * as engineModule from '../apps/desktop/src/main/agent-project-read/opencode-engine';
import type { WorkCycleControllerRef } from '../apps/desktop/src/shared/agent/agent-work-cycle';

const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function modelFixture(selectedModel: ProjectReadModel = model) {
  const config = { model: selectedModel.model as string, key: 'sk-synthetic_original_1234', configured: true, keyReads: 0 };
  const settings: Parameters<typeof createProjectReadModelSnapshots>[0] = {
    key() { config.keyReads++; return config.configured ? config.key : undefined; }, defaultModel: () => config.model,
    read: () => ({ ok: true, value: { storage: 'ready', encryptionAvailable: true, providers: [
      { provider: 'deepseek', address: 'https://api.deepseek.com', model: selectedModel.provider === 'deepseek' ? config.model : 'deepseek-v4-flash', configured: selectedModel.provider === 'deepseek' && config.configured, source: 'file', maxOutputTokens: 8192, timeoutMs: 600000 },
      { provider: 'kimi', address: 'https://api.moonshot.cn', model: selectedModel.provider === 'kimi' ? config.model : 'kimi-k3', configured: selectedModel.provider === 'kimi' && config.configured, source: 'none', maxOutputTokens: 8192, timeoutMs: 600000 },
    ] } }),
  };
  return { config, models: createProjectReadModelSnapshots(settings, { load: () => selectedModel, save() {} }) };
}

/** Real runtime/vault; only socket-listener and native-engine factories are replaced. No native/API I/O. */
function fixture(t: TestContext, options: { nativeGate?: Promise<void>; disposeThrows?: boolean; shutdownThrows?: boolean; closeThrows?: boolean; stopUncertain?: boolean; guardianRef?: WorkCycleControllerRef; selectedModel?: ProjectReadModel } = {}) {
  const { config, models } = modelFixture(options.selectedModel);
  const stats = { gateway: 0, native: 0, fetch: 0, engineDispose: 0, engineShutdown: 0, serviceClose: 0, nativeStop: 0 };
  const starts: ProjectReadEngineInput[] = [], nativeInputs: unknown[] = [], events: ProjectReadEngineNotice[] = [], ends: string[] = [], answers: unknown[] = [];
  const entered = deferred<void>(), nativeEntered = deferred<void>(), exit = deferred<OpenCodeSupervisorExit>();
  const executions = new Map<string, ReturnType<typeof deferred<void>>>();
  let providerOptions: gatewayModule.ProjectReadProviderOptions | undefined;
  const services = { port: 43123, providerToken: 'a'.repeat(64), toolToken: 'b'.repeat(64),
    end(id: string) { ends.push(id); }, async close() { stats.serviceClose++; if (options.closeThrows) throw Error('synthetic private gateway cleanup detail'); },
    canDeliver: () => true, evidence: () => undefined,
  };
  t.mock.method(gatewayModule, 'createProjectReadProviderServices', async (value: gatewayModule.ProjectReadProviderOptions) => {
    stats.gateway++; providerOptions = value; return services as unknown as gatewayModule.ProjectReadProviderServices;
  });
  const native: ProjectReadNativeEngine = {
    health: async () => true,
    async start(input) { const execution = deferred<void>(); executions.set(input.runId, execution); starts.push(input); input.callbacks.notice({ type: 'started', sessionId: 'session_runtime' }); entered.resolve(); await execution.promise; },
    async answer(runId, questionId, answer) { answers.push({ runId, questionId, answer }); },
    async stop(id) { executions.get(id)?.resolve(); },
    dispose() { stats.engineDispose++; for (const execution of executions.values()) execution.resolve(); if (options.disposeThrows) throw Error('synthetic private native dispose detail'); },
    async shutdown() { stats.engineShutdown++; for (const execution of executions.values()) execution.resolve(); if (options.shutdownThrows) throw Error('synthetic private native shutdown detail'); },
  };
  t.mock.method(engineModule, 'createProjectReadNativeEngine', () => native);
  const supervisor: OpenCodeSupervisor = {
    ...(options.guardianRef ? {controller:options.guardianRef} : {}),
    port: 43124, password: 'c'.repeat(64), directory: 'C:/work/analog_ai_workbench/.local/agent-engine-pilot/native/synthetic_project_read/cwd', pid: 45678,
    health: async () => true, diagnostics: () => ({ stdoutBytes: 0, stderrBytes: 0, outputLimitExceeded: false, markers: [] }), exited: exit.promise,
    async stop() { stats.nativeStop++; return { exited: !options.stopUncertain, code: 0, signal: null }; },
  };
  const makeRuntime = () => createProjectReadRuntime({ models,
    fetchImpl: async () => { stats.fetch++; throw Error('No provider transport is allowed in this fixture'); },
    startNative: async input => { stats.native++; nativeInputs.push(input); nativeEntered.resolve(); await options.nativeGate; return supervisor; },
  });
  const input = (runId: string, controller = new AbortController()): ProjectReadEngineInput => ({
    runId, model: options.selectedModel ?? model, signal: controller.signal, prompt: { goal: '仅合成项目工具任务', constraint: '', rules: '合成规则', systemText: '合成系统说明', initialUserText: '合成用户说明' },
    callbacks: { notice: event => events.push(event), tool: async () => { throw Error('No broker is called in runtime fixture'); }, questionDelivered: async () => {} },
  });
  return { config, models, runtime: makeRuntime(), makeRuntime, stats, starts, nativeInputs, events, ends, answers, input,
    entered: entered.promise, nativeEntered: nativeEntered.promise,
    unexpectedExit: () => exit.resolve({ exited: true, code: 23, signal: null }),
    provider() { assert.ok(providerOptions); return providerOptions; },
  };
}

test('project runtime attaches only its trusted supervisor controller to the same started session', async t => {
  const ref: WorkCycleControllerRef = {guardianId:'12345678-1234-4123-8123-123456789abc',guardianPid:1234,enginePid:5678,intentVersion:'a'.repeat(64),readyVersion:'b'.repeat(64)};
  const f=fixture(t,{guardianRef:ref});f.runtime.accept('run_controller_binding',model);
  const operation=f.runtime.start(f.input('run_controller_binding'));await f.entered;
  try { assert.deepEqual(f.events[0],{type:'started',sessionId:'session_runtime',controller:ref});assert.equal(f.stats.fetch,0); }
  finally { await f.runtime.stop('run_controller_binding');await operation;await f.runtime.shutdown(); }
});

test('project model status is cold and acceptance freezes one main-only key and shared budgets', () => {
  const { config, models } = modelFixture();
  assert.deepEqual(models.status(), { model, canStart: true, reason: null }); assert.equal(config.keyReads, 0);
  assert.deepEqual(models.freeze('run_a', model), model);
  config.key = 'sk-synthetic_changed_5678'; config.model = 'other_model'; config.configured = false;
  assert.deepEqual(models.freeze('run_a', model), model); assert.equal(config.keyReads, 1);
  assert.deepEqual(models.get('run_a'), { apiKey: 'sk-synthetic_original_1234', model, maxRequests: L.requests, maxOutputTokens: L.maxOutputTokens, requestTimeoutMs: L.requestMs });
  const copy = models.get('run_a') as { apiKey: string }; copy.apiKey = 'changed'; assert.equal(models.get('run_a').apiKey, 'sk-synthetic_original_1234');
  assert.throws(() => models.freeze('run_b', model)); assert.equal(config.keyReads, 1);
  models.forget('run_a'); assert.throws(() => models.get('run_a'));
  config.configured = true; config.model = model.model; models.freeze('run_b', model);
  assert.equal(models.get('run_b').apiKey, config.key); models.close();
  assert.deepEqual(models.status(), { model: null, canStart: false, reason: 'MODEL_UNAVAILABLE' }); assert.throws(() => models.get('run_b')); assert.throws(() => models.freeze('run_c', model));
});

test('project model vault enforces identifiers, fixed requested model, key syntax and bounded run capacity', () => {
  const { config, models } = modelFixture();
  assert.throws(() => models.freeze('../run', model)); assert.throws(() => models.freeze('run_a', { ...model, provider: 'kimi' } as unknown as typeof model));
  config.key = 'sk-invalid\nsecret'; assert.throws(() => models.freeze('run_a', model));
  config.key = 'sk-synthetic_valid_1234';
  for (let index = 0; index < L.runs; index++) models.freeze(`run_${index}`, model);
  assert.throws(() => models.freeze('over_capacity', model)); models.forget('run_0'); models.freeze('replacement', model); models.close();
});

test('project runtime status and failed cold admission use no key, listener, native startup or fetch', async t => {
  const f = fixture(t);
  assert.deepEqual(f.runtime.status(), { model, canStart: true, processState: 'idle', reason: null }); assert.equal(await f.runtime.health(), true);
  f.config.configured = false; assert.equal(f.runtime.status().canStart, false); assert.throws(() => f.runtime.accept('run_a', model));
  assert.throws(() => f.runtime.start(f.input('run_a')));
  assert.deepEqual([f.stats.gateway, f.stats.native, f.stats.fetch, f.config.keyReads], [0, 0, 0, 0]); await f.runtime.shutdown();
});

test('project runtime uses frozen credentials only for the active run and retains actual response identity with unknown usage', async t => {
  const f = fixture(t), id = 'run_a', controller = new AbortController();
  f.runtime.accept(id, model); f.config.key = 'sk-synthetic_changed_5678'; f.config.model = 'other_model';
  const started = f.runtime.start(f.input(id, controller)); await f.entered;
  try {
    assert.deepEqual(f.provider().getRunCredentials(id), { apiKey: 'sk-synthetic_original_1234', model, maxRequests: L.requests, maxOutputTokens: L.maxOutputTokens, requestTimeoutMs: L.requestMs });
    assert.throws(() => f.provider().getRunCredentials('foreign_run'));
    assert.equal(f.config.keyReads, 1); assert.deepEqual(f.starts[0]!.model, model);
    assert.deepEqual(f.nativeInputs, [{ services: { port: 43123, providerToken: 'a'.repeat(64), toolToken: 'b'.repeat(64) }, profile: 'project-read' }]);
    f.provider().onResponse('foreign_run', { request: 1, responseModel: 'ignored', usage: null });
    f.provider().onResponse(id, { request: 1, responseModel: 'deepseek-flash', usage: null });
    assert.deepEqual(f.events.filter(e => e.type === 'response'), [{ type: 'response', request: 1, responseModel: 'deepseek-flash', usage: null }]);
    await f.runtime.answer(id, 'question_native', '毫安'); assert.equal(f.answers.length, 1);
    controller.abort(); assert.throws(() => f.provider().getRunCredentials(id));
    const stopping = f.runtime.stop(id); assert.equal(f.runtime.stop(id), stopping); await stopping; await started;
    await assert.rejects(f.runtime.answer(id, 'question_native', '迟到不得发送')); assert.throws(() => f.models.get(id));
    f.provider().onResponse(id, { request: 2, responseModel: 'late', usage: null }); assert.equal(f.events.filter(e => e.type === 'response').length, 1);
    assert.equal(JSON.stringify({ native: f.nativeInputs, starts: f.starts, events: f.events }).includes('sk-synthetic'), false); assert.equal(f.stats.fetch, 0);
  } finally { await f.runtime.shutdown(); }
});

test('K3 runtime binds accepted provider credentials and native input despite a next-task model switch', async t => {
  const selectedModel: ProjectReadModel={provider:'kimi',model:'kimi-k3'}, f=fixture(t,{selectedModel});
  f.runtime.accept('run_k3',selectedModel); assert.throws(()=>f.runtime.start({...f.input('run_k3'),model}));
  const started=f.runtime.start(f.input('run_k3')); await f.entered;
  try {
    f.models.select(model); f.config.key='sk-synthetic_changed_5678';
    assert.deepEqual(f.provider().getRunCredentials('run_k3'),{apiKey:'sk-synthetic_original_1234',model:selectedModel,maxRequests:L.requests,maxOutputTokens:L.maxOutputTokens,requestTimeoutMs:L.requestMs});
    assert.deepEqual(f.starts[0]!.model,selectedModel); assert.equal(f.config.keyReads,1); assert.equal(f.stats.fetch,0);
  } finally { await f.runtime.stop('run_k3');await started;await f.runtime.shutdown(); }
});

test('project runtime immediate stop prevents deferred admission and forgets the frozen run', async t => {
  const f = fixture(t), id = 'run_immediate'; f.runtime.accept(id, model);
  const started = f.runtime.start(f.input(id)); void started.catch(() => {});
  const stopping = f.runtime.stop(id); assert.equal(stopping, f.runtime.stop(id)); await stopping; await setImmediate();
  const observed = { gateways: f.stats.gateway, nativeStarts: f.stats.native, tasks: f.starts.length };
  await f.runtime.shutdown(); await started;
  assert.throws(() => f.models.get(id)); assert.deepEqual(observed, { gateways: 0, nativeStarts: 0, tasks: 0 }); assert.equal(f.stats.fetch, 0);
});

test('project runtime aborted late native startup is cleaned without starting a task and shares shutdown', async t => {
  const gate = deferred<void>(), f = fixture(t, { nativeGate: gate.promise }), controller = new AbortController();
  f.runtime.accept('run_late', model); const started = f.runtime.start(f.input('run_late', controller)); await f.nativeEntered;
  controller.abort(); const first = f.runtime.shutdown(); assert.equal(first, f.runtime.shutdown());
  let settled = false; void first.then(() => { settled = true; }); await setImmediate(); assert.equal(settled, false);
  gate.resolve(); await first; await started;
  assert.equal(f.starts.length, 0); assert.equal(f.stats.engineDispose, 0); assert.equal(f.stats.engineShutdown, 0);
  assert.ok(f.stats.serviceClose >= 1); assert.ok(f.stats.nativeStop >= 1); assert.throws(() => f.models.get('run_late')); assert.equal(f.stats.fetch, 0);
});

test('project runtime destruction revokes old execution and a new instance uses a fresh accepted key', async t => {
  const f = fixture(t); f.runtime.accept('run_first', model); const firstRun = f.runtime.start(f.input('run_first')); await f.entered;
  const closed = f.runtime.shutdown(); assert.equal(closed, f.runtime.shutdown()); await closed; await firstRun;
  assert.throws(() => f.runtime.start(f.input('run_first'))); assert.throws(() => f.provider().getRunCredentials('run_first'));
  const acceptedByDestroyedRuntime = (() => { try { f.runtime.accept('run_destroyed', model); return true; } catch { return false; } })(); f.models.forget('run_destroyed');
  f.config.key = 'sk-synthetic_rebuilt_6789'; const rebuilt = f.makeRuntime();
  rebuilt.accept('run_second', model); const secondRun = rebuilt.start(f.input('run_second')); await setImmediate();
  assert.equal(f.provider().getRunCredentials('run_second').apiKey, f.config.key); assert.equal(f.starts.length, 2);
  await rebuilt.shutdown(); await secondRun;
  assert.equal(f.stats.native, 2); assert.equal(f.stats.nativeStop, 2); assert.equal(f.stats.fetch, 0);
  assert.equal(acceptedByDestroyedRuntime, false, 'destroyed runtime must not accept a new run or read another key');
});

test('project runtime cleanup failures still close every resource and expose one sanitized failure', async t => {
  for (const mode of ['disposeThrows', 'shutdownThrows', 'closeThrows', 'stopUncertain'] as const) await t.test(mode, async sub => {
    const f = fixture(sub, { [mode]: true }); f.runtime.accept('run_cleanup', model); const started = f.runtime.start(f.input('run_cleanup')); await f.entered;
    const first = f.runtime.shutdown(); assert.equal(first, f.runtime.shutdown());
    await assert.rejects(first, error => error instanceof Error && error.message === 'OpenCode pilot unavailable'); await started;
    assert.equal(f.stats.engineDispose, 1); assert.equal(f.stats.engineShutdown, 1); assert.equal(f.stats.serviceClose, 1); assert.equal(f.stats.nativeStop, 1);
    assert.throws(() => f.models.get('run_cleanup')); assert.equal(f.runtime.status().reason, 'ENGINE_FAILED'); assert.equal(f.stats.fetch, 0);
  });
});

test('project runtime unexpected native exit revokes credentials and cannot forward a late response', async t => {
  const f = fixture(t); f.runtime.accept('run_exit', model); const started = f.runtime.start(f.input('run_exit')); await f.entered;
  f.unexpectedExit(); await started; await setImmediate();
  assert.equal(f.runtime.status().reason, 'ENGINE_FAILED'); assert.throws(() => f.provider().getRunCredentials('run_exit'));
  f.provider().onResponse('run_exit', { request: 1, responseModel: 'late', usage: null });
  assert.deepEqual(f.events.map(event => event.type), ['started', 'failed']); await f.runtime.shutdown(); assert.equal(f.stats.fetch, 0);
});
