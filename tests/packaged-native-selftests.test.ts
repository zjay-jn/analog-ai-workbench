import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import test from 'node:test';
import {runPackagedNativeSelfTests, type PackagedNativeSelfTestOptions} from '../apps/desktop/src/main/packaged-native-selftests';

const cases = path.resolve('.local/packaged-selftest-boundaries');
const windows = process.platform === 'win32' && process.arch === 'x64';
function fixture(): PackagedNativeSelfTestOptions {
  const root = path.join(cases, randomUUID()), installationRoot = path.join(root, 'installation'), storageRoot = path.join(root, 'storage');
  const directory = path.join(storageRoot, '.local/runtime-admission', 'init-' + randomUUID()); fs.mkdirSync(installationRoot, {recursive: true}); fs.mkdirSync(directory, {recursive: true});
  const names = ['node', 'nodeLicense', 'opencode', 'guardian', 'commandRunner', 'workRunner', 'windowsFs', 'commandBootstrap'] as const;
  const data = 'synthetic non-executable fixture';
  const components = Object.fromEntries(names.map(name => {const file = path.join(installationRoot, name + '.fixture'); fs.writeFileSync(file, data); return [name, {path: file, bytes: Buffer.byteLength(data), sha256: createHash('sha256').update(data).digest('hex')}];})) as PackagedNativeSelfTestOptions['components'];
  return {installationRoot, storageRoot, directory, components};
}
test('packaged self-tests refuse invalid scope before creating evidence or running anything', {skip: !windows}, async () => {
  const options = fixture(), outside = path.join(options.storageRoot, 'unrelated');
  await assert.rejects(runPackagedNativeSelfTests({...options, directory: outside}), /PACKAGED_NATIVE_SELF_TEST_FAILED/);
  assert.equal(fs.existsSync(outside), false); assert.deepEqual(fs.readdirSync(options.directory), []);
});
test('matching synthetic hashes cannot impersonate the pinned Node/OpenCode runtimes', {skip: !windows}, async () => {
  const options = fixture(); await assert.rejects(runPackagedNativeSelfTests(options), /PACKAGED_NATIVE_SELF_TEST_FAILED/);
  assert.deepEqual(fs.readdirSync(options.directory), []); assert.equal(fs.existsSync(path.join(options.storageRoot, '.local/agent-work-cycle-runner')), false);
});
test('a component outside installation or a component hardlink is rejected without executing it', {skip: !windows}, async () => {
  const options = fixture();
  await assert.rejects(runPackagedNativeSelfTests({...options, components: {...options.components, node: {...options.components.node, path: path.join(options.storageRoot, 'unrelated')}}}), /PACKAGED_NATIVE_SELF_TEST_FAILED/);
  fs.linkSync(options.components.node.path, path.join(options.installationRoot, 'node-alias'));
  await assert.rejects(runPackagedNativeSelfTests(options), /PACKAGED_NATIVE_SELF_TEST_FAILED/); assert.deepEqual(fs.readdirSync(options.directory), []);
});
test('an already aborted admission never creates an execution or claims readiness', {skip: !windows}, async () => {
  const options = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(runPackagedNativeSelfTests({...options, signal: abort.signal}), /PACKAGED_NATIVE_SELF_TEST_FAILED/); assert.deepEqual(fs.readdirSync(options.directory), []);
});
