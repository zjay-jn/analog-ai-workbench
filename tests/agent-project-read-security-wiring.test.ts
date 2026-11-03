import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { projectReadExtension } from '../apps/desktop/src/main/agent-project-read/register-ipc';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import type { AgentCallerContextV1 } from '../apps/desktop/src/main/agent/agent-caller-fence';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import * as contract from '../apps/desktop/src/shared/agent/agent-project-read';
import * as validation from '../apps/desktop/src/shared/agent/agent-project-read-validation';

const V = contract.AGENT_PROJECT_READ_VERSION;
// Independent exact inventory: adding an exposed method requires a valid fixture
// and the same caller, malformed-input and revoked-reference checks below.
const names = [
  'getStatus','selectModel','revalidateProject','startRun','listRuns','readRun','stopRun','answerQuestion',
  'resolveCitation','checkCitation','deleteRun','browseProject','cancelInspection','getTaskCapacity',
  'getWslResultsBinding','selectWslResultsBinding','clearWslResultsBinding','resolveWslResultsCitation','checkWslResultsCitation',
  'resolveWaveformCitation','checkWaveformCitation','startWorkRun','listWorkFiles','readWorkFile','readWorkChange','prepareWorkContinuation',
  'inspectCommandEnvironment','listCommandExecutions','readCommandExecution','readCommandLog','readCommandDiagnostics','openCommandDiagnostics','stopCommandExecution',
] as const satisfies readonly contract.ProjectReadMethod[];
const model = { provider: 'deepseek', model: 'deepseek-v4-flash' } as const;
const requests: contract.ProjectReadRequests = {
  getStatus: { contractVersion: V, projectId: 'synthetic-project' },
  selectModel: { contractVersion: V, model },
  revalidateProject: { contractVersion: V, projectId: 'synthetic-project', bindingId: 'synthetic-binding' },
  startRun: { contractVersion: V, projectId: 'synthetic-project', bindingId: 'synthetic-binding', clientRequestId: 'synthetic-client', model, goal: 'Synthetic gate test', constraint: '', continuedFrom: null },
  listRuns: { contractVersion: V, projectId: null, before: null },
  readRun: { contractVersion: V, runId: 'synthetic-run', after: 0 },
  stopRun: { contractVersion: V, runId: 'synthetic-run' },
  answerQuestion: { contractVersion: V, runId: 'synthetic-run', questionId: 'synthetic-question', answer: 'Synthetic answer' },
  resolveCitation: { contractVersion: V, runId: 'synthetic-run', citationId: 'synthetic-citation' },
  checkCitation: { contractVersion: V, runId: 'synthetic-run', citationId: 'synthetic-citation' },
  deleteRun: { contractVersion: V, runId: 'synthetic-run', expectedEventCount: 1 },
  browseProject: { contractVersion: V, projectId: 'synthetic-project', bindingId: 'synthetic-binding', directoryId: null, cursor: null, refresh: false },
  cancelInspection: { contractVersion: V, projectId: 'synthetic-project' },
  getTaskCapacity: { contractVersion: V, projectId: null },
  getWslResultsBinding: { contractVersion: V, projectId: 'synthetic-project' },
  selectWslResultsBinding: { contractVersion: V, projectId: 'synthetic-project', selection: { distro: 'ROCKY9_LLM_LAB', user: 'maxwell', rootPath: '/home/maxwell/simulation/independent-synthetic-security-fixture' } },
  clearWslResultsBinding: { contractVersion: V, projectId: 'synthetic-project', expectedBindingId: 'wsl-synthetic-binding' },
  resolveWslResultsCitation: { contractVersion: V, runId: 'synthetic-run', citationId: 'wsl-synthetic-citation' },
  checkWslResultsCitation: { contractVersion: V, runId: 'synthetic-run', citationId: 'wsl-synthetic-citation' },
  resolveWaveformCitation: { contractVersion: V, runId: 'synthetic-run', citationId: 'synthetic-waveform-citation' },
  checkWaveformCitation: { contractVersion: V, runId: 'synthetic-run', citationId: 'synthetic-waveform-citation' },
  startWorkRun: { contractVersion: V, projectId: 'synthetic-project', bindingId: 'synthetic-binding', clientRequestId: 'synthetic-work-client', model, goal: 'Synthetic work gate test', constraint: '', continuedFrom: null },
  listWorkFiles: { contractVersion: V, runId: 'synthetic-run' },
  readWorkFile: { contractVersion: V, runId: 'synthetic-run', fileId: 'synthetic-file', version: 'a'.repeat(64) },
  readWorkChange: { contractVersion: V, runId: 'synthetic-run', changeId: 'synthetic-change' },
  prepareWorkContinuation: { contractVersion: V, runId: 'synthetic-run', projectId: 'synthetic-project', bindingId: 'synthetic-binding', expectedEventCount: 1 },
  inspectCommandEnvironment: { contractVersion: V, runId: 'synthetic-run' },
  listCommandExecutions: { contractVersion: V, runId: 'synthetic-run' },
  openCommandDiagnostics: { contractVersion: V, runId: 'run-a', executionId: 'cmd-a' },
  readCommandDiagnostics: { contractVersion: V, runId: 'run-a', executionId: 'cmd-a' },
  readCommandExecution: { contractVersion: V, runId: 'synthetic-run', executionId: 'synthetic-execution', afterRevision: null, waitMs: 0 },
  readCommandLog: { contractVersion: V, runId: 'synthetic-run', executionId: 'synthetic-execution', stream: 'stdout', offset: 0, maxBytes: 1024, expectedPrefixVersion: null },
  stopCommandExecution: { contractVersion: V, runId: 'synthetic-run', executionId: 'synthetic-execution' },
};
const owner: AgentCallerContextV1 = { senderId: 73, isTopFrame: true, appOrigin: 'workbench://app', navigationEpoch: 2, appSessionId: 'independent-session', windowId: 'independent-window', webContentsId: 73, workspaceId: 'independent-workspace', rootId: 'independent-root' };
function denied(result: unknown, expected: string): void { assert.equal((result as contract.ProjectReadFailure).ok, false); assert.equal((result as contract.ProjectReadFailure).error.code, expected); }

test('independent wiring IPC: every actual method rejects foreign callers, malformed authority and revoked handler references before work', async () => {
  type Context = Parameters<ReturnType<typeof projectReadExtension>>[0];
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>(), arbiter = createAgentRuntimeArbiter();
  const counters = { load: 0, save: 0, modelStatus: 0, modelSelect: 0, key: 0, bindings: 0, engine: 0 };
  const models: ProjectReadModelSnapshots = { status() { counters.modelStatus++; return { model, canStart: true, reason: null }; }, select() { counters.modelSelect++; throw Error('No model selection write allowed'); }, freeze() { counters.key++; throw Error('No key access allowed'); }, get() { counters.key++; throw Error('No key access allowed'); }, forget() {}, close() {} };
  const ipcMain = { removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } } as unknown as Context['ipcMain'];
  const extension = projectReadExtension({ store: { load() { counters.load++; return { version: 1, runs: [] }; }, save() { counters.save++; throw Error('No durable writes expected'); }, close() {} },
    bindings: { snapshotBinding() { counters.bindings++; return { ok: false, error: { code: 'NOT_BOUND' } }; } }, models, arbiter, createEngine() { counters.engine++; throw Error('No engine creation allowed'); },
  })({ ipcMain, owner, deriveCallerContext: event => event as AgentCallerContextV1 | null });
  try {
    assert.equal(names.length, 33); assert.deepEqual(Object.keys(requests).sort(), [...names].sort());
    assert.deepEqual([...handlers.keys()].sort(), names.map(name => V + ':' + name).sort()); assert.equal(counters.load, 1);
    const unchanged = { ...counters };
    const foreign = [null, ...Object.keys(owner).map(key => ({ ...owner, [key]: key === 'isTopFrame' ? false : typeof owner[key as keyof typeof owner] === 'number' ? 999 : 'foreign' }))];
    for (const name of names) {
      assert.ok(validation.parseProjectReadRequest(name, requests[name])); const invoke = handlers.get(V + ':' + name)!;
      for (const caller of foreign) denied(await invoke(caller, requests[name]), 'CAPABILITY_DENIED');
      denied(await invoke(owner, { ...requests[name], absolutePath: 'R:\\Synthetic\\Forbidden.txt' }), 'INVALID_REQUEST');
    }
    assert.deepEqual(counters, unchanged, 'unauthorized or malformed requests must not inspect bindings, keys, engines or records');
    assert.deepEqual(await handlers.get(V + ':listRuns')!(owner, requests.listRuns), { ok: true, value: { runs: [], nextBefore: null } });
    const status = await handlers.get(V + ':getStatus')!(owner, requests.getStatus) as contract.ProjectReadResult<contract.ProjectReadStatus>; assert.ok(status.ok); assert.equal(status.value.canStart, false); assert.equal(status.value.reason, 'NOT_BOUND'); assert.equal(counters.key, 0); assert.equal(counters.engine, 0);
    const retained = [...handlers.entries()]; extension.revoke(); const stopped = { ...counters };
    for (const name of names) denied(await handlers.get(V + ':' + name)!(owner, requests[name]), 'CAPABILITY_DENIED');
    extension.dispose(); assert.equal(handlers.size, 0);
    for (const [channel, handler] of retained) { const name = channel.slice(V.length + 1) as contract.ProjectReadMethod; denied(await handler(owner, requests[name]), 'CAPABILITY_DENIED'); }
    assert.deepEqual(counters, stopped); await extension.shutdown();
  } finally { extension.revoke(); await extension.shutdown(); extension.dispose(); await arbiter.close(); }
});

test('independent wiring preload: actual source exposes only the fixed frozen bridge and validates requests and responses on both sides', async () => {
  const sourcePath = path.resolve('apps/desktop/src/preload/agent-project-read.ts'), source = fs.readFileSync(sourcePath, 'utf8');
  process.stdout.write(JSON.stringify({ independentlyLoadedPreload: { path: 'apps/desktop/src/preload/agent-project-read.ts', sha256: createHash('sha256').update(source).digest('hex') } }) + '\n');
  let name: string | undefined, bridge: Record<string, (input: unknown) => Promise<unknown>> | undefined, response: unknown = { ok: false, error: { code: 'CAPABILITY_DENIED' } };
  const calls: { channel: string; input: unknown }[] = [];
  const electron = { contextBridge: { exposeInMainWorld(key: string, value: typeof bridge) { assert.equal(bridge, undefined); name = key; bridge = value; } }, ipcRenderer: { async invoke(channel: string, input: unknown) { calls.push({ channel, input }); return response; } } };
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true } }).outputText;
  vm.runInNewContext(output, { exports: {}, require(specifier: string) { if (specifier === 'electron') return electron; if (specifier === '../shared/agent/agent-project-read') return contract; if (specifier === '../shared/agent/agent-project-read-validation') return validation; throw Error('Unexpected preload import: ' + specifier); } }, { filename: sourcePath, timeout: 1000 });
  assert.equal(name, 'workbenchAgentProjectRead'); assert.ok(bridge && Object.isFrozen(bridge)); assert.deepEqual(Object.keys(bridge).sort(), [...names].sort());
  for (const method of names) {
    const invoke = bridge[method]!;
    denied(await invoke({ ...requests[method], path: 'R:\\Synthetic\\Forbidden.txt' }), 'INVALID_REQUEST'); assert.equal(calls.length, 0);
  }
  for (const method of names) {
    denied(await bridge[method]!(requests[method]), 'CAPABILITY_DENIED'); const latest = calls.at(-1)!; assert.equal(latest.channel, V + ':' + method); assert.deepEqual(latest.input, requests[method]);
  }
  assert.equal(calls.length, 33);
  response = { ok: true, value: { runs: [], nextBefore: null } }; assert.deepEqual(await bridge.listRuns!(requests.listRuns), response);
  let getterCalls = 0;
  for (const invalid of [{ ok: true, value: { runs: [], nextBefore: null }, hiddenKey: 'synthetic-key' }, { ok: true, value: { runs: [], nextBefore: null, arbitraryPath: 'outside' } }, Object.defineProperty({}, 'ok', { enumerable: true, get() { getterCalls++; return true; } })]) { response = invalid; denied(await bridge.listRuns!(requests.listRuns), 'ENGINE_FAILED'); }
  assert.equal(getterCalls, 0);
});
