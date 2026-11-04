import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {PACKAGED_COMPONENT_PATHS, PACKAGE_MANIFEST_PATH, loadPackagedDistribution, type PackagePin} from '../apps/desktop/src/main/packaged-runtime';
import {configureRuntimePaths} from '../apps/desktop/src/main/runtime-paths';
import {packagedNativeProfile, configurePackagedContext, packagedCommandEnvironment, readPackagedAdmission, assertFinalizedReady} from '../apps/desktop/src/main/packaged-admission';
import {writePackagedJson, publishPackagedState, ensurePackagedDirectory} from '../apps/desktop/src/main/packaged-state-files';

const parent = path.join(process.cwd(), '.local/packaged-admission-tests'); fs.mkdirSync(parent, {recursive: true});
const sandbox = fs.mkdtempSync(path.join(parent, 'case-')), root = path.join(sandbox, 'install'), storageRoot = path.join(sandbox, 'synthetic-profile');
const hash = (value: string) => createHash('sha256').update(value).digest('hex'), files = new Map<string, PackagePin>();
function fixtureFile(name: string, data: string) {
  const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data);
  const pin = {path: name, bytes: Buffer.byteLength(data), sha256: hash(data)}; files.set(name, pin); return pin;
}
for (const name of ['dist/cloud/main/index.js', 'dist/preload/preload/cloud.js', 'dist/preload/preload/sessions.js', 'dist/renderer/index.html',
  'dist/packaged-runtime-init.cjs', 'tools/agent-engine-pilot-sum.mjs', 'tools/agent-project-read-tools.mjs', ...Object.values(PACKAGED_COMPONENT_PATHS)]) fixtureFile(name, 'synthetic, never executed: ' + name);
fixtureFile('package.json', JSON.stringify({name: 'analog-ai-workbench', version: '0.1.0-alpha.0', main: 'dist/cloud/main/index.js'}));
const manifest = {schemaVersion: 'aaw.packaged-runtime/v1', platform: 'win32', arch: 'x64', nodeVersion: '24.20.0', version: '0.1.0-alpha.0',
  sourceRevision: {commit: '1'.repeat(40), dirty: false, sourceSha256: '2'.repeat(64)}, components: Object.fromEntries(Object.entries(PACKAGED_COMPONENT_PATHS).map(([id, name]) => [id, files.get(name)!])), files: [...files.values()]};
fs.writeFileSync(path.join(root, PACKAGE_MANIFEST_PATH), JSON.stringify(manifest));
const distribution = loadPackagedDistribution(root), systemRoot = path.join(sandbox, 'SyntheticWindows');
const filePin = (pin: PackagePin) => ({bytes: pin.bytes, sha256: pin.sha256});
const profileValue = {schema: 'aaw.packaged-native-profile/v1', profileRevision: '3'.repeat(64), profile: {schema: 'aaw.packaged-command-profile/v1',
  installationRoot: root, runtimeRoot: path.join(root, '.local/runtime'), storageRoot, dataRoot: path.join(storageRoot, '.local'), systemRoot, userSidSha256: '4'.repeat(64),
  shellVersion: '5.1', policyRevision: 'aaw.packaged-command-policy/v1',
  systemFiles: ['shell', 'shellConfig', 'automation', 'clr'].map((role, index) => ({role, path: path.join(systemRoot, index < 2 ? 'System32/WindowsPowerShell/v1.0/powershell.exe' + (index ? '.config' : '') : role + '.dll'), bytes: 10, sha256: '5'.repeat(64)})),
  node: filePin(distribution.components.node), license: filePin(distribution.components.nodeLicense), bootstrap: filePin(distribution.components.commandBootstrap)}};
const native = packagedNativeProfile(profileValue, distribution, storageRoot), roots = configureRuntimePaths({installationRoot: root, storageRoot, mode: 'packaged'});
ensurePackagedDirectory(path.join(roots.dataRoot, 'runtime-admission')); configurePackagedContext(distribution, native);
const current = path.join(roots.dataRoot, 'runtime-admission/current.json');

function proofFixture() {
  const attemptId = randomUUID(), directory = path.join(roots.dataRoot, 'runtime-admission/init-' + attemptId); ensurePackagedDirectory(directory);
  const binding = {packageManifestSha256: distribution.pin.sha256, profileRevision: native.profileRevision};
  const work = {schema: 'aaw.portable.work-proof.v1', status: 'PASS', ...binding, nativeSha256: distribution.components.workRunner.sha256, runtimeSha256: distribution.components.node.sha256,
    appContainer: true, capabilityCount: 0, atomicJob: true, cleanupConfirmed: true, aclRestored: true, profileDeleted: true, activeProcesses: 0};
  const guardian = {status: 'PASS', ...binding, healthy: true, engineVersion: '1.18.17', nativeSha256: distribution.components.guardian.sha256,
    engineSha256: distribution.components.opencode.sha256, cleanupConfirmed: true, activeProcesses: 0};
  const command = {schema: 'aaw.command.runtime-admission.v1', status: 'SCOPED_NATIVE_READY_FOR_INTEGRATION', ...binding, environment: packagedCommandEnvironment(distribution, native),
    native: distribution.manifest.components.commandRunner, runtime: {node: distribution.manifest.components.node, license: distribution.manifest.components.nodeLicense, bootstrap: distribution.manifest.components.commandBootstrap},
    verification: {status: 'PASS', ...binding, commands: [0, 7], eachExecutedOnce: true, shellFamilyVerified: true, closure: {hadOutstanding: false, cleanupConfirmed: true}, failure: null,
      executions: [0, 7].map(exitCode => ({exitCode, executionId: 'cmd-' + randomUUID(), driverProofSha256: '6'.repeat(64), nativeResultSha256: '7'.repeat(64),
        jobClosed: true, profileDeleted: true, aclRestored: true, stdout: {bytes: 20, sha256: '8'.repeat(64), marker: `AAW_PACKAGED_EXIT${exitCode}_STDOUT`},
        stderr: {bytes: 20, sha256: '9'.repeat(64), marker: `AAW_PACKAGED_EXIT${exitCode}_STDERR`}}))}};
  const relative = (pin: PackagePin) => ({...pin, path: path.relative(roots.dataRoot, pin.path).split(path.sep).join('/')});
  const save = () => {
    const pins = [['work-proof', work], ['guardian-proof', guardian], ['command-admission', command]].map(([name, body]) => {
      const file = path.join(directory, name + '.json'); if (fs.existsSync(file)) fs.unlinkSync(file); return relative(writePackagedJson(file, body));
    });
    const ready = {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'READY', ...binding, nativeProfile: native, installationRoot: roots.installationRoot,
      storageRoot: roots.storageRoot, dataRoot: roots.dataRoot, attemptId, verifiedAt: new Date().toISOString(), workProof: pins[0], guardianProof: pins[1], commandAdmission: pins[2]};
    publishPackagedState(current, ready); return ready;
  };
  return {work, guardian, command, save, attemptId, directory};
}
test('native profile is root-bound and rejects swapped user paths, SDK pins and role aliases', () => {
  assert.equal(native.profileRevision, profileValue.profileRevision);
  assert.throws(() => packagedNativeProfile(profileValue, distribution, path.join(sandbox, 'other-user')));
  assert.throws(() => packagedNativeProfile({...profileValue, profile: {...profileValue.profile, installationRoot: storageRoot}}, distribution));
  assert.throws(() => packagedNativeProfile({...profileValue, profile: {...profileValue.profile, node: {...profileValue.profile.node, sha256: '0'.repeat(64)}}}, distribution));
  const changed = structuredClone(profileValue); changed.profile.systemFiles[1]!.role = 'shell'; assert.throws(() => packagedNativeProfile(changed, distribution));
});
test('static files and old source READY records do not establish current-user readiness', () => {
  assert.throws(() => readPackagedAdmission());
  publishPackagedState(current, {schema: 'aaw.command.runtime-admission.v1', status: 'SCOPED_NATIVE_READY_FOR_INTEGRATION'});
  assert.throws(() => readPackagedAdmission());
});
test('matching synthetic receipts require bundle, native profile and all three successful proof shapes', () => {
  const f = proofFixture(); f.save(); assert.equal(readPackagedAdmission().admission.status, 'READY');
  f.work.cleanupConfirmed = false; f.save(); assert.throws(() => readPackagedAdmission());
  f.work.cleanupConfirmed = true; f.guardian.activeProcesses = 1; f.save(); assert.throws(() => readPackagedAdmission());
});
test('incomplete command cleanup, an unverified shell or a repeated command cannot be admitted', () => {
  const f = proofFixture(); f.command.verification.closure.cleanupConfirmed = false; f.save(); assert.throws(() => readPackagedAdmission());
  f.command.verification.closure.cleanupConfirmed = true; f.command.verification.shellFamilyVerified = false; f.save(); assert.throws(() => readPackagedAdmission());
  f.command.verification.shellFamilyVerified = true; f.command.verification.executions[1]!.exitCode = 0; f.save(); assert.throws(() => readPackagedAdmission());
});
test('old bundle/profile receipts and cross-attempt proof locations fail even after rehashing JSON', () => {
  const f = proofFixture(), ready = f.save();
  publishPackagedState(current, {...ready, packageManifestSha256: '0'.repeat(64)}); assert.throws(() => readPackagedAdmission());
  publishPackagedState(current, {...ready, profileRevision: '0'.repeat(64)}); assert.throws(() => readPackagedAdmission());
  publishPackagedState(current, {...ready, workProof: {...ready.workProof, path: '../outside.json'}}); assert.throws(() => readPackagedAdmission());
});
test('a candidate READY without final result or factory commitment is not reusable at startup', () => {
  const f = proofFixture(), ready = f.save(); assert.equal(readPackagedAdmission().admission.status, 'READY'); assert.throws(() => assertFinalizedReady());
  const binding = {packageManifestSha256: ready.packageManifestSha256, profileRevision: ready.profileRevision, attemptId: f.attemptId,
    installationRoot: roots.installationRoot, runtimeRoot: roots.runtimeRoot, storageRoot: roots.storageRoot, dataRoot: roots.dataRoot};
  const factory = writePackagedJson(path.join(f.directory, 'factory-inspection.json'), {schemaVersion: 'aaw.packaged-factory-inspection/v1', status: 'PASS', ...binding,
    registeredWindowsDrivers: 1, commandAvailability: 'ready', workAvailable: true, hasRetainedWorkEntries: false});
  const result = {schemaVersion: 'aaw.packaged-initialization-result/v1', status: 'READY', ...binding,
    factoryInspection: {...factory, path: path.relative(roots.dataRoot, factory.path).split(path.sep).join('/')}};
  writePackagedJson(path.join(f.directory, 'result.json'), result); assert.equal(assertFinalizedReady().admission.attemptId, f.attemptId);
  fs.writeFileSync(path.join(f.directory, 'result.json'), JSON.stringify({...result, attemptId: randomUUID()})); assert.throws(() => assertFinalizedReady());
});
test('fresh-work factory unavailability rejects finalization even with rehashed factory proof', () => {
  const f = proofFixture(), ready = f.save(), binding = {packageManifestSha256: ready.packageManifestSha256, profileRevision: ready.profileRevision, attemptId: f.attemptId,
    installationRoot: roots.installationRoot, runtimeRoot: roots.runtimeRoot, storageRoot: roots.storageRoot, dataRoot: roots.dataRoot};
  const factory = writePackagedJson(path.join(f.directory, 'factory-inspection.json'), {schemaVersion: 'aaw.packaged-factory-inspection/v1', status: 'PASS', ...binding,
    registeredWindowsDrivers: 1, commandAvailability: 'ready', workAvailable: false, hasRetainedWorkEntries: false});
  writePackagedJson(path.join(f.directory, 'result.json'), {schemaVersion: 'aaw.packaged-initialization-result/v1', status: 'READY', ...binding,
    factoryInspection: {...factory, path: path.relative(roots.dataRoot, factory.path).split(path.sep).join('/')}});
  assert.throws(() => assertFinalizedReady());
});
