import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {parseInstalledSmokeOptions, installedSmokeEnvironment, validateInstalledProfile, validateInstalledReady,
  validateInstalledAddon, installedFreshBootName, installedOwnershipKey, validateInstalledOwnership, installedRendererMatches,
  installedFailureSnapshot, installedFailureDiagnostics, installedRendererProbe, captureInstalledPage, openInstalledSynthetic,
  checkoutRoot} from '../tools/installed-desktop-smoke.mjs';
import {assertFirstProfile} from '../tools/portable-desktop-smoke.mjs';

const digest = 'a'.repeat(64), other = 'b'.repeat(64);
const install = path.resolve(checkoutRoot, '.local/installed-smoke-unit/install/resources/app');
const storage = path.resolve(checkoutRoot, '.local/installed-smoke-unit/user/AnalogAIWorkbench');
const systemRoot = process.platform === 'win32' ? 'C:\\Windows' : '/synthetic-windows';
const exe = path.resolve(checkoutRoot, '.local/installed-smoke-unit/install/AnalogAIWorkbench.exe');
const nativeProfile = () => ({schema: 'aaw.packaged-native-profile/v1', profileRevision: digest, profile: {
  schema: 'aaw.packaged-command-profile/v1', policyRevision: 'aaw.packaged-command-policy/v1', installationRoot: install,
  runtimeRoot: path.join(install, '.local/runtime'), storageRoot: storage, dataRoot: path.join(storage, '.local'), systemRoot,
  userSidSha256: digest, shellVersion: '5.1', systemFiles: ['shell', 'shellConfig', 'automation', 'clr'].map(role => ({role,
    path: path.join(systemRoot, 'System32', role), bytes: 1, sha256: digest})),
  node: {bytes: 1, sha256: digest}, license: {bytes: 1, sha256: digest}, bootstrap: {bytes: 1, sha256: digest}}});
const context = () => ({appRoot: install, packageSha: digest, nativeProfile: nativeProfile(), options: {expectedExeSha: digest}});
const clone = value => JSON.parse(JSON.stringify(value));
function commitment() {
  const ctx = context(), attemptId = randomUUID(), common = {packageManifestSha256: digest, profileRevision: digest, attemptId,
    installationRoot: install, runtimeRoot: ctx.nativeProfile.profile.runtimeRoot, storageRoot: storage, dataRoot: ctx.nativeProfile.profile.dataRoot};
  return {ctx, record: {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'READY', ...common, nativeProfile: ctx.nativeProfile},
    result: {schemaVersion: 'aaw.packaged-initialization-result/v1', status: 'READY', ...common},
    factory: {schemaVersion: 'aaw.packaged-factory-inspection/v1', status: 'PASS', ...common,
      registeredWindowsDrivers: 1, commandAvailability: 'ready', hasRetainedWorkEntries: false, workAvailable: true}};
}

test('installed smoke accepts only an explicitly pinned executable and narrow phase arguments', () => {
  assert.deepEqual(parseInstalledSmokeOptions([`--exe=${exe}`, `--exe-sha256=${digest}`]), {exe, expectedExeSha: digest, phase: 'both'});
  assert.equal(parseInstalledSmokeOptions([`--exe=${exe}`, `--exe-sha256=${digest}`, '--phase=cold']).phase, 'cold');
  for (const args of [[], ['--exe=relative'], [`--exe=${exe}`], [`--exe=${exe}`, `--exe-sha256=${digest.toUpperCase()}`],
    [`--exe=${exe}`, `--exe-sha256=${digest}`, '--phase=erase'], [`--exe=${exe}`, `--exe-sha256=${digest}`, '--storage-root=profile'],
    [`--exe=${exe}`, `--exe=${exe}`, `--exe-sha256=${digest}`], [`--exe=${path.join(path.dirname(exe), 'node.exe')}`, `--exe-sha256=${digest}`],
    [`--exe=${exe}\0`, `--exe-sha256=${digest}`]]) assert.throws(() => parseInstalledSmokeOptions(args));
  if (process.platform === 'win32') for (const file of ['\\\\host\\share\\AnalogAIWorkbench.exe', 'C:\\demo\\AnalogAIWorkbench.exe:stream'])
    assert.throws(() => parseInstalledSmokeOptions([`--exe=${file}`, `--exe-sha256=${digest}`]));
});

test('child environment has System32-only PATH and no SDK, Node, Electron or secret inheritance', () => {
  const hostile = {Path: 'C:\\SDK;C:\\node', NODE_OPTIONS: '--require=hostile', node_path: 'hostile', ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_OVERRIDE_DIST_PATH: 'hostile', PYTHONPATH: 'hostile', PYTHONHOME: 'hostile', VCToolsInstallDir: 'hostile', VSINSTALLDIR: 'hostile',
    WindowsSdkDir: 'hostile', INCLUDE: 'hostile', LIB: 'hostile', OPENAI_API_KEY: 'synthetic', GH_TOKEN: 'synthetic',
    SystemRoot: 'wrong', APPDATA: 'wrong', USERNAME: 'synthetic-user', LOCALAPPDATA: 'synthetic-local'};
  const temporary = path.resolve(checkoutRoot, '.local/installed-smoke-unit/temp'), actual = installedSmokeEnvironment(nativeProfile(), hostile, temporary);
  assert.equal(actual.PATH, path.join(systemRoot, 'System32'));
  assert.equal(actual.SystemRoot, systemRoot); assert.equal(actual.APPDATA, path.dirname(storage));
  assert.equal(actual.TEMP, temporary); assert.equal(actual.TMP, temporary); assert.equal(actual.USERNAME, 'synthetic-user');
  for (const key of Object.keys(actual)) assert.doesNotMatch(key, /^(?:NODE|ELECTRON|PYTHON|VS|VC|WindowsSdk|INCLUDE$|LIB$|OPENAI|GH_)/iu);
  assert.equal(hostile.NODE_OPTIONS, '--require=hostile');
});

test('native profile binds the fixed installed and token-derived data layout', () => {
  assert.deepEqual(validateInstalledProfile(nativeProfile(), install), nativeProfile());
  for (const change of [value => {value.profile.installationRoot = path.dirname(install);}, value => {value.profile.dataRoot = install;},
    value => {value.profile.runtimeRoot = storage;}, value => {value.profile.storageRoot = path.join(install, 'AnalogAIWorkbench');},
    value => {value.profile.systemFiles[0].path = path.join(storage, 'shell');}, value => {value.profile.systemFiles.reverse();},
    value => {value.profileRevision = 'not-a-pin';}, value => {value.profile.userSidSha256 = '';}, value => {value.profile.shellVersion = '7';}]) {
    const value = nativeProfile(); change(value); assert.throws(() => validateInstalledProfile(value, install));
  }
});

test('READY requires the same finalized attempt and fresh factory capabilities', () => {
  const valid = commitment();
  assert.equal(validateInstalledReady(valid.record, valid.result, valid.factory, valid.ctx).registeredWindowsDrivers, 1);
  assert.throws(() => validateInstalledReady(valid.record, undefined, valid.factory, valid.ctx), /PACKAGED_FINAL_COMMIT_MISSING/);
  for (const [part, property, value] of [['record', 'status', 'NOT_READY'], ['record', 'nativeProfile', {}], ['record', 'dataRoot', install],
    ['result', 'attemptId', randomUUID()], ['result', 'schemaVersion', 'other'], ['result', 'runtimeRoot', storage],
    ['factory', 'packageManifestSha256', other], ['factory', 'registeredWindowsDrivers', 0], ['factory', 'commandAvailability', 'unavailable'],
    ['factory', 'hasRetainedWorkEntries', true], ['factory', 'hasRetainedWorkEntries', undefined], ['factory', 'workAvailable', false]]) {
    const changed = clone(valid); changed[part][property] = value;
    assert.throws(() => validateInstalledReady(changed.record, changed.result, changed.factory, changed.ctx));
  }
});

test('Electron ABI proof must pin the installed addon and all seven function exports', () => {
  const pin = {path: path.join(install, '.local/runtime/native/windows-fs-native.node'), bytes: 3, sha256: digest};
  const proof = {schemaVersion: 'aaw.packaged-electron-addon/v1', status: 'PASS', pin, electron: '43.4.0', node: '24.18.1',
    exports: ['getCapabilities', 'openValidatedRoot', 'inspectRelative', 'readVerifiedText', 'replaceVerifiedText', 'reconcileVerifiedText', 'closeRoot'].map(name => ({name, type: 'function'})),
    scope: 'Load and export type checks only; no native filesystem API called.'};
  assert.equal(validateInstalledAddon(proof, pin).loadOnly, true);
  for (const change of [value => {value.status = 'NOT_READY';}, value => {value.electron = '42.0.0';}, value => {value.node = 'not-node';},
    value => {value.pin.sha256 = other;}, value => {value.pin.path = path.join(storage, 'addon.node');}, value => {value.exports.pop();},
    value => {value.exports[0].type = 'object';}, value => {value.scope = 'Claims file save capability';}]) {
    const changed = clone(proof); change(changed); assert.throws(() => validateInstalledAddon(changed, pin));
  }
});

test('a preexisting successful addon record cannot stand in for this process boot', () => {
  const previous = 'boot-' + randomUUID(), fresh = 'boot-' + randomUUID();
  assert.equal(installedFreshBootName([previous, fresh], [previous]), fresh);
  for (const [current, old] of [[[previous], [previous]], [[previous, fresh], []], [['boot-../../elsewhere'], []], [['unknown'], []]])
    assert.throws(() => installedFreshBootName(current, old), /PACKAGED_FRESH_ADDON_PROOF_MISSING/);
});

test('cold ownership is exact and cannot borrow another build, user, attempt or summary', () => {
  const ctx = context(), owner = {schemaVersion: 'aaw.installed-desktop-smoke-ownership/v1', status: 'PASS', key: installedOwnershipKey(ctx),
    runId: randomUUID(), normalClose: true, appRoot: install, storageRoot: storage, userSidSha256: digest,
    packageSha: digest, expectedExeSha: digest, profileRevision: digest, marker: 'AAW installed smoke ' + randomUUID()};
  assert.equal(validateInstalledOwnership(owner, ctx), owner.marker);
  for (const [key, value] of [['schemaVersion', 'aaw.installed-desktop-smoke/v1'], ['normalClose', false], ['packageSha', other],
    ['expectedExeSha', other], ['profileRevision', other], ['userSidSha256', other], ['key', other], ['storageRoot', install],
    ['marker', 'user project'], ['runId', '../../summary']]) {
    assert.throws(() => validateInstalledOwnership({...owner, [key]: value}, ctx), /COLD_PROFILE_NOT_OWNED/);
  }
});

test('only the exact installed production renderer file can be selected as a CDP target', () => {
  const renderer = path.join(install, 'dist/renderer/index.html'), url = pathToFileURL(renderer).href;
  assert.equal(installedRendererMatches(url, renderer), true);
  for (const candidate of [url + '?debug', url + '#fragment', 'http://127.0.0.1/index.html', pathToFileURL(path.join(storage, 'index.html')).href, 'not-a-url'])
    assert.equal(installedRendererMatches(candidate, renderer), false);
});

test('the installed UI probe waits for the committed document and observes the mounted UI without returning page text', () => {
  const url = pathToFileURL(path.join(install, 'dist/renderer/index.html')).href, marker = 'saved synthetic project';
  const page = {location: {href: 'about:blank'}, window: {}, document: {readyState: 'loading', body: null, querySelector: () => null}};
  const probe = () => runInNewContext(installedRendererProbe(url, marker), page);
  assert.equal(probe(), null);
  page.location.href = url; assert.equal(probe(), null);
  page.document.readyState = 'interactive'; assert.equal(probe(), null);
  page.document.body = {innerText: ''}; assert.equal(probe().textarea, false);
  page.document.querySelector = () => ({}); page.window.workbenchModelSettings = {}; page.window.workbenchWorkspace = {};
  page.document.body.innerText = 'private synthetic text with ' + marker;
  assert.deepEqual({...probe()}, {textarea: true, settings: true, workspace: true, noNode: true, markerVisible: true});
  page.location.href = 'about:blank'; assert.equal(probe(), null);
});

test('a mounted background renderer can capture a PNG without an animation frame', async () => {
  const url = pathToFileURL(path.join(install, 'dist/renderer/index.html')).href;
  const page = {location: {href: url}, innerWidth: 800, innerHeight: 600, document: {visibilityState: 'hidden', querySelector: () => ({})}};
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1kAAAAASUVORK5CYII=';
  const cdp = {evaluate: expression => runInNewContext(expression, page),
    send(method) {assert.equal(method, 'Page.captureScreenshot'); return {data: png};}};
  const folder = path.join(checkoutRoot, '.local/installed-smoke-unit/capture-' + randomUUID());
  fs.mkdirSync(folder, {recursive: true});
  const captured = await captureInstalledPage(cdp, url, folder, 'background.png');
  assert.equal(captured.frame.visibility, 'hidden'); assert.equal(fs.readFileSync(path.join(folder, captured.name)).toString('base64'), png);
  page.innerWidth = 0; await assert.rejects(captureInstalledPage(cdp, url, folder, 'zero.png'), /SCREENSHOT_VIEWPORT_NOT_READY/);
  page.innerWidth = 800; cdp.send = () => ({data: Buffer.from('invalid image').toString('base64')});
  await assert.rejects(captureInstalledPage(cdp, url, folder, 'invalid.png'), /SCREENSHOT_INVALID/);
});

test('opening the synthetic schematic waits for enabled controls and clicks each once', async () => {
  let menuClicked = 0, itemClicked = 0, menuProbes = 0, itemProbes = 0;
  const document = {querySelector: () => ++menuProbes === 1 ? null : {click: () => menuClicked++},
    querySelectorAll: () => [{textContent: '打开合成原理图', disabled: ++itemProbes === 1, click: () => itemClicked++}]};
  await openInstalledSynthetic({evaluate: expression => runInNewContext(expression, {document})});
  assert.deepEqual([menuClicked, itemClicked], [1, 1]);
});

test('first-profile checks preserve occupied synthetic stores and refuse aliases before traversal', () => {
  const root = path.join(checkoutRoot, '.local/installed-smoke-unit/case-' + randomUUID());
  fs.mkdirSync(root, {recursive: true}); assertFirstProfile(root);
  const directory = path.join(root, '.local/chat-drafts'); fs.mkdirSync(directory, {recursive: true});
  const file = path.join(directory, 'drafts.synthetic'); fs.writeFileSync(file, 'synthetic only');
  assert.throws(() => assertFirstProfile(root), /FIRST_PROFILE_NOT_EMPTY/); assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic only');
  const outside = path.join(root, 'synthetic-outside'); fs.mkdirSync(outside);
  const alias = path.join(root, 'alias'); fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertFirstProfile(alias), /SMOKE_SCOPE_ALIASED/); assert.deepEqual(fs.readdirSync(outside), []);
});

test('failure diagnostics retain only this launch stage codes, including launcher failure before final result', () => {
  const root = path.join(checkoutRoot, '.local/installed-smoke-unit/diagnostic-' + randomUUID()), ctx = context();
  ctx.nativeProfile.profile.storageRoot = path.join(root, 'AnalogAIWorkbench'); ctx.nativeProfile.profile.dataRoot = path.join(ctx.nativeProfile.profile.storageRoot, '.local');
  const admission = path.join(ctx.nativeProfile.profile.dataRoot, 'runtime-admission'), old = 'init-' + randomUUID();
  fs.mkdirSync(path.join(admission, old), {recursive: true});
  fs.writeFileSync(path.join(admission, old, 'result.json'), 'Do not read an older attempt');
  const before = installedFailureSnapshot(ctx), id = randomUUID(), current = path.join(admission, 'init-' + id);
  fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'request.json'), JSON.stringify({schemaVersion: 'aaw.packaged-init-request/v1',
    packageManifestSha256: digest, profileRevision: digest, attemptId: id, installationRoot: install,
    storageRoot: ctx.nativeProfile.profile.storageRoot, dataRoot: ctx.nativeProfile.profile.dataRoot}));
  fs.writeFileSync(path.join(current, 'launcher.json'), JSON.stringify({schemaVersion: 'aaw.packaged-init-launcher/v1', status: 'NOT_READY',
    stdout: 'PRIVATE_SYNTHETIC_STDOUT', stderr: 'PRIVATE_SYNTHETIC_STDERR\nPACKAGED_NODE_REQUIRED\n', profile: 'PRIVATE_SYNTHETIC_PROFILE'}));
  const boot = path.join(admission, 'boots', 'boot-' + randomUUID()); fs.mkdirSync(boot, {recursive: true});
  fs.writeFileSync(path.join(boot, 'addon-loaded.json'), JSON.stringify({schemaVersion: 'aaw.packaged-electron-addon/v1', status: 'PASS', pin: 'PRIVATE_SYNTHETIC_PIN'}));
  const result = installedFailureDiagnostics(ctx, before, 'first'), serialized = JSON.stringify(result);
  assert.equal(result.status, 'COLLECTED'); assert.equal(result.records.find(item => item.source === 'initializer-launcher').code, 'PACKAGED_NODE_REQUIRED');
  assert.equal(result.records.find(item => item.source === 'initialization-result').status, 'MISSING');
  assert.equal(result.records.find(item => item.source === 'electron-addon').status, 'PASS');
  assert.doesNotMatch(serialized, /PRIVATE_SYNTHETIC|Do not read|stdout|stderr|profile|pin|[A-Z]:\\/u);
  assert.equal(installedFailureDiagnostics(ctx, null, 'first').status, 'UNAVAILABLE');
  fs.mkdirSync(path.join(admission, 'init-' + randomUUID()));
  const ambiguous = installedFailureDiagnostics(ctx, before, 'first');
  assert.equal(ambiguous.code, 'DIAGNOSTIC_LAUNCH_AMBIGUOUS'); assert.deepEqual(ambiguous.records, []);
});
