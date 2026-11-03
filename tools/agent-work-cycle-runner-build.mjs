import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local', 'agent-work-cycle-runner');
const mode = process.argv[2];
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.20.0'
    || !['profile-probe', 'environment-probe', 'acl-restore-probe', 'native'].includes(mode) || process.argv.length !== 3) throw new Error('Unsupported explicit build');
const sha = name => crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex');
const nodeSource = path.join(root, '.local', 'toolchains', 'node-v24.20.0-win-x64', 'node.exe');
const licenseSource = path.join(path.dirname(nodeSource), 'LICENSE');
const nodeSha256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5';
if (sha(nodeSource) !== nodeSha256 || sha(process.execPath) !== nodeSha256) throw new Error('Pinned build/runtime Node differs');
function directory(name) {
  const absolute = path.resolve(name);
  if (!absolute.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('Build path escaped product');
  const parent = path.dirname(absolute);
  if (!fs.existsSync(parent)) directory(parent);
  if (!fs.existsSync(absolute)) fs.mkdirSync(absolute);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute).toLowerCase() !== absolute.toLowerCase()) throw new Error('Build path is not an ordinary directory');
}
const output = path.join(local, 'build');
directory(output);
if (mode === 'acl-restore-probe') directory(path.join(local, 'probe-04'));
if (mode !== 'native' && mode !== 'acl-restore-probe') {
  const probe = path.join(local, mode === 'environment-probe' ? 'probe-03' : 'probe-02');
  if (!fs.existsSync(probe)) {
    for (const leaf of ['runtime', 'input', 'output']) directory(path.join(probe, leaf));
    fs.copyFileSync(nodeSource, path.join(probe, 'runtime', 'node.exe'), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(licenseSource, path.join(probe, 'runtime', 'LICENSE'), fs.constants.COPYFILE_EXCL);
  } else if (sha(path.join(probe, 'runtime', 'node.exe')) !== nodeSha256
      || sha(path.join(probe, 'runtime', 'LICENSE')) !== sha(licenseSource)
      || fs.readdirSync(path.join(probe, 'input')).length || fs.readdirSync(path.join(probe, 'output')).length) throw new Error('Existing probe is not an unused matching preparation');
}
const vc = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207';
const sdk = 'C:\\Program Files (x86)\\Windows Kits\\10';
const compiler = path.join(vc, 'bin', 'Hostx64', 'x64', 'cl.exe');
const source = path.join(root, 'tools', 'agent-work-cycle-runner-' + (mode === 'native' ? 'native' : mode) + '.cc');
const stem = mode === 'native' ? 'runner' : mode;
const executable = path.join(output, stem + '.exe');
const additionalSources = [];
if (mode === 'native') {
  const shared = path.join(root, 'apps', 'desktop', 'src', 'shared', 'agent', 'agent-work-cycle.ts');
  const text = fs.readFileSync(shared, 'utf8').match(/WORK_CYCLE_LIMITS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/u)?.[1];
  if (!text) throw new Error('Shared runner limits missing');
  const names = ['files','fileBytes','workspaceBytes','artifactsPerExecution','relativePathBytes','pathDepth','logBytes','outputBytes','executionMs','cleanupMs','nativeCallMs','processes','processMemoryBytes','jobMemoryBytes'];
  const values = Object.fromEntries(names.map(name => {
    const expression = text.match(new RegExp('\\b' + name + '\\s*:\\s*([0-9][0-9\\s*]*)(?=,)','u'))?.[1];
    if (!expression || !/^\s*\d+(?:\s*\*\s*\d+)*\s*$/u.test(expression)) throw new Error('Shared limit unsupported: ' + name);
    const value = expression.split('*').map(part => Number(part.trim())).reduce((a,b) => a*b,1);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid shared limit');
    return [name,value];
  }));
  const generated = path.join(output, 'runner-limits.h');
  fs.writeFileSync(generated, '#pragma once\n#include <cstddef>\nnamespace limits {\n' + Object.entries(values).map(([name,value]) => 'inline constexpr std::size_t ' + name + ' = ' + value + ';').join('\n') + '\n}\n');
  for (const filename of [shared,path.join(root,'tools','agent-work-cycle-runner-native-security.h'),generated]) additionalSources.push({path:path.relative(root,filename),sha256:sha(filename)});
}
const args = [
  '/nologo', '/MT', '/EHsc', '/W4', '/WX', '/std:c++20', '/DUNICODE', '/D_UNICODE', '/sdl', '/guard:cf',
  '/I' + path.join(vc, 'include'), '/I' + output,
  ...['ucrt', 'shared', 'um'].map(part => '/I' + path.join(sdk, 'Include', '10.0.26100.0', part)),
  '/Fo' + path.join(output, stem + '.obj'), '/Fd' + path.join(output, stem + '.pdb'),
  '/Fe' + executable, source, '/link',
  '/LIBPATH:' + path.join(vc, 'lib', 'x64'),
  '/LIBPATH:' + path.join(sdk, 'Lib', '10.0.26100.0', 'ucrt', 'x64'),
  '/LIBPATH:' + path.join(sdk, 'Lib', '10.0.26100.0', 'um', 'x64'),
  'userenv.lib', 'advapi32.lib', 'kernel32.lib', 'bcrypt.lib', 'ole32.lib', 'shell32.lib',
  '/DYNAMICBASE', '/NXCOMPAT', '/CETCOMPAT', '/guard:cf',
];
const build = spawnSync(compiler, args, { cwd: output, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 65536, timeout: 60000 });
const result = {
  schema: 'aaw.c1.runner-build.v1', mode, builtAt: new Date().toISOString(),
  source: { path: path.relative(root, source), sha256: sha(source) },
  additionalSources,
  recipe: { path: 'tools/agent-work-cycle-runner-build.mjs', sha256: sha(fileURLToPath(import.meta.url)) },
  toolchain: { compiler, sha256: sha(compiler), sdk: '10.0.26100.0', staticCrt: true },
  runtime: { source: path.relative(root, nodeSource), version: '24.20.0', sha256: nodeSha256, bytes: fs.statSync(nodeSource).size,
    license: path.relative(root, licenseSource), licenseSha256: sha(licenseSource), sourceUse: 'Existing product toolchain; a separately pinned copy is used for C1 analysis.' },
  exitCode: build.status, stdout: build.stdout, stderr: build.stderr,
  output: build.status === 0 ? { path: path.relative(root, executable), bytes: fs.statSync(executable).size, sha256: sha(executable) } : null,
};
fs.writeFileSync(path.join(output, stem + '-build.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
if (build.error || build.status !== 0) process.exitCode = 1;
