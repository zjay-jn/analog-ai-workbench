import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createBoundedShutdown, createInitializationShutdown } from '../apps/desktop/src/main/engine-live/shutdown';
import { createCloudDesktopOptions, startCloudDesktop, type CloudDesktopDependencies } from '../apps/desktop/src/main/engine-live/cloud-bootstrap';
import { PILOT_VERSION, parsePilotResult, pilotChannel } from '../apps/desktop/src/shared/agent/engine-pilot';
import { SETTINGS_VERSION, settingsChannel, parseSettingsResult } from '../apps/desktop/src/shared/agent/model-settings';
import { SESSION_VERSION, sessionChannel, parseSessionResult } from '../apps/desktop/src/shared/agent/chat-sessions';
import { createPilotStore } from '../apps/desktop/src/main/engine-pilot/store';
import { GET_INFO_CHANNEL } from '../apps/desktop/src/shared/app-info';
import type { DesktopBootstrapOptionsV1 } from '../apps/desktop/src/main/bootstrap';

const productRoot = path.resolve('C:/work/analog_ai_workbench');
const owner = { senderId: 1, isTopFrame: true, appOrigin: 'null', navigationEpoch: 1, appSessionId: 'cloud.qa', windowId: 'cloud.qa', webContentsId: 1, workspaceId: 'cloud.qa', rootId: 'cloud.qa' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const dataRoot = path.join(productRoot, '.local', 'agent-engine-live-tests', randomUUID());
  const calls = { credentials: 0, cloud: 0, native: 0, source: 0 };
  const dependencies: CloudDesktopDependencies = {
    credentials: () => { calls.credentials++; return { deepseek: 'sk-synthetic_bootstrap_only' }; },
    encryption: { available: () => false, encrypt: () => { throw Error('unused encryption'); }, decrypt: () => { throw Error('unused encryption'); } },
    chatV1: async () => { calls.cloud++; throw Error('unexpected cloud'); },
    chatV2: async () => { calls.cloud++; throw Error('unexpected cloud'); },
    providerFetch: async () => { calls.cloud++; throw Error('unexpected provider'); },
    nativeFactory: async () => { calls.native++; throw Error('unexpected native'); },
    liveBudget: { maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600_000, deadlineMs: 600_000, waitMs: 1_800_000 },
    loadReviewed: () => { calls.source++; throw Error('unexpected reviewed source'); },
    loadSynthetic: () => { calls.source++; throw Error('unexpected synthetic source'); },
  };
  return { calls, options: { mode: 'qa' as const, applicationRoot: productRoot, dataRoot, profileRoot: path.join(dataRoot, 'electron-profile'), dependencies } };
}
function removeOwnFixture(directory: string) {
  const resolved = path.resolve(directory);
  assert.match(path.relative(productRoot, resolved).replaceAll('\\', '/'), /^\.local\/agent-engine-live-tests\/[0-9a-f-]{36}$/u);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

test('live shutdown publishes one promise, synchronously revokes all owners, and awaits cleanup before disposal', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let nested: Promise<void> | undefined;
  const closing = createBoundedShutdown({ participants: [
    { revoke() { order.push('tool.revoke'); nested = closing.shutdown(); }, shutdown: async () => { order.push('tool.cleanup'); await gate; order.push('tool.exited'); }, dispose() { order.push('tool.dispose'); } },
    { revoke() { order.push('chat.revoke'); }, dispose() { order.push('chat.dispose'); } },
  ] });
  const pending = closing.shutdown();
  assert.equal(nested, pending);
  assert.equal(closing.shutdown(), pending);
  assert.deepEqual(order, ['tool.revoke', 'chat.revoke']);
  await tick(); assert.deepEqual(order, ['tool.revoke', 'chat.revoke', 'tool.cleanup']);
  release(); await pending;
  assert.deepEqual(order, ['tool.revoke', 'chat.revoke', 'tool.cleanup', 'tool.exited', 'tool.dispose', 'chat.dispose']);
});

test('live shutdown isolates revoke, shutdown, observer and dispose exceptions while reporting fixed failures', async () => {
  const order: string[] = [], reported: string[] = [];
  const closing = createBoundedShutdown({ participants: [
    { revoke() { order.push('broken.revoke'); throw Error('sensitive original'); }, async shutdown() { throw Error('sensitive rejection'); }, dispose() { order.push('broken.dispose'); throw Error('sensitive dispose'); } },
    { revoke() { order.push('tool.revoke'); }, async shutdown() { order.push('tool.exit'); }, dispose() { order.push('tool.dispose'); } },
  ], onFailure(code) { reported.push(code); throw Error('observer failure'); } });
  await assert.rejects(closing.shutdown(), { message: 'CLOUD_SHUTDOWN_FAILED' });
  assert.deepEqual(reported, ['CLOUD_SHUTDOWN_FAILED']);
  assert.deepEqual(order, ['broken.revoke', 'tool.revoke', 'tool.exit', 'broken.dispose', 'tool.dispose']);
});

test('live shutdown has one total deadline and still disposes all participants when an owner never settles', async () => {
  const disposed: string[] = [], reported: string[] = [];
  const closing = createBoundedShutdown({ timeoutMs: 10, onFailure: code => { reported.push(code); }, participants: [
    { revoke() {}, shutdown: () => new Promise<void>(() => {}), dispose() { disposed.push('hung'); } },
    { revoke() {}, async shutdown() {}, dispose() { disposed.push('other'); } },
  ] });
  const pending = closing.shutdown();
  assert.equal(closing.shutdown(), pending);
  await assert.rejects(pending, { message: 'CLOUD_SHUTDOWN_TIMEOUT' });
  assert.deepEqual(reported, ['CLOUD_SHUTDOWN_TIMEOUT']);
  assert.deepEqual(disposed, ['hung', 'other']);
});

test('live cloud QA preparation rejects missing isolation or injected dependencies without any I/O fallback', async () => {
  const f = fixture();
  const options = createCloudDesktopOptions(f.options);
  assert.equal(options.applicationRoot, productRoot);
  assert.equal(options.preloadEntry, 'sessions.js');
  assert.deepEqual(f.calls, { credentials: 0, cloud: 0, native: 0, source: 0 });
  assert.equal(fs.existsSync(f.options.dataRoot), false);
  for (const key of ['credentials', 'encryption', 'chatV1', 'chatV2', 'providerFetch', 'nativeFactory', 'liveBudget', 'loadReviewed', 'loadSynthetic']) {
    const dependencies = { ...f.options.dependencies } as Record<string, unknown>;
    delete dependencies[key];
    const invalid = { ...f.options, dependencies } as unknown as typeof f.options;
    assert.throws(() => createCloudDesktopOptions(invalid), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
    await assert.rejects(startCloudDesktop(invalid), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
  }
  for (const key of Object.keys(f.options.dependencies.liveBudget)) {
    const liveBudget = { ...f.options.dependencies.liveBudget } as Record<string, number>;
    delete liveBudget[key];
    assert.throws(() => createCloudDesktopOptions({ ...f.options, dependencies: { ...f.options.dependencies, liveBudget } } as unknown as typeof f.options), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
  }
  for (const liveBudget of [
    { ...f.options.dependencies.liveBudget, maxRequests: 9 },
    { ...f.options.dependencies.liveBudget, requestTimeoutMs: 600_001 },
    { ...f.options.dependencies.liveBudget, deadlineMs: 4_800_001 },
    { ...f.options.dependencies.liveBudget, waitMs: 0 },
  ]) assert.throws(() => createCloudDesktopOptions({ ...f.options, dependencies: { ...f.options.dependencies, liveBudget } }), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
  for (const delta of [
    { dataRoot: path.join(productRoot, '.local') },
    { profileRoot: path.join(productRoot, '.local', 'cloud-user-data') },
    { applicationRoot: path.resolve('C:/work/analog_ai_lab') },
  ]) assert.throws(() => createCloudDesktopOptions({ ...f.options, ...delta }), { message: 'CLOUD_BOOTSTRAP_CONFIGURATION' });
  assert.deepEqual(f.calls, { credentials: 0, cloud: 0, native: 0, source: 0 });
  assert.equal(fs.existsSync(f.options.dataRoot), false);
});

test('normal cloud composition shares settings with live tools, reads only isolated stores, and status/history never start native or cloud', async () => {
  const f = fixture(), handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
  const options = createCloudDesktopOptions(f.options);
  type Context = Parameters<NonNullable<typeof options.registerExtension>>[0];
  const ipcMain = { removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, value: unknown) => unknown) { handlers.set(channel, handler); } } as unknown as Context['ipcMain'];
  const extension = options.registerExtension!({ ipcMain, owner, deriveCallerContext: () => owner });
  const invoke = async (channel: string, value: unknown) => { const handler = handlers.get(channel); assert.ok(handler); return handler({}, value); };
  try {
    await tick();
    assert.equal(f.calls.credentials, 1);
    const status = parsePilotResult('getStatus', await invoke(pilotChannel('getStatus'), { contractVersion: PILOT_VERSION }));
    assert.ok(status.ok); if (status.ok) { assert.equal(status.value.canStart, true); assert.equal(status.value.ready, false); assert.equal(status.value.processState, 'idle'); }
    const history = parsePilotResult('listRuns', await invoke(pilotChannel('listRuns'), { contractVersion: PILOT_VERSION }));
    assert.ok(history.ok);
    const chat = parseSessionResult(await invoke(sessionChannel('readState'), { contractVersion: SESSION_VERSION }));
    assert.ok(chat.ok);
    const changed = parseSettingsResult(await invoke(settingsChannel('saveSettings'), { contractVersion: SETTINGS_VERSION, provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp', keyAction: 'retain', apiKey: '' }));
    assert.ok(changed.ok);
    const next = parsePilotResult('getStatus', await invoke(pilotChannel('getStatus'), { contractVersion: PILOT_VERSION }));
    assert.ok(next.ok); if (next.ok) { assert.equal(next.value.canStart, false); assert.equal(next.value.availability, 'unsupported_model'); }
    assert.deepEqual(f.calls, { credentials: 1, cloud: 0, native: 0, source: 0 });
    assert.deepEqual(fs.readdirSync(f.options.dataRoot).sort(), ['agent-engine-live', 'agent-project-read', 'agent-project-read-model', 'chat-drafts', 'chat-history', 'display-paths', 'model-settings', 'project-folders', 'project-workspace']);
    const pending = extension.shutdown!();
    assert.equal(extension.shutdown!(), pending);
    assert.deepEqual(await invoke(settingsChannel('readSettings'), { contractVersion: SETTINGS_VERSION }), { ok: false, error: { code: 'CAPABILITY_DENIED' } });
    await pending;
    assert.equal(handlers.size, 0);
    assert.equal(fs.existsSync(path.join(f.options.dataRoot, 'agent-engine-live', 'writer.lock')), false);
  } finally { await extension.shutdown?.().catch(() => {}); extension.dispose(); removeOwnFixture(f.options.dataRoot); }
});

test('a held tool-store lock disables only tool tasks and does not overwrite its owner or disable cloud chat', async () => {
  const f = fixture(), directory = path.join(f.options.dataRoot, 'agent-engine-live');
  const ownerStore = createPilotStore(productRoot, directory);
  const lockBefore = fs.readFileSync(path.join(directory, 'writer.lock'), 'utf8');
  const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
  const options = createCloudDesktopOptions(f.options);
  type Context = Parameters<NonNullable<typeof options.registerExtension>>[0];
  const ipcMain = { removeHandler(channel: string) { handlers.delete(channel); }, handle(channel: string, handler: (event: unknown, value: unknown) => unknown) { handlers.set(channel, handler); } } as unknown as Context['ipcMain'];
  const extension = options.registerExtension!({ ipcMain, owner, deriveCallerContext: () => owner });
  try {
    await tick();
    assert.deepEqual(await handlers.get(pilotChannel('getStatus'))!({}, { contractVersion: PILOT_VERSION }), { ok: false, error: { code: 'STORAGE_FAILED' } });
    const chat = parseSessionResult(await handlers.get(sessionChannel('readState'))!({}, { contractVersion: SESSION_VERSION }));
    assert.ok(chat.ok);
    await extension.shutdown!();
    assert.equal(fs.readFileSync(path.join(directory, 'writer.lock'), 'utf8'), lockBefore);
    assert.deepEqual(f.calls, { credentials: 1, cloud: 0, native: 0, source: 0 });
  } finally { await extension.shutdown?.().catch(() => {}); ownerStore.close(); removeOwnFixture(f.options.dataRoot); }
});

async function bootstrapConstructionFailure(failure: 'extension' | 'after-extension') {
  const f = fixture(), handlers = new Map<string, (...args: unknown[]) => unknown>();
  const exits: number[] = [], order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let extensionReturned = false;
  const failureChannel = failure === 'extension' ? sessionChannel('readState') : GET_INFO_CHANNEL;
  const ipcMain = {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(channel, handler);
      if (channel === failureChannel) throw Error('synthetic registration failure');
    },
    removeHandler(channel: string) { handlers.delete(channel); },
  };
  const session = Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} });
  class FakeWindow extends EventEmitter {
    id = 1;
    webContents = Object.assign(new EventEmitter(), { id: 1, session, setWindowOpenHandler() {}, isDestroyed: () => false });
    setMenu() {}
    isDestroyed() { return false; }
    async loadFile() { throw Error('failed initialization must not load a renderer'); }
  }
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getVersion: () => 'test',
    exit(code: number) { order.push('app.exit'); exits.push(code); },
    quit() { throw Error('unexpected normal quit'); },
  });
  const electron = { app, ipcMain, BrowserWindow: FakeWindow, Menu: {}, dialog: {} };
  const moduleLoader = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  const entry = require.resolve('../apps/desktop/src/main/bootstrap');
  const previousEntry = require.cache[entry];
  const macro = globalThis as typeof globalThis & { __AAW_MAIN_DEVELOPMENT__?: boolean };
  const originalMacro = macro.__AAW_MAIN_DEVELOPMENT__;
  let start: typeof import('../apps/desktop/src/main/bootstrap')['startDesktopAppV1'];
  try {
    moduleLoader._load = (request, parent, isMain) => request === 'electron' ? electron : originalLoad(request, parent, isMain);
    delete require.cache[entry];
    start = (require(entry) as typeof import('../apps/desktop/src/main/bootstrap')).startDesktopAppV1;
  } finally { moduleLoader._load = originalLoad; }
  macro.__AAW_MAIN_DEVELOPMENT__ = false;
  const options = createCloudDesktopOptions(f.options), register = options.registerExtension!;
  const registerExtension: NonNullable<DesktopBootstrapOptionsV1['registerExtension']> = context => {
    assert.equal(typeof context.registerCleanup, 'function');
    const result = register({ ...context, registerCleanup(participant) {
      context.registerCleanup!({
        revoke: participant.revoke, dispose: participant.dispose,
        async shutdown() {
          order.push('partial.cleanup.started');
          await gate;
          await participant.shutdown?.();
          order.push('partial.cleanup.finished');
        },
      });
    } });
    extensionReturned = true;
    return result;
  };
  try {
    start!({ ...options, registerExtension });
    await tick(); await tick();
    assert.equal(extensionReturned, failure === 'after-extension');
    assert.deepEqual(exits, []);
    assert.equal(order.includes('partial.cleanup.started'), true);
    assert.equal(order.includes('partial.cleanup.finished'), false);
    assert.equal(handlers.size, 0, 'partially installed handlers must be synchronously removed');
    assert.deepEqual(f.calls, { credentials: 1, cloud: 0, native: 0, source: 0 });
    release();
    await tick(); await tick();
    assert.deepEqual(exits, [1]);
    assert.ok(order.indexOf('partial.cleanup.finished') < order.indexOf('app.exit'));
    assert.equal(fs.existsSync(path.join(f.options.dataRoot, 'agent-engine-live', 'writer.lock')), false);
  } finally {
    release(); await tick();
    if (previousEntry) require.cache[entry] = previousEntry; else delete require.cache[entry];
    if (originalMacro === undefined) delete macro.__AAW_MAIN_DEVELOPMENT__; else macro.__AAW_MAIN_DEVELOPMENT__ = originalMacro;
    removeOwnFixture(f.options.dataRoot);
  }
}

test('normal bootstrap awaits registered partial cloud cleanup when the actual extension constructor throws', async () => {
  await bootstrapConstructionFailure('extension');
});

test('normal bootstrap awaits cloud cleanup when a later base IPC registration throws after extension return', async () => {
  await bootstrapConstructionFailure('after-extension');
});

test('initialization shutdown barrier owns and awaits a participant acquired during synchronous quit reentry', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scope = createInitializationShutdown({});
  const pending = scope.shutdown();
  assert.throws(() => scope.register({
    revoke() { order.push('late.revoke'); },
    async shutdown() { order.push('late.cleanup'); await gate; order.push('late.exited'); },
    dispose() { order.push('late.dispose'); },
  }), { message: 'CLOUD_SHUTDOWN_STARTED' });
  assert.deepEqual(order, ['late.revoke']);
  await tick();
  assert.deepEqual(order, ['late.revoke'], 'cleanup cannot snapshot participants before construction finally');
  scope.completeConstruction();
  await tick();
  assert.deepEqual(order, ['late.revoke', 'late.cleanup']);
  release(); await pending;
  assert.deepEqual(order, ['late.revoke', 'late.cleanup', 'late.exited', 'late.dispose']);
  assert.equal(scope.shutdown(), pending);
});
