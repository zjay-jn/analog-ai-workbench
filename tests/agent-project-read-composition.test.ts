import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCloudDesktopOptions, type CloudDesktopDependencies } from '../apps/desktop/src/main/engine-live/cloud-bootstrap';
import { AGENT_PROJECT_READ_VERSION as V, PROJECT_READ_METHODS, type ProjectReadMethod, type ProjectReadRequests, type WorkbenchAgentProjectReadApi } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadResult } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { PROJECT_FOLDERS_VERSION as F, projectFolderChannel, parseProjectFolderResult } from '../apps/desktop/src/shared/agent/project-folders';
import { PILOT_VERSION, pilotChannel, parsePilotResult } from '../apps/desktop/src/shared/agent/engine-pilot';
import { SESSION_VERSION, sessionChannel, parseSessionResult } from '../apps/desktop/src/shared/agent/chat-sessions';
import { createProjectReadStore } from '../apps/desktop/src/main/agent-project-read/store';

const root = path.resolve('C:/work/analog_ai_workbench'), parent = path.join(root, '.local', 'agent-engine-live-tests');
const owner = { senderId: 1, isTopFrame: true, appOrigin: 'null', navigationEpoch: 1, appSessionId: 'project.qa', windowId: 'project.qa', webContentsId: 1, workspaceId: 'project.qa', rootId: 'project.qa' };
const good = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!value.ok) return assert.fail(JSON.stringify(value)); return value.value; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const dataRoot = path.join(parent, randomUUID()), source = path.join(dataRoot, 'source'); fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(path.join(source, 'notes.txt'), 'Only synthetic text.');
  const calls = { credentialFixture: 0, network: 0, native: 0, artifact: 0 };
  const dependencies: CloudDesktopDependencies = {
    credentials() { calls.credentialFixture++; return { deepseek: 'sk-synthetic_composition_fixture' }; },
    encryption: { available: () => false, encrypt: () => assert.fail('encryption'), decrypt: () => assert.fail('decryption') },
    chatV1: async () => { calls.network++; return assert.fail('chat'); }, chatV2: async () => { calls.network++; return assert.fail('chat'); },
    providerFetch: async () => { calls.network++; return assert.fail('provider'); }, nativeFactory: async () => { calls.native++; return assert.fail('native'); },
    liveBudget: { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000, deadlineMs: 600000, waitMs: 1800000 },
    loadReviewed: () => { calls.artifact++; return assert.fail('reviewed artifact'); }, loadSynthetic: () => { calls.artifact++; return assert.fail('schematic'); }, chooseFolder: async () => source,
  };
  const options = createCloudDesktopOptions({ mode: 'qa', applicationRoot: root, dataRoot, profileRoot: path.join(dataRoot, 'profile'), dependencies });
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>(); let forged = false;
  type Context = Parameters<NonNullable<typeof options.registerExtension>>[0];
  const ipcMain = { removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, request: unknown) => unknown) { handlers.set(channel, handler); } } as unknown as Context['ipcMain'];
  const construct = () => options.registerExtension!({ ipcMain, owner, deriveCallerContext: () => forged ? { ...owner, isTopFrame: false } : owner });
  const invoke = async (channel: string, request: unknown) => { const handler = handlers.get(channel); assert.ok(handler); return handler({}, request); };
  const project = async <M extends ProjectReadMethod>(method: M, request: Omit<ProjectReadRequests[M], 'contractVersion'>) => { const parsed = parseProjectReadResult(method, await invoke(V + ':' + method, { contractVersion: V, ...request })); assert.ok(parsed); return parsed; };
  return { dataRoot, source, calls, handlers, ipcMain, construct, invoke, project, forge(value: boolean) { forged = value; },
    remove() { const resolved = fs.realpathSync.native(dataRoot); assert.equal(resolved, dataRoot); assert.match(path.relative(parent, resolved), /^[0-9a-f-]{36}$/u); fs.rmSync(resolved, { recursive: true }); },
  };
}

test('normal cloud composition exposes twelve bounded project methods with real project binding and a shared inspection lease', async () => {
  const f = fixture(); assert.equal(f.calls.credentialFixture, 0); const extension = f.construct();
  try {
    assert.equal(f.handlers.size > 12, true); assert.deepEqual([...f.handlers.keys()].filter(key => key.startsWith(V + ':')).sort(), PROJECT_READ_METHODS.map(method => V + ':' + method).sort());
    const selected = parseProjectFolderResult('chooseFolder', await f.invoke(projectFolderChannel('chooseFolder'), { contractVersion: F, creationId: null })); assert.ok(selected.ok);
    const state = parseProjectFolderResult('readCreation', await f.invoke(projectFolderChannel('readCreation'), { contractVersion: F })); assert.ok(state.ok);
    const created = parseProjectFolderResult('saveCreation', await f.invoke(projectFolderChannel('saveCreation'), { contractVersion: F, creationId: selected.selection.creationId, ticketId: selected.selection.ticketId, name: 'Synthetic project', expectedRevision: state.workspace.revision })); assert.ok(created.ok); assert.ok(created.creation);
    const projectId = created.creation.projectId, bindingId = created.creation.binding.bindingId;
    assert.equal(good(await f.project('getStatus', { projectId })).canStart, true);
    assert.equal(good(await f.project('revalidateProject', { projectId, bindingId })).availability, 'available');
    const first = good(await f.project('browseProject', { projectId, bindingId, directoryId: null, cursor: null, refresh: false })); assert.equal(first.entries[0]?.name, 'notes.txt');
    const calculation = parsePilotResult('getStatus', await f.invoke(pilotChannel('getStatus'), { contractVersion: PILOT_VERSION })); assert.ok(calculation.ok); assert.equal(calculation.value.canStart, false);
    assert.equal(good(await f.project('getStatus', { projectId })).availability, 'busy');
    good(await f.project('cancelInspection', { projectId })); await tick();
    const ready = parsePilotResult('getStatus', await f.invoke(pilotChannel('getStatus'), { contractVersion: PILOT_VERSION })); assert.ok(ready.ok); assert.equal(ready.value.canStart, true);
    f.forge(true); assert.deepEqual(await f.project('listRuns', { projectId, before: null }), { ok: false, error: { code: 'CAPABILITY_DENIED' } }); f.forge(false);
    fs.renameSync(f.source, path.join(f.dataRoot, 'missing-source'));
    assert.equal(good(await f.project('getStatus', { projectId })).availability, 'available'); assert.equal(good(await f.project('listRuns', { projectId, before: null })).runs.length, 0);
    assert.equal(good(await f.project('revalidateProject', { projectId, bindingId })).availability, 'root_unavailable');
    assert.deepEqual(f.calls, { credentialFixture: 1, network: 0, native: 0, artifact: 0 });
    await extension.shutdown!(); assert.equal(f.handlers.size, 0);
    assert.equal(fs.existsSync(path.join(f.dataRoot, 'agent-project-read', 'writer.lock')), false);
  } finally { await extension.shutdown?.().catch(() => {}); extension.dispose(); f.remove(); }
});

test('project history lock failure preserves its owner and leaves calculation and ordinary chat available', async () => {
  const f = fixture(), store = createProjectReadStore(root, path.join(f.dataRoot, 'agent-project-read'));
  const before = fs.readdirSync(path.join(f.dataRoot, 'agent-project-read')).map(name => [name, fs.readFileSync(path.join(f.dataRoot, 'agent-project-read', name), 'utf8')]);
  const extension = f.construct();
  try {
    assert.deepEqual(await f.project('listRuns', { projectId: null, before: null }), { ok: false, error: { code: 'STORAGE_FAILED' } });
    assert.ok(parseSessionResult(await f.invoke(sessionChannel('readState'), { contractVersion: SESSION_VERSION })).ok);
    const calculation = parsePilotResult('getStatus', await f.invoke(pilotChannel('getStatus'), { contractVersion: PILOT_VERSION })); assert.ok(calculation.ok); assert.equal(calculation.value.canStart, true);
    await extension.shutdown!(); assert.deepEqual(fs.readdirSync(path.join(f.dataRoot, 'agent-project-read')).map(name => [name, fs.readFileSync(path.join(f.dataRoot, 'agent-project-read', name), 'utf8')]), before);
    assert.deepEqual(f.calls, { credentialFixture: 1, network: 0, native: 0, artifact: 0 });
  } finally { await extension.shutdown?.().catch(() => {}); store.close(); f.remove(); }
});

test('project preload publishes a frozen exact API and parses requests and replies without exposing arbitrary IPC', async () => {
  const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown }, original = loader._load;
  let exposed: WorkbenchAgentProjectReadApi | undefined, response: unknown = { ok: true, value: { runs: [], nextBefore: null } }; const sent: unknown[][] = [];
  try {
    loader._load = function (name, parentModule, main) { if (name === 'electron') return { contextBridge: { exposeInMainWorld(name: string, api: WorkbenchAgentProjectReadApi) { assert.equal(name, 'workbenchAgentProjectRead'); exposed = api; } }, ipcRenderer: { async invoke(...args: unknown[]) { sent.push(args); return response; } } }; return original(name, parentModule, main); };
    const preload = require.resolve('../apps/desktop/src/preload/agent-project-read'); delete require.cache[preload]; require(preload);
    assert.ok(exposed); assert.equal(Object.isFrozen(exposed), true); assert.deepEqual(Object.keys(exposed), [...PROJECT_READ_METHODS]);
    const request = { contractVersion: V, projectId: null, before: null } as const;
    good(await exposed.listRuns(request)); assert.deepEqual(sent, [[V + ':listRuns', request]]);
    assert.deepEqual(await exposed.listRuns({ ...request, path: 'forbidden' } as unknown as typeof request), { ok: false, error: { code: 'INVALID_REQUEST' } }); assert.equal(sent.length, 1);
    response = { ok: true, value: { runs: [], nextBefore: null, secret: 'synthetic' } }; assert.deepEqual(await exposed.listRuns(request), { ok: false, error: { code: 'ENGINE_FAILED' } });
  } finally { loader._load = original; }
});
