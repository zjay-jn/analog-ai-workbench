import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { parseProjectReadDisk, type ProjectReadDisk } from '../apps/desktop/src/main/agent-project-read/store';
import { createOaQuerySession } from '../apps/desktop/src/main/oa-read/query';
import { createOaSnapshotStore, oaDigest } from '../apps/desktop/src/main/oa-read/snapshot';
import type { createOaReadRuntime } from '../apps/desktop/src/main/oa-read/runtime';
import type { OaReadQuery, OaReadToolResult, OaReadToolValue } from '../apps/desktop/src/shared/agent/oa-read';
import { AGENT_PROJECT_READ_VERSION as V, type ProjectReadToolArguments, type ProjectReadToolCall, type ProjectReadToolName } from '../apps/desktop/src/shared/agent/agent-project-read';
import type { ProjectReadEngine } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { projectReadTools, validateProjectReadNativeTools } from '../apps/desktop/src/main/agent-project-read/protocol';

const model = { provider: 'kimi', model: 'kimi-k3' } as const;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const call = <K extends ProjectReadToolName>(toolName: K, args: ProjectReadToolArguments[K]): ProjectReadToolCall => ({ sessionId: 'native', messageId: 'message', callId: randomUUID(), toolName, arguments: args }) as ProjectReadToolCall;
function syntheticSession(runId: string, projectId: string) {
  const lcv = { library: 'SYNTHETIC', cell: 'test', view: 'schematic' };
  const files = [{ relativePath: 'master.tag', bytes: 35, sha256: '1'.repeat(64) }, { relativePath: 'sch.oa', bytes: 200, sha256: '2'.repeat(64) }];
  const revision = `sha256:${hash(JSON.stringify(files))}`;
  const captureBinding = { requestId: 'synthetic-capture', designId: 'synthetic', environmentBindingId: 'synthetic:v1', libraryMappingIdentity: `sha256:${'3'.repeat(64)}`, lcv, adapterVersion: 'synthetic-reader-v1', allowedFiles: ['master.tag', 'sch.oa'] };
  const envelope = { schema: 'aaw.oa-saved-read.snapshot.v1', requestId: captureBinding.requestId,
    source: { sourceKind: 'saved_oa', environmentBindingId: captureBinding.environmentBindingId, libraryMappingIdentity: captureBinding.libraryMappingIdentity, lcv,
      capturedAt: '2026-10-28T00:00:00.000Z', readMode: 'fresh_process_read_only', savedRevision: revision, revisionMethod: 'copied-file-manifest-sha256-v1',
      sourceObservation: { beforeDigest: revision, afterDigest: revision, copiedDigest: revision, state: 'observed_unchanged', transactionLock: false }, files, dirty: { status: 'unknown', reason: 'not_observed' } },
    metadata: { adapterVersion: captureBinding.adapterVersion, parameterEncoding: 'skill_stored_value_serialization', coverage: { instances: 'complete', nets: 'complete', ports: 'complete', parameters: 'complete', terminals: 'complete', netMembers: 'complete', hierarchy: 'not_read', masterContents: 'not_read', cdf: 'not_read' } },
    facts: { instances: [{ id: 'i1', name: 'M1', master: { library: 'SYNTHETIC', cell: 'nmos', view: 'symbol' }, parameters: [{ name: 'w', valueType: 'string', valueText: '"1u"' }], terminals: [{ id: 't1', name: 'D', role: 'unknown', netId: 'n1' }] }],
      nets: [{ id: 'n1', name: 'OUT', members: [{ kind: 'instance_terminal', instanceId: 'i1', terminalId: 't1' }, { kind: 'port', portId: 'p1' }] }], ports: [{ id: 'p1', name: 'OUT', direction: 'output', netId: 'n1' }] } };
  const store = createOaSnapshotStore(), snapshot = store.admit(JSON.stringify(envelope), captureBinding);
  const session = createOaQuerySession(snapshot, { runId, projectId, bindingId: 'oa-binding', projectIdentity: 'synthetic-project-identity', designId: captureBinding.designId, designHandle: 'handle-' + runId });
  return { session, close() { session.close(); store.remove(snapshot.snapshotId); } };
}
function fixture(config: { wrongScope?: 'run' | 'project'; waitForAbort?: boolean } = {}) {
  let disk: ProjectReadDisk = { version: 1, runs: [] };
  const projectId = randomUUID(), runId = randomUUID(), abort = new AbortController(), arbiter = createAgentRuntimeArbiter();
  const counters = { runtimeCreated: 0, captures: 0, executions: 0, runtimeClosed: 0, engineStarts: 0, prepareWork: 0, cancelled: 0 };
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const engine = { status: () => ({ model, canStart: true, processState: 'ready', reason: null }), health: async () => true, accept: () => model,
    canDeliver: () => true, accounting: () => ({ providerAttempts: 0, httpDispatches: 0, contextBytes: 0 }),
    start: async () => { counters.engineStarts++; assert.fail('No model transport'); }, answer: async () => {}, stop: async () => {}, dispose() {}, shutdown: async () => {}, setProjectContext() {} } as ProjectReadEngine;
  const models = { status: () => ({ model, canStart: true, reason: null }), freeze: () => model, get: () => assert.fail('No credentials'), forget() {}, close() {} } as ProjectReadModelSnapshots;
  const store = { load: () => structuredClone(disk), save(next: ProjectReadDisk) { const parsed = parseProjectReadDisk(next); assert(parsed, 'durable independent audit'); disk = parsed; }, close() {} };
  const createOaRuntime = (scope: { runId: string; projectId: string }): ReturnType<typeof createOaReadRuntime> => {
    counters.runtimeCreated++;
    let loaded: ReturnType<typeof syntheticSession> | undefined, closed = false;
    return {
      async execute(query: OaReadQuery, signal: AbortSignal): Promise<OaReadToolResult> {
        counters.executions++; markEntered();
        if (config.waitForAbort) return await new Promise<OaReadToolResult>(resolve => {
          const cancelled = () => { counters.cancelled++; resolve({ ok: false, error: { code: 'CANCELLED' }, coverage: null }); };
          if (signal.aborted) cancelled(); else signal.addEventListener('abort', cancelled, { once: true });
        });
        if (query.toolName === 'oa_open_design') {
          if (!loaded) { counters.captures++; loaded = syntheticSession(scope.runId, scope.projectId); }
          let value = loaded.session.query('oa_inspect_design', { designHandle: loaded.session.source.designHandle, savedRevision: loaded.session.source.savedRevision });
          if (config.wrongScope && value.ok) {
            const altered = { ...value.value, source: { ...value.value.source, ...(config.wrongScope === 'run' ? { runId: 'different-run' } : { projectId: randomUUID() }) } };
            const { resultDigest: _, ...body } = altered;
            value = { ok: true, value: { ...body, resultDigest: oaDigest(body) } };
          }
          return value;
        }
        if (!loaded) return { ok: false, error: { code: 'NOT_BOUND' }, coverage: null };
        return loaded.session.query(query.toolName, query.arguments);
      },
      async close() { if (!closed) { closed = true; counters.runtimeClosed++; loaded?.close(); } },
    } as ReturnType<typeof createOaReadRuntime>;
  };
  const options = { store, models, arbiter, createEngine: () => engine, bindings: { snapshotBinding: () => ({ ok: false as const, error: { code: 'NOT_BOUND' as const } }) }, createOaRuntime };
  const host = createProjectReadHost(options);
  return { host, options, counters, entered, runId, projectId, disk: () => structuredClone(disk),
    async attach() {
      const lease = arbiter.reserveRun({ mode: 'conversation', runId, project: null, status: 'running', cleanupState: 'idle' }, () => abort.abort());
      return host.attachChat({ runId, origin: { chatSessionId: randomUUID(), turnId: randomUUID(), executionId: randomUUID(), inputDigest: hash('synthetic OA host') }, model,
        snapshot: host.captureChat(projectId, 'Synthetic OA'), lease, abort, engine, outputBytes: 65536,
        history: [{ type: 'run.started', data: { sessionId: 'native', engine: 'opencode', version: '1.18.17' } }, { type: 'model.step', data: { step: 1 } }],
        prepareWorkHead: async () => { counters.prepareWork++; assert.fail('OA must not prepare a command workspace'); }, onLinked() {}, onReady() {}, onFailure() {} }, null);
    },
    async close() { host.revoke(); await host.shutdown(); await arbiter.close(); },
  };
}
function oaValue(result: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof fixture>['attach']>>['tool']>>): OaReadToolValue {
  assert(result.ok, JSON.stringify(result)); assert.equal(result.value.kind, 'oa_read');
  if (result.value.kind !== 'oa_read') return assert.fail('Expected OA value'); return result.value;
}

test('OA native tool schemas agree with both read-only and work-capable tool inventories', () => {
  for (const workCycle of [false, true]) {
    const tools = projectReadTools(workCycle);
    validateProjectReadNativeTools(tools, workCycle);
    const names = tools.map(tool => (tool as { function: { name: string } }).function.name);
    assert.equal(names.filter(name => name.startsWith('oa_')).length, 5);
    assert.equal(new Set(names).size, names.length);
  }
});

test('unbound conversation queries OA, deduplicates calls, persists exact source and cold-reopens without recapture', async () => {
  const f = fixture();
  try {
    const cb = await f.attach(), request = call('oa_open_design', { designId: 'synthetic', refresh: false });
    const first = cb.tool(request); assert.equal(cb.tool(request), first, 'same call ID shares one execution promise');
    const opened = oaValue(await first), bound = { designHandle: opened.source.designHandle, savedRevision: opened.source.savedRevision };
    const instances = oaValue(await cb.tool(call('oa_query_instances', { ...bound, selector: { kind: 'exact_name', name: 'M1' }, cursor: null })));
    assert.equal(instances.data.kind, 'instances');
    const parameters = oaValue(await cb.tool(call('oa_describe_device', { ...bound, instanceId: 'i1', section: 'parameters', cursor: null })));
    assert.equal(parameters.data.kind, 'device_parameters');
    const members = oaValue(await cb.tool(call('oa_query_nets', { ...bound, selector: { kind: 'id', objectId: 'n1' }, section: 'members', cursor: null })));
    assert.equal(members.data.kind, 'net_members'); assert.equal(members.coverage.returned, 2);
    await f.host.finishChat(f.runId, 'completed');
    const disk = f.disk(), run = disk.runs[0]!.run;
    assert.equal(run.project.bindingId, null); assert.equal(run.workCycle, undefined); assert.equal(run.status, 'completed'); assert.equal(run.cleanupState, 'idle');
    assert.equal(run.events.filter(e => e.type === 'tool.completed').length, 4);
    assert.deepEqual(f.counters, { runtimeCreated: 1, captures: 1, executions: 4, runtimeClosed: 1, engineStarts: 0, prepareWork: 0, cancelled: 0 });
    const coldArbiter = createAgentRuntimeArbiter(), cold = createProjectReadHost({ ...f.options, arbiter: coldArbiter, createEngine: () => assert.fail('Cold read must not create engine'), createOaRuntime: () => assert.fail('Cold read must not capture OA') });
    try {
      const page = await cold.invoke('readRun', { contractVersion: V, runId: f.runId, after: 0 }, () => true);
      assert(page.ok); assert.equal(page.value.run.status, 'completed');
      assert.deepEqual(page.value.events.filter(e => e.type === 'tool.completed').map(e => e.data.result), run.events.filter(e => e.type === 'tool.completed').map(e => e.data.result));
      assert.deepEqual(f.disk(), disk); assert.equal(f.counters.captures, 1);
    } finally { cold.revoke(); await cold.shutdown(); await coldArbiter.close(); }
    for (const field of ['runId', 'projectId'] as const) {
      const forged = structuredClone(disk), e = forged.runs[0]!.run.events.find(e => e.type === 'tool.completed')!;
      assert(e.type === 'tool.completed' && e.data.result.ok && e.data.result.value.kind === 'oa_read');
      const { resultDigest: _, ...body } = e.data.result.value;
      const altered = { ...body, source: { ...body.source, [field]: 'different-' + field } };
      Object.assign(e.data.result, { value: { ...altered, resultDigest: oaDigest(altered) } });
      assert.equal(parseProjectReadDisk(forged), null, 'Source identity must be checked beyond the self digest');
    }
  } finally { await f.close(); }
});

test('OA host rejects a runtime result from another run or project before delivering it', async () => {
  for (const wrongScope of ['run', 'project'] as const) {
    const f = fixture({ wrongScope });
    try {
      const cb = await f.attach();
      await assert.rejects(cb.tool(call('oa_open_design', { designId: 'synthetic', refresh: false })));
      await f.host.finishChat(f.runId, 'failed');
      assert.equal(f.disk().runs[0]!.run.events.filter(e => e.type === 'tool.completed').length, 0);
      assert.equal(f.counters.runtimeClosed, 1);
    } finally { await f.close(); }
  }
});

test('stopping a pending OA query aborts capture, waits for completion, and closes runtime without publishing late results', async () => {
  const f = fixture({ waitForAbort: true });
  try {
    const cb = await f.attach(), job = cb.tool(call('oa_open_design', { designId: 'synthetic', refresh: false }));
    const rejected = assert.rejects(job); await f.entered;
    await f.host.finishChat(f.runId, 'stop'); await rejected;
    assert.equal(f.counters.cancelled, 1); assert.equal(f.counters.runtimeClosed, 1);
    const run = f.disk().runs[0]!.run; assert.equal(run.status, 'stopped'); assert.equal(run.cleanupState, 'idle');
    assert.equal(run.events.filter(e => e.type === 'tool.completed').length, 0);
  } finally { await f.close(); }
});
