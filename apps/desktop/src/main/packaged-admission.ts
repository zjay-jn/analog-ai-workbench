import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runtimePaths} from './runtime-paths';
import {configurePackagedWindowsRoot} from './native-environment';
import {COMMAND_LIMITS, type WindowsCommandEnvironment} from '../shared/agent/agent-command';
import {isCommandEnvironment} from '../shared/agent/agent-command-validation';
import {packagedAsset, packagedPinned, readPackagedFile, type PackagePin, type PackagedComponentId, type PackagedDistribution} from './packaged-runtime';

type ContentPin = Readonly<{bytes: number; sha256: string}>;
export type PackagedNativeProfile = Readonly<{schema: 'aaw.packaged-native-profile/v1'; profileRevision: string; profile: Readonly<{
  schema: 'aaw.packaged-command-profile/v1'; installationRoot: string; runtimeRoot: string; storageRoot: string; dataRoot: string;
  systemRoot: string; userSidSha256: string; shellVersion: '5.1'; policyRevision: 'aaw.packaged-command-policy/v1';
  systemFiles: readonly (ContentPin & Readonly<{role: 'shell' | 'shellConfig' | 'automation' | 'clr'; path: string}>)[];
  node: ContentPin; license: ContentPin; bootstrap: ContentPin;
}>}>;
export type PackagedReadyAdmission = Readonly<{schemaVersion: 'aaw.packaged-runtime-admission/v1'; status: 'READY';
  packageManifestSha256: string; profileRevision: string; nativeProfile: PackagedNativeProfile; installationRoot: string; storageRoot: string; dataRoot: string;
  attemptId: string; verifiedAt: string; workProof: PackagePin; guardianProof: PackagePin; commandAdmission: PackagePin}>;
export type PackagedContext = Readonly<{distribution: PackagedDistribution; nativeProfile: PackagedNativeProfile}>;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function fail(): never {throw Error('PACKAGED_RUNTIME_NOT_READY');}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function local(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z]:\\/u.test(value) && !/[\u0000-\u001f]/u.test(value) && !value.slice(2).includes(':')
    && path.resolve(value) === value && path.dirname(value) !== value;
}
function content(value: unknown): value is ContentPin {
  return exact(value, ['bytes', 'sha256']) && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && sha(value.sha256);
}
/** The native revision is opaque. Roots and fixed component identities still have to match main. */
export function packagedNativeProfile(value: unknown, distribution: PackagedDistribution, expectedStorageRoot?: string): PackagedNativeProfile {
  if (!exact(value, ['schema', 'profileRevision', 'profile']) || value.schema !== 'aaw.packaged-native-profile/v1' || !sha(value.profileRevision)
    || !exact(value.profile, ['schema', 'installationRoot', 'runtimeRoot', 'storageRoot', 'dataRoot', 'systemRoot', 'userSidSha256', 'shellVersion', 'systemFiles', 'node', 'license', 'bootstrap', 'policyRevision'])) fail();
  const profile = value.profile;
  if (profile.schema !== 'aaw.packaged-command-profile/v1' || profile.policyRevision !== 'aaw.packaged-command-policy/v1' || profile.shellVersion !== '5.1'
    || !['installationRoot', 'runtimeRoot', 'storageRoot', 'dataRoot', 'systemRoot'].every(key => local(profile[key])) || !sha(profile.userSidSha256)
    || !samePath(profile.installationRoot as string, distribution.installationRoot)
    || !samePath(profile.runtimeRoot as string, path.join(distribution.installationRoot, '.local/runtime'))
    || !samePath(profile.dataRoot as string, path.join(profile.storageRoot as string, '.local'))
    || expectedStorageRoot !== undefined && !samePath(profile.storageRoot as string, expectedStorageRoot)
    || !Array.isArray(profile.systemFiles) || profile.systemFiles.length !== 4) fail();
  const roles = ['shell', 'shellConfig', 'automation', 'clr'];
  for (const [index, file] of profile.systemFiles.entries()) {
    if (!exact(file, ['role', 'path', 'bytes', 'sha256']) || file.role !== roles[index] || !local(file.path)
      || !file.path.toLowerCase().startsWith((profile.systemRoot as string).toLowerCase() + path.sep)
      || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 1 || !sha(file.sha256)) fail();
  }
  const shell = path.join(profile.systemRoot as string, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!samePath(profile.systemFiles[0].path as string, shell) || !samePath(profile.systemFiles[1].path as string, shell + '.config')) fail();
  for (const [name, id] of [['node', 'node'], ['license', 'nodeLicense'], ['bootstrap', 'commandBootstrap']] as const) {
    const pin = profile[name], expected = distribution.components[id];
    if (!content(pin) || pin.bytes !== expected.bytes || pin.sha256 !== expected.sha256) fail();
  }
  return structuredClone(value) as PackagedNativeProfile;
}
export function probePackagedProfile(distribution: PackagedDistribution, expectedStorageRoot?: string): PackagedNativeProfile {
  const native = packagedAsset(distribution, 'commandRunner');
  const result = spawnSync(native.path, ['--probe-profile'], {cwd: distribution.installationRoot, env: {}, shell: false,
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 64*1024});
  if (result.error || result.status !== 0 || !result.stdout || Buffer.byteLength(result.stdout) > 64*1024) throw Error('PACKAGED_NATIVE_PROFILE_UNAVAILABLE');
  return packagedNativeProfile(JSON.parse(result.stdout), distribution, expectedStorageRoot);
}
let context: PackagedContext | undefined;
export function configurePackagedContext(distribution: PackagedDistribution, nativeProfile: PackagedNativeProfile): PackagedContext {
  const roots = runtimePaths();
  if (roots.mode !== 'packaged' || !samePath(roots.installationRoot, distribution.installationRoot) || !samePath(roots.storageRoot, nativeProfile.profile.storageRoot)) fail();
  packagedPinned(distribution.pin); packagedNativeProfile(nativeProfile, distribution, roots.storageRoot);
  if (context && (context.distribution.pin.sha256 !== distribution.pin.sha256 || context.nativeProfile.profileRevision !== nativeProfile.profileRevision)) fail();
  configurePackagedWindowsRoot(nativeProfile.profile.systemRoot);
  return context ??= Object.freeze({distribution, nativeProfile});
}
export function packagedContext(): PackagedContext {if (!context || runtimePaths().mode !== 'packaged') fail(); return context;}
export function packagedAdmissionDirectory(): string {return path.join(runtimePaths().dataRoot, 'runtime-admission');}
export function packagedCommandEnvironment(distribution: PackagedDistribution, native: PackagedNativeProfile): WindowsCommandEnvironment {
  const base = {environmentId: 'windows-powershell-5.1-packaged', displayName: 'Windows PowerShell 5.1 · AppContainer', platform: 'windows' as const,
    shell: {kind: 'powershell' as const, version: native.profile.shellVersion, sha256: native.profile.systemFiles[0]!.sha256, scriptEncoding: 'utf8_bom' as const, interactive: false as const},
    tools: [{name: 'node', version: '24.20.0', sha256: native.profile.node.sha256}], isolation: 'windows-appcontainer-job' as const, profileRevision: native.profileRevision,
    availability: 'ready' as const, reason: null, projectAccess: 'none' as const, baselineAccess: 'read_only' as const, workAccess: 'execution_copy' as const,
    network: 'denied' as const, hostEnvironment: 'not_inherited' as const, packageInstallation: 'unsupported' as const, executableScope: 'appcontainer_os_acl' as const,
    survivesAppClose: false as const, limits: {processes: COMMAND_LIMITS.processes, logBytes: COMMAND_LIMITS.logBytes, defaultTimeoutMs: COMMAND_LIMITS.defaultTimeoutMs, maxTimeoutMs: COMMAND_LIMITS.maxTimeoutMs}};
  return Object.freeze({...base, revision: hash(JSON.stringify({packageManifestSha256: distribution.pin.sha256, environment: base}))});
}
function proofPin(value: unknown, attemptId: string, name: string): PackagePin {
  if (!exact(value, ['path', 'bytes', 'sha256']) || value.path !== `runtime-admission/init-${attemptId}/${name}.json`
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > 512*1024 || !sha(value.sha256)) fail();
  const pin = {path: path.join(runtimePaths().dataRoot, ...(value.path as string).split('/')), bytes: Number(value.bytes), sha256: value.sha256};
  packagedPinned(pin); return Object.freeze(pin);
}
export function readPackagedAdmission(): Readonly<{admission: PackagedReadyAdmission; pin: PackagePin; work: PackagePin; command: PackagePin}> {
  const {distribution, nativeProfile} = packagedContext(), roots = runtimePaths(), file = path.join(packagedAdmissionDirectory(), 'current.json');
  const bytes = readPackagedFile(file, 512*1024), value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (!exact(value, ['schemaVersion', 'status', 'packageManifestSha256', 'profileRevision', 'nativeProfile', 'installationRoot', 'storageRoot', 'dataRoot', 'attemptId', 'verifiedAt', 'workProof', 'guardianProof', 'commandAdmission'])
    || value.schemaVersion !== 'aaw.packaged-runtime-admission/v1' || value.status !== 'READY' || value.packageManifestSha256 !== distribution.pin.sha256
    || value.profileRevision !== nativeProfile.profileRevision || JSON.stringify(value.nativeProfile) !== JSON.stringify(nativeProfile)
    || value.installationRoot !== roots.installationRoot || value.storageRoot !== roots.storageRoot || value.dataRoot !== roots.dataRoot
    || typeof value.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.attemptId)
    || typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))) fail();
  packagedPinned(distribution.pin);
  const pins = {work: proofPin(value.workProof, value.attemptId, 'work-proof'), guardian: proofPin(value.guardianProof, value.attemptId, 'guardian-proof'),
    command: proofPin(value.commandAdmission, value.attemptId, 'command-admission')};
  const work = JSON.parse(packagedPinned(pins.work).toString('utf8')), guardian = JSON.parse(packagedPinned(pins.guardian).toString('utf8')), command = JSON.parse(packagedPinned(pins.command).toString('utf8'));
  for (const proof of [work, guardian, command]) if (proof.packageManifestSha256 !== distribution.pin.sha256 || proof.profileRevision !== nativeProfile.profileRevision) fail();
  if (work.schema !== 'aaw.portable.work-proof.v1' || work.status !== 'PASS' || work.nativeSha256 !== distribution.components.workRunner.sha256
    || work.runtimeSha256 !== distribution.components.node.sha256 || work.appContainer !== true || work.capabilityCount !== 0 || work.atomicJob !== true
    || work.cleanupConfirmed !== true || work.aclRestored !== true || work.profileDeleted !== true || work.activeProcesses !== 0
    || guardian.status !== 'PASS' || guardian.healthy !== true || guardian.engineVersion !== '1.18.17' || guardian.nativeSha256 !== distribution.components.guardian.sha256
    || guardian.engineSha256 !== distribution.components.opencode.sha256 || guardian.cleanupConfirmed !== true || guardian.activeProcesses !== 0
    || command.schema !== 'aaw.command.runtime-admission.v1' || command.status !== 'SCOPED_NATIVE_READY_FOR_INTEGRATION'
    || !isCommandEnvironment(command.environment) || JSON.stringify(command.environment) !== JSON.stringify(packagedCommandEnvironment(distribution, nativeProfile))
    || command.verification?.status !== 'PASS' || command.verification.shellFamilyVerified !== true
    || command.verification.eachExecutedOnce !== true || command.verification.failure !== null
    || command.verification.packageManifestSha256 !== distribution.pin.sha256 || command.verification.profileRevision !== nativeProfile.profileRevision
    || JSON.stringify(command.verification.commands) !== '[0,7]' || command.verification.closure?.hadOutstanding !== false || command.verification.closure?.cleanupConfirmed !== true) fail();
  for (const [ref, id] of [[command.native, 'commandRunner'], [command.runtime?.node, 'node'], [command.runtime?.license, 'nodeLicense'], [command.runtime?.bootstrap, 'commandBootstrap']] as const) {
    const expected = distribution.manifest.components[id];
    if (!exact(ref, ['path', 'bytes', 'sha256']) || ref.path !== expected.path || ref.bytes !== expected.bytes || ref.sha256 !== expected.sha256) fail();
  }
  const executions = command.verification.executions;
  if (!Array.isArray(executions) || executions.length !== 2 || new Set(executions.map(execution => execution.executionId)).size !== 2) fail();
  for (const [index, execution] of executions.entries()) {
    const exitCode = [0, 7][index];
    if (execution.exitCode !== exitCode || typeof execution.executionId !== 'string' || !/^cmd-[a-f0-9-]{36}$/u.test(execution.executionId)
      || !sha(execution.driverProofSha256) || !sha(execution.nativeResultSha256) || execution.jobClosed !== true || execution.profileDeleted !== true || execution.aclRestored !== true) fail();
    for (const stream of ['stdout', 'stderr']) {
      const log = execution[stream];
      if (!log || !Number.isSafeInteger(log.bytes) || log.bytes < 1 || log.bytes > 65536 || !sha(log.sha256)
        || log.marker !== `AAW_PACKAGED_EXIT${exitCode}_${stream.toUpperCase()}`) fail();
    }
  }
  return {admission: value as PackagedReadyAdmission, pin: {path: file, bytes: bytes.length, sha256: hash(bytes)}, work: pins.work, command: pins.command};
}
export function packagedRuntimeComponent(id: PackagedComponentId | 'workProof' | 'commandAdmission'): PackagePin {
  const ready = readPackagedAdmission();
  if (id === 'workProof') return ready.work;
  if (id === 'commandAdmission') return ready.command;
  return packagedAsset(packagedContext().distribution, id);
}

/** Startup commitment: candidate native proof alone is not a completed initialization. */
export function assertFinalizedReady(): ReturnType<typeof readPackagedAdmission> {
  const ready = readPackagedAdmission(), admission = ready.admission, roots = runtimePaths();
  const resultFile = path.join(packagedAdmissionDirectory(), 'init-' + admission.attemptId, 'result.json');
  const result = JSON.parse(readPackagedFile(resultFile, 65536).toString('utf8'));
  if (!exact(result, ['schemaVersion', 'status', 'packageManifestSha256', 'profileRevision', 'attemptId', 'installationRoot', 'runtimeRoot', 'storageRoot', 'dataRoot', 'factoryInspection'])
    || result.schemaVersion !== 'aaw.packaged-initialization-result/v1' || result.status !== 'READY'
    || result.packageManifestSha256 !== admission.packageManifestSha256 || result.profileRevision !== admission.profileRevision || result.attemptId !== admission.attemptId
    || result.installationRoot !== roots.installationRoot || result.runtimeRoot !== roots.runtimeRoot || result.storageRoot !== roots.storageRoot || result.dataRoot !== roots.dataRoot) fail();
  const pin = proofPin(result.factoryInspection, admission.attemptId, 'factory-inspection'), factory = JSON.parse(packagedPinned(pin).toString('utf8'));
  if (factory.schemaVersion !== 'aaw.packaged-factory-inspection/v1' || factory.status !== 'PASS'
    || factory.packageManifestSha256 !== admission.packageManifestSha256 || factory.profileRevision !== admission.profileRevision || factory.attemptId !== admission.attemptId
    || factory.installationRoot !== roots.installationRoot || factory.runtimeRoot !== roots.runtimeRoot || factory.storageRoot !== roots.storageRoot || factory.dataRoot !== roots.dataRoot
    || factory.registeredWindowsDrivers !== 1 || factory.commandAvailability !== 'ready' || typeof factory.hasRetainedWorkEntries !== 'boolean'
    || typeof factory.workAvailable !== 'boolean' || !factory.hasRetainedWorkEntries && factory.workAvailable !== true) fail();
  return ready;
}
