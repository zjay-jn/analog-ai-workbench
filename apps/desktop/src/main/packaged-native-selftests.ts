import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export type PackagedNativeComponent = Readonly<{path: string; bytes: number; sha256: string}>;
export type PackagedNativeSelfTestOptions = Readonly<{
  installationRoot: string;
  storageRoot: string;
  directory: string;
  signal?: AbortSignal;
  components: Readonly<Record<'node' | 'nodeLicense' | 'opencode' | 'guardian' | 'commandRunner' | 'workRunner' | 'windowsFs' | 'commandBootstrap', PackagedNativeComponent>>;
}>;

const fail = (): never => {throw Error('PACKAGED_NATIVE_SELF_TEST_FAILED');};
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const within = (root: string, file: string) => {const relative = path.relative(root, file); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);};
const fixed = {node: {bytes: 93381448, sha256: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'},
  nodeLicense: {sha256: 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9'},
  opencode: {bytes: 178721160, sha256: '2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54'}};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function absolute(value: string): string {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/iu.test(value) || value.slice(2).includes(':') || /[\u0000-\u001f]/u.test(value)) return fail();
  const result = path.resolve(value); if (path.dirname(result) === result) return fail(); return result;
}
function ordinary(file: string, directory = false): fs.BigIntStats {
  const chain: string[] = []; for (let current = path.resolve(file);; current = path.dirname(current)) {chain.unshift(current); if (path.dirname(current) === current) break;}
  for (const [index, current] of chain.entries()) {
    const stat = fs.lstatSync(current, {bigint: true});
    if (stat.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()
      || (index + 1 === chain.length ? directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory())) return fail();
  }
  return fs.lstatSync(file, {bigint: true});
}
function mkdir(file: string): void {if (!fs.existsSync(file)) {mkdir(path.dirname(file)); fs.mkdirSync(file);} ordinary(file, true);}
function stableFile(file: string, limit: number): {sha256: string; bytes: number; data: Buffer | null} {
  const before = ordinary(file); if (before.size > BigInt(limit)) return fail();
  const descriptor = fs.openSync(file, 'r'), digest = createHash('sha256'), parts: Buffer[] = []; let count = 0;
  try {
    const opened = fs.fstatSync(descriptor, {bigint: true}), block = Buffer.alloc(65536);
    for (;;) {const read = fs.readSync(descriptor, block, 0, block.length, count); if (!read) break; count += read; if (count > limit) return fail(); digest.update(block.subarray(0, read)); if (limit <= 65536) parts.push(Buffer.from(block.subarray(0, read)));}
    const after = ordinary(file), closed = fs.fstatSync(descriptor, {bigint: true});
    if ([opened, after, closed].some(value => value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs || value.nlink !== 1n) || BigInt(count) !== before.size) return fail();
    return {sha256: digest.digest('hex'), bytes: count, data: limit <= 65536 ? Buffer.concat(parts) : null};
  } finally {fs.closeSync(descriptor);}
}
function write(file: string, value: string | Uint8Array): void {ordinary(path.dirname(file), true); fs.writeFileSync(file, value, {flag: 'wx'}); ordinary(file);}
type Received = {code: number | null; signal: NodeJS.Signals | null; closed: boolean; transportError: string | null; stdout: string; stderr: string; stdoutObservedBytes: number; stderrObservedBytes: number};
function saveEvidence(directory: string, kind: 'work' | 'guardian', received: Received, report: unknown, okay: boolean, failures: string[], recordRoot: string, health?: unknown[]): void {
  const target = path.join(directory, kind); mkdir(target);
  write(path.join(target, 'stdout.txt'), Buffer.from(received.stdout).subarray(0, 16384)); write(path.join(target, 'stderr.txt'), Buffer.from(received.stderr).subarray(0, 16384));
  const names = kind === 'work' ? ['native-claim', 'profile-intent', 'profile-owned', 'started', 'cleanup', 'cleanup-failed', 'acl-diagnostics'] : ['intent', 'ready', 'result'];
  const records: unknown[] = [];
  for (const name of names) try {const file = stableFile(path.join(recordRoot, name + '.json'), 65536); if (file.data === null) return fail(); write(path.join(target, 'native-record-' + name + '.json'), file.data); records.push({name, bytes: file.bytes, sha256: file.sha256});} catch {records.push({name, unavailable: true});}
  if (report !== null && report !== undefined) {const text = JSON.stringify(report); if (Buffer.byteLength(text) <= 65536) write(path.join(target, 'report.json'), text + '\n');}
  write(path.join(target, 'result.json'), JSON.stringify({schema: 'aaw.packaged-native-self-test/v1', kind, status: okay ? 'PASS' : 'FAIL', code: received.code, signal: received.signal,
    closed: received.closed, transportError: received.transportError, stdoutObservedBytes: received.stdoutObservedBytes, stderrObservedBytes: received.stderrObservedBytes,
    failures, records, ...(health ? {health} : {}), scope: 'Fixed synthetic self-test. Guardian output is counted only; no environment, authentication, configuration or runtime binaries copied.'}, null, 2) + '\n');
}
async function workTest(options: PackagedNativeSelfTestOptions, directory: string, dataRoot: string): Promise<Record<string, unknown>> {
  const id = 'wce-' + randomUUID(), execution = path.join(dataRoot, 'agent-work-cycle-runner/native-tests', randomUUID(), 'executions', id), runtime = path.join(execution, 'runtime');
  const snapshot = path.join(directory, 'work-input', id), input = path.join(snapshot, 'input'), output = path.join(snapshot, 'output');
  for (const folder of [execution, runtime, input, output]) mkdir(folder);
  const marker = 'AAW_PORTABLE_WORK_SELF_TEST', program = `console.log('${marker}');\n`, scriptSha = hash(program), signature = hash(randomBytes(32)), nonce = randomBytes(16).toString('hex');
  write(path.join(input, 'test.js'), program); write(path.join(runtime, 'program.cjs'), program);
  for (const [component, name] of [['node', 'node.exe'], ['nodeLicense', 'LICENSE']] as const) {fs.copyFileSync(options.components[component].path, path.join(runtime, name), fs.constants.COPYFILE_EXCL); const copied = stableFile(path.join(runtime, name), options.components[component].bytes); if (copied.sha256 !== options.components[component].sha256) return fail();}
  if (options.signal?.aborted) return fail();
  const received = await new Promise<Received>(resolve => {
    const child = spawn(options.components.workRunner.path, [execution, runtime, input, output, id, signature, nonce, 'test.js', scriptSha, `${scriptSha}:${Buffer.byteLength(program)}:test.js`],
      {cwd: execution, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {SystemRoot: process.env.SystemRoot, windir: process.env.SystemRoot, SystemDrive: path.parse(process.env.SystemRoot ?? 'C:/Windows').root.slice(0, 2)}});
    const out: Buffer[] = [], err: Buffer[] = []; let outBytes = 0, errBytes = 0, savedOut = 0, savedErr = 0, settled = false, stopping = false;
    const stop = () => {if (stopping) return; stopping = true; try {child.stdin?.end('C');} catch {}};
    const finish = (code: number | null, signal: NodeJS.Signals | null, closed: boolean, transportError: string | null = null) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hard); options.signal?.removeEventListener('abort', stop); resolve({code, signal, closed, transportError, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), stdoutObservedBytes: outBytes, stderrObservedBytes: errBytes});
    };
    const timer = setTimeout(stop, 25000), hard = setTimeout(() => {stop(); try {child.kill();} catch {} child.unref(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); finish(null, null, false, 'WORK_SELF_TEST_TIMEOUT');}, 40000);
    options.signal?.addEventListener('abort', stop, {once: true}); if (options.signal?.aborted) stop();
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {outBytes += chunk.length; const saved = chunk.subarray(0, Math.max(0, 16384 - savedOut)); if (saved.length) {out.push(saved); savedOut += saved.length;} if (outBytes > 16384) stop();});
    child.stderr?.on('data', (chunk: Buffer) => {errBytes += chunk.length; const saved = chunk.subarray(0, Math.max(0, 16384 - savedErr)); if (saved.length) {err.push(saved); savedErr += saved.length;}});
    child.once('error', () => finish(null, null, false, 'WORK_SELF_TEST_START_ERROR')); child.once('close', (code, signal) => finish(code, signal, true));
  });
  let report: Record<string, unknown> | null = null; try {const parsed: unknown = JSON.parse(received.stdout.trim()); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;} catch {}
  let stdoutMarker = false; try {stdoutMarker = typeof report?.stdoutHex === 'string' && Buffer.from(report.stdoutHex, 'hex').toString('utf8').trim() === marker;} catch {}
  const checks = {not_cancelled: !options.signal?.aborted, closed: received.closed, transport: received.transportError === null, launcher_exit: received.code === 0, outer_stdout_complete: received.stdoutObservedBytes <= 16384,
    version: report?.version === 1, execution_identity: report?.executionId === id, signature: report?.signature === signature, termination: report?.termination === 'exited', exit_code: report?.exitCode === 0,
    appcontainer: report?.appContainer === true, zero_capabilities: report?.capabilityCount === 0, atomic_job: report?.atomicJob === true, low_integrity: report?.lowIntegrity === true,
    cleanup: report?.cleanupConfirmed === true, acl_restored: report?.aclRestored === true, profile_deleted: report?.profileDeleted === true, empty_job: report?.activeProcesses === 0,
    stdout_complete: report?.stdoutTruncated === false, stderr_complete: report?.stderrTruncated === false, stdout_marker: stdoutMarker, stderr_empty: report?.stderrHex === ''};
  const failures = Object.entries(checks).filter(([, okay]) => !okay).map(([name]) => name); saveEvidence(directory, 'work', received, report, failures.length === 0, failures, execution);
  if (failures.length) return fail();
  return {schema: 'aaw.portable.work-proof.v1', status: 'PASS', nativeSha256: options.components.workRunner.sha256, runtimeSha256: options.components.node.sha256,
    appContainer: true, capabilityCount: 0, atomicJob: true, cleanupConfirmed: true, aclRestored: true, profileDeleted: true, activeProcesses: 0,
    executionId: id, signature, reportSha256: hash(received.stdout), testedAt: new Date().toISOString(), scope: 'Fixed synthetic stdout marker; no model, project, WSL, OA or EDA.'};
}
async function guardianTest(options: PackagedNativeSelfTestOptions, directory: string, dataRoot: string): Promise<Record<string, unknown>> {
  const execution = path.join(dataRoot, 'agent-engine-pilot/native', randomUUID()); mkdir(execution);
  const directories: Record<string, string> = {}; for (const name of ['cwd', 'home', 'appdata', 'localappdata', 'temp', 'config', 'data', 'cache', 'state', 'managed']) {directories[name] = path.join(execution, name); mkdir(directories[name]!);}
  const configDirectory = path.join(directories.config!, 'opencode'); mkdir(configDirectory);
  write(path.join(directories.cwd!, 'package.json'), '{"private":true}\n'); write(path.join(directories.cwd!, 'tsconfig.json'), '{"compilerOptions":{}}\n');
  const userNpmrc = path.join(execution, 'user.npmrc'), globalNpmrc = path.join(execution, 'global.npmrc'), models = path.join(directories.cache!, 'models.json');
  write(userNpmrc, ''); write(globalNpmrc, ''); write(models, '{}\n'); write(path.join(directories.cwd!, '.npmrc'), 'offline=true\naudit=false\nregistry=http://127.0.0.1:9\n');
  const server = net.createServer(); let port = 0;
  await new Promise<void>((resolve, reject) => {const timer = setTimeout(() => {server.close(); reject(Error('PACKAGED_NATIVE_SELF_TEST_FAILED'));}, 3000);
    server.once('error', () => {clearTimeout(timer); reject(Error('PACKAGED_NATIVE_SELF_TEST_FAILED'));}); server.listen(0, '127.0.0.1', () => {clearTimeout(timer); const address = server.address(); if (!address || typeof address === 'string') {server.close(); reject(Error('PACKAGED_NATIVE_SELF_TEST_FAILED')); return;} port = address.port; server.close(error => error ? reject(Error('PACKAGED_NATIVE_SELF_TEST_FAILED')) : resolve());});});
  const password = randomBytes(32).toString('hex'), windows = path.resolve(process.env.SystemRoot ?? 'C:/Windows');
  const configuration = {username: 'setup-self-test', autoupdate: false, snapshot: false, share: 'disabled', plugin: [], mcp: {}, instructions: [], enabled_providers: [], skills: {paths: [], urls: []}, lsp: false, formatter: false, permission: {'*': 'deny'}};
  const environment: NodeJS.ProcessEnv = {SystemRoot: windows, WINDIR: windows, PATH: path.join(windows, 'System32'), HOME: directories.home, USERPROFILE: directories.home, APPDATA: directories.appdata, LOCALAPPDATA: directories.localappdata,
    TEMP: directories.temp, TMP: directories.temp, XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data, XDG_CACHE_HOME: directories.cache, XDG_STATE_HOME: directories.state,
    OPENCODE_TEST_HOME: directories.home, OPENCODE_TEST_MANAGED_CONFIG_DIR: directories.managed, OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_MODELS_PATH: models, OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_registry: 'http://127.0.0.1:9', npm_config_cache: directories.cache, npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc};
  for (const name of ['OPENCODE_PURE', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_DISABLE_EMBEDDED_WEB_UI', 'OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER']) environment[name] = 'true';
  if (options.signal?.aborted) return fail();
  const child = spawn(options.components.guardian.path, [execution, String(port)], {cwd: directories.cwd!, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment});
  let stopping = false; const stop = () => {if (stopping) return; stopping = true; try {child.stdin?.end('C');} catch {}};
  options.signal?.addEventListener('abort', stop, {once: true}); if (options.signal?.aborted) stop();
  let closed = false, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null, spawnError: string | null = null, stdoutBytes = 0, stderrBytes = 0;
  child.stdin?.on('error', () => {}); child.stdout?.on('data', (chunk: Buffer) => {stdoutBytes += chunk.length;}); child.stderr?.on('data', (chunk: Buffer) => {stderrBytes += chunk.length;});
  const exited = new Promise<void>(resolve => {child.once('error', () => {closed = true; spawnError = 'GUARDIAN_START_ERROR'; resolve();}); child.once('close', (code, signal) => {closed = true; exitCode = code; exitSignal = signal; resolve();});});
  let healthy = false; const health: unknown[] = [], deadline = Date.now() + 30000;
  const observe = (value: unknown) => {health.push(value); if (health.length > 8) health.shift();};
  try {
    while (!closed && !options.signal?.aborted && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/global/health`, {headers: {Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64')}, signal: AbortSignal.timeout(1000), redirect: 'error'});
        const reader = response.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
        if (!reader) return fail(); try {for (;;) {const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 65536) return fail(); chunks.push(next.value);}} finally {await reader.cancel().catch(() => {});}
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {healthy?: unknown; version?: unknown};
        observe({status: response.status, healthy: body.healthy === true, version: body.version === '1.18.17' ? '1.18.17' : 'unexpected'});
        if (response.ok && body.healthy === true && body.version === '1.18.17') {healthy = true; break;}
      } catch {observe({status: null, healthy: false, version: null, error: 'HEALTH_REQUEST_FAILED'});}
      await sleep(100);
    }
  } finally {stop(); let timer: ReturnType<typeof setTimeout> | undefined; try {await Promise.race([exited, new Promise<void>(resolve => {timer = setTimeout(resolve, 6000);})]);} finally {clearTimeout(timer); options.signal?.removeEventListener('abort', stop);}}
  if (!closed) {try {child.kill();} catch {} child.unref(); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();}
  let result: Record<string, unknown> | null = null; try {const file = stableFile(path.join(execution, 'guardian-control/result.json'), 65536); if (file.data) {const parsed: unknown = JSON.parse(file.data.toString('utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as Record<string, unknown>;}} catch {}
  const job = result?.job as {activeProcesses?: unknown; emptyConfirmed?: unknown; closed?: unknown} | undefined;
  const checks = {not_cancelled: !options.signal?.aborted, closed, healthy, launcher_exit: exitCode === 0, result_present: result !== null, cleanup: result?.cleanupConfirmed === true, engine_exited: result?.engineExited === true, empty_job: job?.activeProcesses === 0, job_empty_confirmed: job?.emptyConfirmed === true, job_closed: job?.closed === true};
  const failures = Object.entries(checks).filter(([, okay]) => !okay).map(([name]) => name);
  // Never retain guardian output: it can include authentication or configuration.
  saveEvidence(directory, 'guardian', {code: exitCode, signal: exitSignal, closed, transportError: spawnError, stdout: '', stderr: '', stdoutObservedBytes: stdoutBytes, stderrObservedBytes: stderrBytes}, result, failures.length === 0, failures, path.join(execution, 'guardian-control'), health);
  if (failures.length) return fail();
  return {status: 'PASS', healthy: true, engineVersion: '1.18.17', nativeSha256: options.components.guardian.sha256, engineSha256: options.components.opencode.sha256, cleanupConfirmed: true, activeProcesses: 0, testedAt: new Date().toISOString(), scope: 'Loopback health followed by verified stop; no model request.'};
}

/** Uses only bundled executables and fixed synthetic input. No compiler or project/model/WSL input is accepted. */
async function executePackagedNativeSelfTests(options: PackagedNativeSelfTestOptions): Promise<{
  workProof: Record<string, unknown>;
  guardianProof: Record<string, unknown>;
}> {
  if (process.platform !== 'win32' || process.arch !== 'x64' || options.signal?.aborted) return fail();
  const installationRoot = absolute(options.installationRoot), storageRoot = absolute(options.storageRoot), dataRoot = path.join(storageRoot, '.local'), directory = absolute(options.directory);
  if (within(installationRoot, storageRoot) || within(storageRoot, installationRoot) || path.dirname(directory) !== path.join(dataRoot, 'runtime-admission') || !/^init-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(path.basename(directory))) return fail();
  ordinary(installationRoot, true); ordinary(storageRoot, true); ordinary(directory, true);
  const keys = ['node', 'nodeLicense', 'opencode', 'guardian', 'commandRunner', 'workRunner', 'windowsFs', 'commandBootstrap'] as const;
  if (!options.components || Object.keys(options.components).sort().join() !== [...keys].sort().join()) return fail();
  for (const name of keys) {
    const component = options.components[name]; if (!component || absolute(component.path) !== component.path || !within(installationRoot, component.path) || !Number.isSafeInteger(component.bytes) || component.bytes < 1 || component.bytes > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(component.sha256)) return fail();
    const file = stableFile(component.path, component.bytes); if (file.bytes !== component.bytes || file.sha256 !== component.sha256) return fail();
  }
  for (const name of ['node', 'nodeLicense', 'opencode'] as const) {const component = options.components[name], expected = fixed[name]; if (component.sha256 !== expected.sha256 || 'bytes' in expected && component.bytes !== expected.bytes) return fail();}
  const evidence = path.join(directory, 'self-tests'); fs.mkdirSync(evidence); ordinary(evidence, true);
  try {
    const workProof = await workTest(options, evidence, dataRoot); if (options.signal?.aborted) return fail();
    const guardianProof = await guardianTest(options, evidence, dataRoot); if (options.signal?.aborted) return fail();
    // A component change during either test invalidates both results.
    for (const name of keys) {const component = options.components[name], file = stableFile(component.path, component.bytes); if (file.bytes !== component.bytes || file.sha256 !== component.sha256) return fail();}
    write(path.join(evidence, 'result.json'), JSON.stringify({schema: 'aaw.packaged-native-self-tests/v1', status: 'PASS', workProof, guardianProof}, null, 2) + '\n');
    return {workProof, guardianProof};
  } catch {
    try {write(path.join(evidence, 'failure.json'), JSON.stringify({schema: 'aaw.packaged-native-self-tests/v1', status: 'FAIL', code: 'PACKAGED_NATIVE_SELF_TEST_FAILED'}) + '\n');} catch {}
    return fail();
  }
}

/** Report only a fixed error code; filesystem exceptions may contain local paths. */
export async function runPackagedNativeSelfTests(options: PackagedNativeSelfTestOptions): Promise<{
  workProof: Record<string, unknown>;
  guardianProof: Record<string, unknown>;
}> {
  try {return await executePackagedNativeSelfTests(options);} catch {return fail();}
}
