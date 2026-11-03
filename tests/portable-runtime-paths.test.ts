import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {configureRuntimePaths, createRuntimePaths, runtimePaths} from '../apps/desktop/src/main/runtime-paths';
import {createPilotStore} from '../apps/desktop/src/main/engine-pilot/store';
import {createProjectReadModelSelection} from '../apps/desktop/src/main/agent-project-read/model-selection';
import {createNativeConversationStore, nativeHistoryHash} from '../apps/desktop/src/main/agent-project-read/native-conversation-store';
import {createCloudDesktopOptions, type CloudDesktopDependencies} from '../apps/desktop/src/main/engine-live/cloud-bootstrap';
import {createOpenCodePilotClient} from '../apps/desktop/src/main/engine-pilot/opencode-client';

const installationRoot = path.resolve(process.cwd());
const parent = path.join(installationRoot, '.local', 'portable-path-tests');
fs.mkdirSync(parent, {recursive: true});
const sandbox = fs.mkdtempSync(path.join(parent, 'case-'));
const storageRoot = path.join(sandbox, 'user-data');
fs.mkdirSync(storageRoot);
const locations = configureRuntimePaths({installationRoot, storageRoot});

const dependencies: CloudDesktopDependencies = {
  credentials: () => ({}), encryption: {available: () => false, encrypt: () => {throw Error('unused');}, decrypt: () => {throw Error('unused');}},
  chatV1: async () => {throw Error('no provider');}, chatV2: async () => {throw Error('no provider');},
  providerFetch: async () => {throw Error('no provider');}, nativeFactory: async () => {throw Error('no native');},
  liveBudget: {maxRequests: 8, maxOutputTokens: 16384, requestTimeoutMs: 600000, deadlineMs: 600000, waitMs: 1800000},
  loadReviewed: () => {throw Error('no private source');}, loadSynthetic: () => {throw Error('unused');},
};

test('installation assets and mutable user storage use separate roots and preserve existing .local shapes', () => {
  assert.equal(locations.installationRoot, installationRoot);
  assert.equal(locations.storageRoot, storageRoot);
  assert.equal(locations.dataRoot, path.join(storageRoot, '.local'));
  assert.equal(locations.pilotRoot, path.join(locations.dataRoot, 'agent-engine-pilot'));
  assert.equal(locations.opencodeExecutable, path.join(installationRoot, '.local/runtime/opencode/1.18.17/opencode.exe'));
  assert.equal(runtimePaths(), locations);
  assert(Object.isFrozen(locations));
  for (const root of ['relative', path.parse(installationRoot).root]) assert.throws(() => createRuntimePaths({installationRoot: root, storageRoot}));
  assert.throws(() => configureRuntimePaths({installationRoot, storageRoot: path.join(sandbox, 'other')}), /ALREADY_CONFIGURED/);
  assert.equal(configureRuntimePaths({installationRoot, storageRoot}), locations);
});

test('bootstrap accepts only the main-configured installation/storage anchors and exact QA profile scope', () => {
  const dataRoot = path.join(locations.dataRoot, 'agent-engine-live-tests', randomUUID());
  const options = {mode: 'qa' as const, applicationRoot: installationRoot, storageRoot, dataRoot, profileRoot: path.join(dataRoot, 'profile'), dependencies};
  assert.equal(createCloudDesktopOptions(options).applicationRoot, installationRoot);
  assert.equal(fs.existsSync(dataRoot), false, 'preparing options is pure, including optional integrations');
  assert.throws(() => createCloudDesktopOptions({...options, applicationRoot: sandbox}), /CLOUD_BOOTSTRAP_CONFIGURATION/);
  assert.throws(() => createCloudDesktopOptions({...options, storageRoot: installationRoot}), /CLOUD_BOOTSTRAP_CONFIGURATION/);
  assert.throws(() => createCloudDesktopOptions({...options, dataRoot: path.join(storageRoot, 'arbitrary')}), /CLOUD_BOOTSTRAP_CONFIGURATION/);
  assert.throws(() => createCloudDesktopOptions({...options, profileRoot: sandbox}), /CLOUD_BOOTSTRAP_CONFIGURATION/);
});

test('pilot and model stores persist under the main data root and reject another installation as storage', () => {
  const pilot = createPilotStore(storageRoot);
  try { assert.deepEqual(pilot.load(), {version: 1, runs: []}); } finally { pilot.close(); }
  const models = createProjectReadModelSelection(storageRoot, locations.dataRoot);
  assert.equal(models.load().provider, 'kimi');
  assert.throws(() => createPilotStore(installationRoot));
  assert.throws(() => createProjectReadModelSelection(installationRoot, path.join(installationRoot, '.local')));
  assert.throws(() => createProjectReadModelSelection(storageRoot, path.join(storageRoot, 'other')));
});

test('native conversation bindings survive reopen only inside the configured private data root', () => {
  const store = createNativeConversationStore();
  const id = randomUUID();
  const binding = {version: 1 as const, conversationId: id, sessionId: 'ses_synthetic_portable', migrationHash: 'a'.repeat(64), migrationComplete: true, externalTurnIds: [], historyCount: 0, historyHash: nativeHistoryHash([]), pending: false};
  store.save(binding);
  assert.deepEqual(createNativeConversationStore().load(id), binding);
  assert.throws(() => createNativeConversationStore(path.join(sandbox, 'outside')));
  assert(fs.existsSync(path.join(locations.pilotRoot, 'conversations/bindings', id + '.json')));
});

test('pilot storage rejects a junction rather than writing through it', () => {
  const destination = path.join(sandbox, 'unrelated'); fs.mkdirSync(destination);
  const alias = path.join(locations.dataRoot, 'agent-engine-live');
  fs.symlinkSync(destination, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createPilotStore(storageRoot, alias));
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('native client can only bind the configured pilot directory, never a sibling or old installation', () => {
  const options = {port: 43001, password: 'a'.repeat(64), directory: path.join(locations.pilotRoot, 'native', randomUUID(), 'cwd')};
  assert.doesNotThrow(() => createOpenCodePilotClient(options));
  assert.throws(() => createOpenCodePilotClient({...options, directory: path.join(storageRoot, 'other/cwd')}));
  assert.throws(() => createOpenCodePilotClient({...options, directory: path.join(installationRoot, '.local/agent-engine-pilot/native/old/cwd')}));
});
