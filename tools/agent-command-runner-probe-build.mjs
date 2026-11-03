import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = 'C:\\work\\analog_ai_workbench';
const evidence = path.join(root, '.local', 'quality-evidence', '20260914-agent-command-native-01');
const own = fileURLToPath(import.meta.url);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const node = path.join(root, '.local', 'toolchains', 'node-v24.20.0-win-x64', 'node.exe');
const nodeSha = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.20.0' || process.argv.length !== 3 || !/^build-[0-9]{2}$/.test(process.argv[2]) || sha(node) !== nodeSha || sha(process.execPath) !== nodeSha) throw new Error('Explicit pinned Windows build required');
const ordinary = file => { const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || fs.realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('Aliased build input: ' + file); return stat; };
for (let directory = root; directory.length > 3; directory = path.dirname(directory)) ordinary(directory);
const output = path.join(evidence, process.argv[2]);
if (fs.existsSync(output)) throw new Error('Build receipt directory already exists');
fs.mkdirSync(output, { recursive: true });
for (let directory = output; directory.length > root.length; directory = path.dirname(directory)) ordinary(directory);
const security = path.join(root, 'tools', 'agent-work-cycle-runner-native-security.h');
if (sha(security) !== '98c8ba8e661ad9b63d9a40f7d0462bab5d455e52656cc2dda808b3f433b19560') throw new Error('Shared immutable security source changed');
const generated = path.join(output, 'runner-limits.h');
fs.writeFileSync(generated, '#pragma once\n#include <cstddef>\nnamespace limits { inline constexpr std::size_t files=100, fileBytes=65536, workspaceBytes=1048576, artifactsPerExecution=16, relativePathBytes=240, pathDepth=8; }\n', { flag: 'wx' });
const vc = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207';
const sdk = 'C:\\Program Files (x86)\\Windows Kits\\10';
const compiler = path.join(vc, 'bin', 'Hostx64', 'x64', 'cl.exe');
const source = path.join(root, 'tools', 'agent-command-runner-probe.cc');
const executable = path.join(output, 'command-probe.exe');
const sources = [source, security, generated, own].map(file => ({ path: path.relative(root, file), bytes: ordinary(file).size, sha256: sha(file) }));
const args = ['/nologo', '/MT', '/EHsc', '/W4', '/WX', '/utf-8', '/std:c++20', '/DUNICODE', '/D_UNICODE', '/sdl', '/guard:cf', '/I' + path.join(vc, 'include'), '/I' + output,
  ...['ucrt', 'shared', 'um'].map(part => '/I' + path.join(sdk, 'Include', '10.0.26100.0', part)),
  '/Fo' + path.join(output, 'command-probe.obj'), '/Fd' + path.join(output, 'command-probe.pdb'), '/Fe' + executable, source, '/link',
  '/LIBPATH:' + path.join(vc, 'lib', 'x64'), '/LIBPATH:' + path.join(sdk, 'Lib', '10.0.26100.0', 'ucrt', 'x64'), '/LIBPATH:' + path.join(sdk, 'Lib', '10.0.26100.0', 'um', 'x64'),
  'userenv.lib', 'advapi32.lib', 'kernel32.lib', 'bcrypt.lib', 'ole32.lib', 'shell32.lib', '/DYNAMICBASE', '/NXCOMPAT', '/CETCOMPAT', '/guard:cf'];
const build = spawnSync(compiler, args, { cwd: output, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 131072, timeout: 60000 });
const unchanged = sources.every(item => sha(path.join(root, item.path)) === item.sha256);
const result = { schema: 'aaw.command.probe-build.v1', builtAt: new Date().toISOString(), scope: 'compatibility_probe_only', sources, unchanged, toolchain: { compiler, sha256: sha(compiler), sdk: '10.0.26100.0', staticCrt: true }, args,
  exitCode: build.status, error: build.error?.message ?? null, stdout: build.stdout, stderr: build.stderr,
  output: build.status === 0 && unchanged ? { path: path.relative(root, executable), bytes: fs.statSync(executable).size, sha256: sha(executable) } : null };
fs.writeFileSync(path.join(output, 'build-proof.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
if (build.status !== 0 || build.error || !unchanged) process.exitCode = 1;
