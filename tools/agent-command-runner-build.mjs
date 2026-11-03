import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = 'C:\\work\\analog_ai_workbench';
const evidence = path.join(root, '.local', 'quality-evidence', '20260914-agent-command-native-01');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ordinary = file => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('Aliased input: ' + file); return stat; };
const ref = file => ({ path: path.relative(root, file), bytes: ordinary(file).size, sha256: sha(file) });
const node = path.join(root, '.local', 'toolchains', 'node-v24.20.0-win-x64', 'node.exe');
const nodeSha = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.20.0' || process.argv.length !== 3 || !/^native-build-[0-9]{2}$/.test(process.argv[2]) || sha(node) !== nodeSha || sha(process.execPath) !== nodeSha) throw new Error('Explicit pinned Windows native build required');
for (let directory = root; directory.length > 3; directory = path.dirname(directory)) ordinary(directory);
const output = path.join(evidence, process.argv[2]);
if (fs.existsSync(output)) throw new Error('Build output already exists');
const security = path.join(root, 'tools', 'agent-work-cycle-runner-native-security.h');
if (sha(security) !== '98c8ba8e661ad9b63d9a40f7d0462bab5d455e52656cc2dda808b3f433b19560') throw new Error('Immutable security source changed');
const source = path.join(root, 'tools', 'agent-command-runner-native.cc');
const bootstrap = path.join(root, 'tools', 'agent-command-runner-bootstrap.ps1');
const sourceRefs = [source, security, bootstrap, fileURLToPath(import.meta.url)].map(ref);
const systemFiles = [
  { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', bytes: 495616, sha256: '8bb6fa8c283b4d92120b1ef249a9b311b0f804d4cabbe9981159976c8be76a5e' },
  { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe.config', bytes: 395, sha256: '7bd3f01f04332f1657494e879e861500d520f49b8f9a2a2d511d1d6736c85656' },
  { path: 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\System.Management.Automation\\v4.0_3.0.0.0__31bf3856ad364e35\\System.Management.Automation.dll', bytes: 6681600, sha256: '29804b1144d314e114c1ee9311756efa0f9d3b80d5b489cd551a684b41b8e7f9' },
  { path: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\clr.dll', bytes: 10000696, sha256: '217a9b1911d3631e5b63b5146745d0fdc71c4b6aa37e550202ca0afba33ac79a' },
];
for (const file of systemFiles) if (ordinary(file.path).size !== file.bytes || sha(file.path) !== file.sha256) throw new Error('System runtime changed: ' + file.path);
const declaration = {
  schema: 'aaw.command.native-profile.v1', candidateOnly: true, sourceRefs, systemFiles,
  dependencyScope: 'pinned_entry_engine_clr_configuration_plus_appcontainer_os_acl; not_a_complete_transitive_module_manifest',
  shellVersion: '5.1.26100.9444', bootstrap: ref(bootstrap), node: ref(node),
  license: ref(path.join(path.dirname(node), 'LICENSE')),
  argv: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', '<private runtime>\\bootstrap.ps1'],
  executionPolicyScope: 'Process', powershellDrives: { AAWWork: '<private work>', AAWTools: '<private runtime>' }, nodeAlias: 'AAWTools:\\node.exe',
  commandEncoding: 'utf8_bom', commandSemantics: 'normal script invocation; explicit exit and final external LASTEXITCODE propagated',
  nodeOptions: '--preserve-symlinks-main --preserve-symlinks', nodeOptionsSource: 'fixed_trusted_profile_not_host_inherited',
  hostEnvironment: 'not_inherited', privateDirectories: ['work', 'home', 'temp'], baselineReadOnly: true, projectAccess: 'none',
  networkCapabilities: 0, executableScope: 'appcontainer_os_acl', executableAllowlistEnforced: false,
  activeProcesses: 8, processMemoryBytes: 536870912, jobMemoryBytes: 1073741824, killOnJobClose: true, breakawayAllowed: false,
  inheritedHandles: ['stdin', 'stdout', 'stderr'], maxTimeoutMs: 600000, cleanupMs: 10000, logBytes: 16777216,
  statusPublication: { temporary: 'unique_status_sequence', atomicReplace: true, retryCodes: [5, 32, 33], retryMs: 250, maxAttempts: 26, accessDeniedRetry: 'fixed_trusted_status_replace_only' },
  resultPublication: 'independent_write_flush_close_atomic_rename_no_replace; status_failure_does_not_block_result',
  work: { files: 32, fileBytes: 65536, bytes: 1048576, pathDepth: 4, relativePathBytes: 240 },
  eachScratchTree: { files: 64, fileBytes: 262144, bytes: 4194304, pathDepth: 4, entries: 128 },
  diskBudgetEnforcement: 'periodic_1000ms_observation_and_terminal_adoption; not_hard_volume_quota',
  observedProcessRecordLimit: 1024, processObservation: '10ms_sampled_active_members_not_exhaustive', survivesAppClose: false,
};
const profileRevision = hash(Buffer.from(JSON.stringify(declaration)));
fs.mkdirSync(output, { recursive: true });
for (let directory = output; directory.length > root.length; directory = path.dirname(directory)) ordinary(directory);
const manifest = path.join(output, 'environment-profile.json');
fs.writeFileSync(manifest, JSON.stringify({ ...declaration, profileRevision }, null, 2) + '\n', { flag: 'wx' });
const limits = path.join(output, 'runner-limits.h');
fs.writeFileSync(limits, '#pragma once\n#include <cstddef>\nnamespace limits { inline constexpr std::size_t files=32, fileBytes=65536, workspaceBytes=1048576, artifactsPerExecution=8, relativePathBytes=240, pathDepth=4; }\n', { flag: 'wx' });
const profile = path.join(output, 'command-profile.h');
fs.writeFileSync(profile, '#pragma once\nnamespace profile {\ninline constexpr char revision[]=' + JSON.stringify(profileRevision) + ';\ninline constexpr unsigned long long bootstrapBytes=' + ordinary(bootstrap).size + ';\ninline constexpr char bootstrapSha256[]=' + JSON.stringify(sha(bootstrap)) + ';\nstruct File {const wchar_t* path;unsigned long long bytes;const char* sha256;};\ninline constexpr File systemFiles[]={\n' + systemFiles.map(file => '{L' + JSON.stringify(file.path) + ',' + file.bytes + ',' + JSON.stringify(file.sha256) + '}').join(',\n') + '\n};\n}\n', { flag: 'wx' });
const vc = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207';
const sdk = 'C:\\Program Files (x86)\\Windows Kits\\10';
const compiler = path.join(vc, 'bin', 'Hostx64', 'x64', 'cl.exe');
const executable = path.join(output, 'agent-command-runner-native.exe');
const sources = [...sourceRefs, ref(limits), ref(profile), ref(manifest)];
const args = ['/nologo', '/MT', '/EHsc', '/W4', '/WX', '/utf-8', '/std:c++20', '/DUNICODE', '/D_UNICODE', '/sdl', '/guard:cf', '/I' + path.join(vc, 'include'), '/I' + output,
  ...['ucrt', 'shared', 'um'].map(part => '/I' + path.join(sdk, 'Include', '10.0.26100.0', part)),
  '/Fo' + path.join(output, 'native.obj'), '/Fd' + path.join(output, 'native.pdb'), '/Fe' + executable, source, '/link',
  '/LIBPATH:' + path.join(vc, 'lib', 'x64'), '/LIBPATH:' + path.join(sdk, 'Lib', '10.0.26100.0', 'ucrt', 'x64'), '/LIBPATH:' + path.join(sdk, 'Lib', '10.0.26100.0', 'um', 'x64'),
  'userenv.lib', 'advapi32.lib', 'kernel32.lib', 'bcrypt.lib', 'ole32.lib', 'shell32.lib', '/DYNAMICBASE', '/NXCOMPAT', '/CETCOMPAT', '/guard:cf'];
const build = spawnSync(compiler, args, { cwd: output, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 262144, timeout: 60000 });
const unchanged = sources.every(file => sha(path.join(root, file.path)) === file.sha256);
const receipt = { schema: 'aaw.command.native-build.v1', builtAt: new Date().toISOString(), scope: 'production_candidate_not_admitted', sources, unchanged, profileRevision, profile: ref(manifest),
  toolchain: { compiler, sha256: sha(compiler), sdk: '10.0.26100.0', staticCrt: true }, args,
  exitCode: build.status, error: build.error?.message ?? null, stdout: build.stdout, stderr: build.stderr,
  output: build.status === 0 && unchanged ? ref(executable) : null };
fs.writeFileSync(path.join(output, 'build-proof.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(receipt) + '\n');
if (build.status !== 0 || build.error || !unchanged) process.exitCode = 1;
