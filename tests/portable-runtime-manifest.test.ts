import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {configureRuntimePaths} from '../apps/desktop/src/main/runtime-paths';
import {runtimeComponent, runtimeManifest, runtimeManifestPin} from '../apps/desktop/src/main/runtime-manifest';
import {commandExecutions, createNativeLogReader, nativeRead, nativeReadStatus, prepareNativeDirectory} from '../apps/desktop/src/main/agent-command/native-files';
import {nativeWindowsEnvironment} from '../apps/desktop/src/main/native-environment';

const testRoot = path.join(path.resolve(process.cwd()), '.local', 'portable-manifest-tests');
fs.mkdirSync(testRoot, {recursive: true});
const sandbox = fs.mkdtempSync(path.join(testRoot, 'case-'));
const installationRoot = path.join(sandbox, 'install'), storageRoot = path.join(sandbox, 'user-data');
fs.mkdirSync(installationRoot); fs.mkdirSync(storageRoot);
const locations = configureRuntimePaths({installationRoot, storageRoot});
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sources = ['packages/windows-fs-native/src/addon.cc', 'packages/windows-fs-native/binding.gyp', 'tools/portable-native-build.mjs'];
const componentPath = '.local/runtime/native/windows-fs-native.node', generatedPath = '.local/runtime/build/synthetic/runtime-paths.h';
const componentBody = 'synthetic binary bytes; never executed';
const boundHeader = () => '#pragma once\nnamespace portable_runtime {\n'
  + 'inline constexpr wchar_t dataLocal[]=L' + JSON.stringify(locations.dataRoot + path.sep) + ';\n'
  + 'inline constexpr wchar_t installationRuntime[]=L' + JSON.stringify(locations.runtimeRoot + path.sep) + ';\n'
  + 'inline constexpr wchar_t systemRoot[]=L"SyntheticWindows";\n}\n';
function write(relative: string, value: string) {
  const absolute = path.resolve(installationRoot, ...relative.split('/'));
  assert(!path.relative(installationRoot, absolute).startsWith('..'));
  fs.mkdirSync(path.dirname(absolute), {recursive: true}); fs.writeFileSync(absolute, value);
  return {path: relative, bytes: Buffer.byteLength(value), sha256: hash(value)};
}
function fixture() {
  const component = write(componentPath, componentBody), generated = write(generatedPath, boundHeader());
  const sourcePins = sources.map((file, index) => {const value = 'synthetic source ' + index; write(file, value); return {path: file, sha256: hash(value)};});
  return {schemaVersion: 'aaw.desktop-runtime/v1', platform: 'win32', arch: 'x64', nodeVersion: '24.20.0', dataRoot: locations.dataRoot,
    components: {windowsFs: {...component, sources: sourcePins}}, build: {id: 'synthetic-local-build', exitCode: 0, generated: [generated]}};
}
function manifest(value: unknown) {
  const file = path.join(locations.runtimeRoot, 'runtime-manifest.json');
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value));
}

test('no runtime manifest leaves every component unavailable without legacy-installation fallback', () => {
  assert.throws(() => runtimeManifest(), /DESKTOP_RUNTIME_UNAVAILABLE/);
  assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/);
  const valid = fixture(); manifest(valid);
  assert.equal(runtimeManifest().dataRoot, locations.dataRoot);
  assert.deepEqual(runtimeComponent('windowsFs'), {path: path.join(installationRoot, componentPath), bytes: Buffer.byteLength(componentBody), sha256: hash(componentBody)});
  assert.equal(runtimeManifestPin().path, path.join(locations.runtimeRoot, 'runtime-manifest.json'));
  assert.throws(() => runtimeComponent('guardian'), /DESKTOP_RUNTIME_UNAVAILABLE/);
});

test('manifest rejects another data root, prototype-name components and source path escapes', () => {
  const valid = fixture();
  manifest({...valid, dataRoot: path.join(sandbox, 'other/.local')});
  assert.throws(() => runtimeManifest(), /DESKTOP_RUNTIME_UNAVAILABLE/);
  manifest({...valid, components: {...valid.components, toString: valid.components.windowsFs}});
  assert.throws(() => runtimeManifest(), /DESKTOP_RUNTIME_UNAVAILABLE/);
  manifest({...valid, components: {windowsFs: {...valid.components.windowsFs, path: '../outside.node'}}});
  assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/);
  manifest({...valid, components: {windowsFs: {...valid.components.windowsFs, sources: [{path: '../outside.cc', sha256: 'a'.repeat(64)}]}}});
  assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/);
});

test('changing a source, generated header or native output invalidates its component', () => {
  const valid = fixture(); manifest(valid);
  fs.writeFileSync(path.join(installationRoot, sources[0]!), 'changed source');
  assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/);
  manifest(fixture()); fs.writeFileSync(path.join(installationRoot, generatedPath), 'changed generated file');
  assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/);
  manifest(fixture()); fs.writeFileSync(path.join(installationRoot, componentPath), 'changed native bytes');
  assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/);
});

test('one hashed path header binds both roots and moving an installation with the same storage requires rebuild', () => {
  const valid = fixture(); manifest(valid);
  assert.equal(runtimeManifest().dataRoot, locations.dataRoot);
  manifest({...valid, build: {...valid.build, generated: []}});
  assert.throws(() => runtimeManifest(), /DESKTOP_RUNTIME_UNAVAILABLE/);
  const duplicate = write('.local/runtime/build/duplicate/runtime-paths.h', boundHeader());
  manifest({...valid, build: {...valid.build, generated: [...valid.build.generated, duplicate]}});
  assert.throws(() => runtimeManifest(), /DESKTOP_RUNTIME_UNAVAILABLE/);
  const wrongDataHeader = write(generatedPath, boundHeader().replace(JSON.stringify(locations.dataRoot + path.sep), JSON.stringify(path.join(sandbox, 'old-data/.local') + path.sep)));
  manifest({...valid, build: {...valid.build, generated: [wrongDataHeader]}});
  assert.throws(() => runtimeManifest(), /DESKTOP_RUNTIME_UNAVAILABLE/);
  manifest(fixture());
  const moved = path.join(sandbox, 'moved-install');
  assert(!path.relative(sandbox, moved).startsWith('..'));
  fs.cpSync(installationRoot, moved, {recursive: true, force: false, errorOnExist: true});
  const child = spawnSync(process.execPath, ['-e', `const paths=require(process.argv[3]);paths.configureRuntimePaths({installationRoot:process.argv[1],storageRoot:process.argv[2]});try{require(process.argv[4]).runtimeManifest();process.stdout.write('UNEXPECTEDLY_ACCEPTED');process.exitCode=2;}catch(error){if(error.message==='DESKTOP_RUNTIME_UNAVAILABLE')process.stdout.write('MOVED_RUNTIME_REJECTED');else process.exitCode=3;}`, moved, storageRoot,
    require.resolve('../apps/desktop/src/main/runtime-paths'), require.resolve('../apps/desktop/src/main/runtime-manifest')], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000,
    env: {SystemRoot: process.env.SystemRoot ?? '', PATH: path.dirname(process.execPath), TEMP: sandbox, TMP: sandbox},
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0); assert.equal(child.stdout, 'MOVED_RUNTIME_REJECTED');
});

test('junctions in native output ancestors are rejected before reading their targets', () => {
  manifest(fixture());
  const outside = path.join(sandbox, 'outside-native'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'windows-fs-native.node'), componentBody);
  fs.unlinkSync(path.join(installationRoot, componentPath)); fs.rmdirSync(locations.nativeRoot);
  fs.symlinkSync(outside, locations.nativeRoot, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => runtimeComponent('windowsFs'), /DESKTOP_RUNTIME_UNAVAILABLE/); }
  finally { fs.rmdirSync(locations.nativeRoot); }
});

test('native reads admit only the configured installation/storage roots and reject aliases', () => {
  const installed = path.join(installationRoot, 'test-source.txt'), stored = path.join(locations.dataRoot, 'test-state.txt'), outside = path.join(sandbox, 'outside.txt');
  fs.mkdirSync(locations.dataRoot, {recursive: true});
  fs.writeFileSync(installed, 'install'); fs.writeFileSync(stored, 'storage'); fs.writeFileSync(outside, 'outside synthetic sentinel');
  assert.equal(nativeRead(installed, 32).toString(), 'install');
  assert.equal(nativeRead(stored, 32).toString(), 'storage');
  assert.throws(() => nativeRead(outside, 32));
  const alias = path.join(installationRoot, 'aliased-state');
  fs.symlinkSync(locations.dataRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => nativeRead(path.join(alias, 'test-state.txt'), 32));
});

test('command execution directories and announced-status/log readers stay under private dataRoot', () => {
  const id = 'cmd-' + randomUUID(), directory = prepareNativeDirectory(id);
  assert.equal(directory.root, path.join(locations.dataRoot, 'agent-command-runner/executions', id));
  assert.equal(commandExecutions(), path.dirname(directory.root));
  directory.directory('control'); directory.write('control/status.json', Buffer.from('{"seq":1}')); directory.write('control/stdout.bin', Buffer.from('abc'));
  assert.equal(nativeReadStatus(directory.target('control/status.json'), 64).toString(), '{"seq":1}');
  assert.equal(createNativeLogReader(directory.root)('stdout', 0, 3).toString(), 'abc');
  const installationExecution = path.join(installationRoot, '.local/agent-command-runner/executions', id);
  assert.throws(() => nativeReadStatus(path.join(installationExecution, 'control/status.json'), 64));
  assert.throws(() => createNativeLogReader(installationExecution));
  assert.throws(() => directory.target('../../outside.txt'));
});

test('native Windows environment uses the OS root and never copies unrelated environment variables', () => {
  const original = process.env.SystemRoot;
  try {
    delete process.env.SystemRoot;
    assert.throws(() => nativeWindowsEnvironment(), /SYSTEM_ROOT_UNAVAILABLE/);
    process.env.SystemRoot = 'relative';
    assert.throws(() => nativeWindowsEnvironment(), /SYSTEM_ROOT_UNAVAILABLE/);
    process.env.SystemRoot = path.join(sandbox, 'SyntheticWindows');
    const value = nativeWindowsEnvironment();
    assert.deepEqual(Object.keys(value).sort(), ['SystemDrive', 'SystemRoot', 'windir']);
    assert.equal(value.SystemRoot, process.env.SystemRoot);
    assert(Object.isFrozen(value));
  } finally { if (original === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = original; }
});
