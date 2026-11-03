import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {parseSmokeOptions, assertFirstProfile, assertUnaliased, runDesktopSmoke, smokeAddonPin, checkoutRoot, artifactRoot} from '../tools/portable-desktop-smoke.mjs';

const cases = path.join(checkoutRoot, '.local/desktop-smoke-unit');
fs.mkdirSync(cases, {recursive: true});
const fixture = () => fs.mkdtempSync(path.join(cases, 'case-'));
const external = path.resolve(checkoutRoot, '../aaw-portable-ci-synthetic');

test('smoke requires explicit dedicated storage and fixes the application to this checkout', () => {
  assert.equal(parseSmokeOptions([`--storage-root=${external}`]).storageRoot, external);
  assert.equal(parseSmokeOptions([`--storage-root=${path.join(artifactRoot, 'profile')}`]).phase, 'both');
  for (const values of [[], ['--storage-root=relative'], [`--storage-root=${path.dirname(external)}`],
    [`--storage-root=${artifactRoot}`], [`--storage-root=${external}`, `--app-root=${path.dirname(checkoutRoot)}`],
    [`--storage-root=${external}`, '--phase=erase'], [`--storage-root=${external}`, `--storage-root=${external}`],
    [`--storage-root=${external}`, '--unknown=ignored']]) assert.throws(() => parseSmokeOptions(values));
});

test('forbidden roots are compared without inspecting them and must not overlap test data', () => {
  const missing = path.resolve(checkoutRoot, `../aaw-forbidden-never-created-${randomUUID()}`);
  assert.deepEqual(parseSmokeOptions([`--storage-root=${external}`, `--forbidden-root=${missing}`]).forbiddenRoots, [missing]);
  assert.equal(fs.existsSync(missing), false);
  for (const denied of [checkoutRoot, path.dirname(checkoutRoot), external, path.join(external, 'private')]) {
    assert.throws(() => parseSmokeOptions([`--storage-root=${external}`, `--forbidden-root=${denied}`]), /FORBIDDEN_ROOT_OVERLAPS_TEST/);
  }
});

test('the actual wrapper rejects an occupied profile before locating Electron or spawning it', () => {
  const profile = path.join(artifactRoot, `unit-profile-${randomUUID()}`), directory = path.join(profile, '.local/project-workspace');
  fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, 'workspace.json'); fs.writeFileSync(file, 'synthetic occupied workspace');
  assert.throws(() => runDesktopSmoke([`--storage-root=${profile}`]), /FIRST_PROFILE_NOT_EMPTY/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic occupied workspace');
});

test('first run refuses existing sensitive files without reading or deleting their bytes', () => {
  for (const directory of ['model-settings', 'chat-history', 'chat-drafts', 'project-workspace', 'project-folders', 'display-paths',
    'agent-engine-live', 'agent-project-read', 'agent-work-cycle', 'agent-project-read-model', 'agent-engine-pilot/conversations']) {
    const root = fixture(); assertFirstProfile(root);
    const store = path.join(root, '.local', directory); fs.mkdirSync(store, {recursive: true});
    const file = path.join(store, 'pending.synthetic'); fs.writeFileSync(file, 'synthetic fixture; never a credential');
    assert.throws(() => assertFirstProfile(root), /FIRST_PROFILE_NOT_EMPTY/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic fixture; never a credential');
  }
});

test('native setup evidence and an empty Chromium profile do not imply a prior workspace', () => {
  const root = fixture();
  for (const directory of ['agent-command', 'cloud-user-data']) fs.mkdirSync(path.join(root, '.local', directory), {recursive: true});
  fs.writeFileSync(path.join(root, '.local/agent-command/synthetic-result.json'), '{}');
  assert.doesNotThrow(() => assertFirstProfile(root));
});

test('profile ancestor and sensitive store aliases fail before traversing an external directory', () => {
  const root = fixture(), outside = fixture(), alias = path.join(root, 'alias');
  fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertUnaliased(path.join(alias, 'profile')), /SMOKE_SCOPE_ALIASED/);
  const profile = path.join(root, 'profile'), directory = path.join(profile, '.local'); fs.mkdirSync(directory, {recursive: true});
  fs.symlinkSync(outside, path.join(directory, 'model-settings'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertFirstProfile(profile), /SMOKE_SCOPE_ALIASED/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('addon admission binds the fixed path, manifest storage, exact bytes and SHA without loading code', () => {
  const root = fixture(), storage = path.join(root, 'profile'), relative = '.local/runtime/native/windows-fs-native.node';
  const file = path.join(root, relative), manifestFile = path.join(root, '.local/runtime/runtime-manifest.json');
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'synthetic bytes, never loaded');
  const component = {path: relative, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
  const manifest = {schemaVersion: 'aaw.desktop-runtime/v1', platform: 'win32', arch: 'x64', dataRoot: path.join(storage, '.local'), components: {windowsFs: component}};
  const save = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest)); save();
  assert.deepEqual(smokeAddonPin(root, storage), {...component, path: file});
  assert.throws(() => smokeAddonPin(root, path.join(root, 'another-profile')), /SMOKE_ADDON_MANIFEST_INVALID/);
  component.path = '../outside.node'; save(); assert.throws(() => smokeAddonPin(root, storage), /SMOKE_ADDON_MANIFEST_INVALID/);
  component.path = relative; component.bytes++; save(); assert.throws(() => smokeAddonPin(root, storage), /SMOKE_ADDON_PIN_MISMATCH/);
  component.bytes--; component.sha256 = '0'.repeat(64); save(); assert.throws(() => smokeAddonPin(root, storage), /SMOKE_ADDON_PIN_MISMATCH/);
});

test('addon admission rejects a hardlinked component even when its content matches the manifest', () => {
  const root = fixture(), storage = path.join(root, 'profile'), relative = '.local/runtime/native/windows-fs-native.node';
  const file = path.join(root, relative), manifestFile = path.join(root, '.local/runtime/runtime-manifest.json');
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, 'synthetic not native');
  const component = {path: relative, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
  fs.writeFileSync(manifestFile, JSON.stringify({schemaVersion: 'aaw.desktop-runtime/v1', platform: 'win32', arch: 'x64', dataRoot: path.join(storage, '.local'), components: {windowsFs: component}}));
  fs.linkSync(file, path.join(root, 'alias.node'));
  assert.throws(() => smokeAddonPin(root, storage), /RUNTIME_NOT_ORDINARY/);
});
