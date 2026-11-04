import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {configureRuntimePaths, runtimePaths} from '../apps/desktop/src/main/runtime-paths';
import {loadPackagedDistribution, packagedAsset, packagedOrdinary, readPackagedFile, type PackagePin, type PackagedDistribution, type PackagedComponentId} from '../apps/desktop/src/main/packaged-runtime';
import {runtimeComponent} from '../apps/desktop/src/main/runtime-manifest';
import {configurePackagedContext, probePackagedProfile, packagedCommandEnvironment, packagedAdmissionDirectory, readPackagedAdmission, type PackagedNativeProfile} from '../apps/desktop/src/main/packaged-admission';
import {writePackagedJson, publishPackagedState} from '../apps/desktop/src/main/packaged-state-files';
import {runPackagedNativeSelfTests} from '../apps/desktop/src/main/packaged-native-selftests';
import {createWindowsCommandDriver} from '../apps/desktop/src/main/agent-command/windows-driver';
import {registeredCommandDrivers} from '../apps/desktop/src/main/agent-command/registered-profile';
import {createWindowsWorkCycleRunner} from '../apps/desktop/src/main/agent-work-cycle/runner';
import {createCommandController} from '../apps/desktop/src/main/agent-command/controller';
import {createCommandRepository} from '../apps/desktop/src/main/agent-command/store';
import {createCommandDiagnosticJournal} from '../apps/desktop/src/main/agent-command/diagnostics';
import {nativeRead, commandExecutions} from '../apps/desktop/src/main/agent-command/native-files';
import type {WorkCycleBaseline} from '../apps/desktop/src/main/agent-work-cycle/types';
import type {CommandExecution, CommandStream} from '../apps/desktop/src/shared/agent/agent-command';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'PACKAGED_INITIALIZATION_FAILED';
function aborted(signal: AbortSignal): void {if (signal.aborted) throw Error('PACKAGED_INITIALIZATION_ABORTED');}
async function commandSelfTest(distribution: PackagedDistribution, profile: PackagedNativeProfile, directory: string, signal: AbortSignal) {
  const environment = packagedCommandEnvironment(distribution, profile), relative = distribution.manifest.components;
  const candidate = {schema: 'aaw.command.runtime-admission.v1', status: 'BUILT_ONLY', environment, profileRevision: profile.profileRevision,
    packageManifestSha256: distribution.pin.sha256, native: relative.commandRunner, runtime: {node: relative.node, license: relative.nodeLicense, bootstrap: relative.commandBootstrap}};
  const proof = writePackagedJson(path.join(directory, 'command-candidate.json'), candidate);
  const driver = createWindowsCommandDriver({environment, proof, native: packagedAsset(distribution, 'commandRunner'), node: packagedAsset(distribution, 'node'),
    license: packagedAsset(distribution, 'nodeLicense'), bootstrap: packagedAsset(distribution, 'commandBootstrap')});
  const runId = randomUUID(), workspaceId = randomUUID(), roots = runtimePaths();
  const baseline: WorkCycleBaseline = {runId, workspaceId, version: hash(JSON.stringify({kind: 'packaged-empty-baseline', runId, workspaceId})), files: []};
  const repository = createCommandRepository({directory: path.join(directory, 'agent-command/runs', runId), runId, readOnly: false});
  const diagnostics = createCommandDiagnosticJournal({directory: path.join(roots.dataRoot, 'diagnostics', path.basename(directory)), appVersion: distribution.manifest.version});
  const controller = createCommandController({runId, workspaceId, repository, drivers: [driver], exportBaseline: async () => baseline, diagnostics,
    workspace: {publishCommandArtifacts: async () => {throw Error('UNEXPECTED_ARTIFACT_PUBLICATION');}, confirmCommandArtifacts: async () => {throw Error('UNEXPECTED_ARTIFACT_CONFIRMATION');}}});
  const executions: unknown[] = []; let closure: Awaited<ReturnType<typeof controller.close>> | null = null, failure: string | null = null;
  function log(execution: CommandExecution, stream: CommandStream, marker: string) {
    const page = controller.log({executionId: execution.executionId, stream, offset: 0, maxBytes: 16384, expectedPrefixVersion: null});
    const bytes = Buffer.from(page.data, page.format === 'base64' ? 'base64' : 'utf8');
    assert.equal(page.offset, 0); assert.equal(page.endOffset, bytes.length); assert.equal(page.nextCursor, null);
    assert.equal(page.streamClosed, true); assert.equal(page.coverage, 'complete'); assert.equal(page.snapshotBytes, bytes.length); assert.equal(page.availableBytes, bytes.length);
    assert.equal(page.bytesSha256, hash(bytes)); assert.equal(execution.logs[stream].sha256, hash(bytes));
    assert.equal(execution.logs[stream].closed, true); assert.equal(execution.logs[stream].coverage, 'complete');
    assert.equal(execution.logs[stream].observedBytes, bytes.length); assert.equal(execution.logs[stream].persistedBytes, bytes.length);
    assert.equal(bytes.toString('utf8').replaceAll('\r\n', '\n'), marker + '\n');
    assert(bytes.equals(nativeRead(path.join(commandExecutions(), execution.executionId, 'control', stream + '.bin'), 65536)));
    return {bytes: bytes.length, sha256: hash(bytes), marker};
  }
  try {
    const inspection = await controller.inspect(); assert.equal(inspection.environments.length, 1); assert.equal(inspection.workspace?.files, 0);
    for (const exitCode of [0, 7]) {
      aborted(signal);
      const stdout = `AAW_PACKAGED_EXIT${exitCode}_STDOUT`, stderr = `AAW_PACKAGED_EXIT${exitCode}_STDERR`;
      const versionCheck = exitCode === 0 ? "if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { exit 89 }; " : '';
      let execution = await controller.start({requestId: randomUUID(), environmentId: environment.environmentId, environmentRevision: environment.revision, workspaceId,
        baselineVersion: baseline.version, cwdRelativePath: '', timeoutMs: 60000,
        commandText: versionCheck + `Write-Output '${stdout}'; [Console]::Error.WriteLine('${stderr}'); exit ${exitCode}`});
      const deadline = Date.now() + 90000;
      while (!['terminal', 'reconciliation_required'].includes(execution.phase)) {
        aborted(signal); if (Date.now() > deadline) throw Error('PACKAGED_COMMAND_TIMEOUT');
        execution = await controller.status({executionId: execution.executionId, afterRevision: execution.revision, waitMs: 500});
      }
      assert.equal(execution.phase, 'terminal'); assert.equal(execution.error, null); assert.equal(typeof execution.startedAt, 'string');
      assert.equal(execution.exit?.termination, 'exited'); assert.equal(execution.exit?.shellExited, true); assert.equal(execution.exit?.shellExitCode, exitCode);
      assert.equal(execution.cleanup.state, 'confirmed'); assert.equal(execution.job.activeProcesses, 0); assert.equal(execution.job.emptyConfirmed, true);
      assert.equal(execution.changes.state, 'verified'); assert.equal(execution.changes.count, 0); assert.equal(execution.environment.revision, environment.revision);
      const driverBytes = nativeRead(path.join(commandExecutions(), execution.executionId, 'control/driver-result.json'), 512*1024), driverProof = JSON.parse(driverBytes.toString('utf8'));
      assert.equal(hash(driverBytes), execution.cleanup.proofSha256); assert.equal(driverProof.executionId, execution.executionId); assert.equal(driverProof.environmentRevision, execution.environment.revision);
      assert.equal(driverProof.nativeExited, true); assert.equal(driverProof.nativeExitCode, 0); assert.equal(driverProof.cleanupConfirmed, true); assert.equal(driverProof.runtimeDisposed, true); assert.equal(driverProof.error, null);
      const nativeBytes = nativeRead(path.join(commandExecutions(), execution.executionId, 'control/result.json'), 512*1024), native = JSON.parse(nativeBytes.toString('utf8'));
      assert.equal(hash(nativeBytes), driverProof.nativeResultSha256); assert.equal(native.schema, 'aaw.command.native.result.v1'); assert.equal(native.executionId, execution.executionId);
      assert.equal(native.jobClosed, true); assert.equal(native.profileDeleted, true); assert.equal(native.aclRestored, true);
      assert.equal(native.cleanup.state, 'confirmed'); assert.equal(native.job.activeProcesses, 0); assert.equal(native.job.emptyConfirmed, true);
      executions.push({exitCode, executionId: execution.executionId, stdout: log(execution, 'stdout', stdout), stderr: log(execution, 'stderr', stderr),
        driverProofSha256: hash(driverBytes), nativeResultSha256: hash(nativeBytes), jobClosed: true, profileDeleted: true, aclRestored: true});
      assert.equal(controller.idle(), true);
    }
  } catch (error) {failure = safeCode(error);}
  finally {try {closure = await controller.close('shutdown');} catch (error) {failure ??= safeCode(error);}}
  const okay = failure === null && !signal.aborted && executions.length === 2 && closure?.hadOutstanding === false && closure.cleanupConfirmed;
  const verification = {schema: 'aaw.packaged-command-verification/v1', status: okay ? 'PASS' : 'NOT_READY', commands: [0, 7], eachExecutedOnce: okay, shellFamilyVerified: okay,
    packageManifestSha256: distribution.pin.sha256, profileRevision: profile.profileRevision, executions, closure, failure};
  writePackagedJson(path.join(directory, 'command-verification.json'), verification);
  if (!okay) throw Error('PACKAGED_COMMAND_SELF_TEST_FAILED');
  return {...candidate, status: 'SCOPED_NATIVE_READY_FOR_INTEGRATION', verification};
}

/** Built ahead of distribution. The installed machine runs this bundle with its bundled Node only. */
export async function initializePackagedRuntime(inputPath: string, installationRoot = path.resolve(__dirname, '..')): Promise<void> {
  const distribution = loadPackagedDistribution(installationRoot), nativeProfile = probePackagedProfile(distribution), expectedNode = packagedAsset(distribution, 'node');
  if (process.versions.electron || process.version !== 'v24.20.0' || path.resolve(process.execPath).toLowerCase() !== expectedNode.path.toLowerCase()) throw Error('PACKAGED_NODE_REQUIRED');
  const roots = configureRuntimePaths({installationRoot: distribution.installationRoot, storageRoot: nativeProfile.profile.storageRoot, mode: 'packaged'});
  configurePackagedContext(distribution, nativeProfile);
  if (!path.isAbsolute(inputPath) || path.basename(inputPath) !== 'request.json' || path.dirname(path.dirname(inputPath)) !== packagedAdmissionDirectory()
    || !/^init-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(path.basename(path.dirname(inputPath)))) throw Error('PACKAGED_INIT_REQUEST_INVALID');
  const request = JSON.parse(readPackagedFile(inputPath, 16384).toString('utf8'));
  if (!request || Object.keys(request).sort().join(',') !== ['schemaVersion', 'attemptId', 'packageManifestSha256', 'profileRevision', 'installationRoot', 'storageRoot', 'dataRoot'].sort().join(',')
    || request.schemaVersion !== 'aaw.packaged-init-request/v1' || typeof request.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(request.attemptId)
    || request.packageManifestSha256 !== distribution.pin.sha256 || request.profileRevision !== nativeProfile.profileRevision
    || request.installationRoot !== roots.installationRoot || request.storageRoot !== roots.storageRoot || request.dataRoot !== roots.dataRoot
    || inputPath !== path.join(packagedAdmissionDirectory(), 'init-' + request.attemptId, 'request.json')) throw Error('PACKAGED_INIT_REQUEST_INVALID');
  const directory = path.dirname(inputPath), currentFile = path.join(packagedAdmissionDirectory(), 'current.json'), cancellation = new AbortController();
  const onEnd = () => cancellation.abort();
  for (const event of ['end', 'close', 'error'] as const) process.stdin.once(event, onEnd);
  process.stdin.resume();
  const binding = {packageManifestSha256: distribution.pin.sha256, profileRevision: nativeProfile.profileRevision};
  let stage = 'native-self-tests';
  try {
    const ids = Object.keys(distribution.components) as PackagedComponentId[];
    const components = Object.fromEntries(ids.map(id => [id, packagedAsset(distribution, id)])) as Record<PackagedComponentId, PackagePin>;
    const native = await runPackagedNativeSelfTests({installationRoot: roots.installationRoot, storageRoot: roots.storageRoot, directory, components, signal: cancellation.signal});
    aborted(cancellation.signal);
    const work = writePackagedJson(path.join(directory, 'work-proof.json'), {...native.workProof, ...binding}), guardian = writePackagedJson(path.join(directory, 'guardian-proof.json'), {...native.guardianProof, ...binding});
    stage = 'command-self-tests';
    const command = writePackagedJson(path.join(directory, 'command-admission.json'), await commandSelfTest(distribution, nativeProfile, directory, cancellation.signal));
    aborted(cancellation.signal); stage = 'final-binding-check';
    const finalDistribution = loadPackagedDistribution(roots.installationRoot), finalProfile = probePackagedProfile(finalDistribution, roots.storageRoot);
    if (finalDistribution.pin.sha256 !== distribution.pin.sha256 || JSON.stringify(finalProfile) !== JSON.stringify(nativeProfile)) throw Error('PACKAGED_INIT_BINDING_CHANGED');
    // A synchronous hash/profile probe must not hide a queued parent-pipe EOF.
    await new Promise<void>(resolve => setImmediate(resolve)); aborted(cancellation.signal);
    const relative = (pin: PackagePin) => ({...pin, path: path.relative(roots.dataRoot, pin.path).split(path.sep).join('/')});
    publishPackagedState(currentFile, {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'READY', ...binding, nativeProfile,
      installationRoot: roots.installationRoot, storageRoot: roots.storageRoot, dataRoot: roots.dataRoot, attemptId: request.attemptId, verifiedAt: new Date().toISOString(),
      workProof: relative(work), guardianProof: relative(guardian), commandAdmission: relative(command)});
    readPackagedAdmission();
    stage = 'production-factory-registration';
    const drivers = registeredCommandDrivers(); assert.equal(drivers.length, 1); assert.equal(drivers[0]!.environment.availability, 'ready');
    assert.equal(drivers[0]!.environment.platform, 'windows'); assert.equal(drivers[0]!.environment.profileRevision, nativeProfile.profileRevision);
    const workPins = ['node', 'nodeLicense', 'workRunner', 'workProof'].map(id => runtimeComponent(id as 'node' | 'nodeLicense' | 'workRunner' | 'workProof'));
    const executions = path.join(roots.dataRoot, 'agent-work-cycle-runner/executions'); let hasRetainedWorkEntries = false;
    try {packagedOrdinary(executions, true); hasRetainedWorkEntries = fs.readdirSync(executions).length > 0;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    const runner = createWindowsWorkCycleRunner(); let workAvailable = false;
    try {workAvailable = runner.available().available; if (!hasRetainedWorkEntries) assert.equal(workAvailable, true);} finally {await runner.close();}
    const rootBinding = {attemptId: request.attemptId, installationRoot: roots.installationRoot, runtimeRoot: roots.runtimeRoot, storageRoot: roots.storageRoot, dataRoot: roots.dataRoot};
    const factory = writePackagedJson(path.join(directory, 'factory-inspection.json'), {schemaVersion: 'aaw.packaged-factory-inspection/v1', status: 'PASS', ...binding, ...rootBinding,
      registeredWindowsDrivers: drivers.length, commandAvailability: drivers[0]!.environment.availability, workAvailable, hasRetainedWorkEntries,
      workPins: workPins.map(pin => ({path: pin.path, bytes: pin.bytes, sha256: pin.sha256})),
      scope: 'Real production factories and readiness inspection only. No extra command or work execution; retained user history is never removed.'});
    await new Promise<void>(resolve => setImmediate(resolve)); aborted(cancellation.signal);
    writePackagedJson(path.join(directory, 'result.json'), {schemaVersion: 'aaw.packaged-initialization-result/v1', status: 'READY', ...binding, ...rootBinding, factoryInspection: relative(factory)});
    console.log(JSON.stringify({status: 'READY', attemptId: request.attemptId}));
  } catch (error) {
    const result = {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'NOT_READY', ...binding, attemptId: request.attemptId, stage, code: safeCode(error)};
    publishPackagedState(currentFile, result);
    writePackagedJson(path.join(directory, 'result.json'), result);
    throw Error(safeCode(error));
  } finally {for (const event of ['end', 'close', 'error'] as const) process.stdin.removeListener(event, onEnd); process.stdin.pause();}
}
if (require.main === module) {
  const input = process.argv[2];
  if (process.argv.length !== 3 || !input || !path.isAbsolute(input)) {console.error('PACKAGED_INIT_REQUEST_REQUIRED'); process.exitCode = 1;}
  else void initializePackagedRuntime(input).catch(error => {console.error(safeCode(error)); process.exitCode = 1;});
}
