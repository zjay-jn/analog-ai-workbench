import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runtimePaths} from './runtime-paths';
import {packagedContext, packagedRuntimeComponent} from './packaged-admission';

export type RuntimePin = Readonly<{path: string; bytes: number; sha256: string}>;
export type RuntimeComponentId = 'opencode' | 'guardian' | 'windowsFs' | 'commandRunner' | 'workRunner' | 'workProof' | 'node' | 'nodeLicense' | 'commandBootstrap' | 'commandAdmission';
type Component = RuntimePin & Readonly<{sources: readonly Readonly<{path: string; sha256: string}>[]; version?: string}>;
type Manifest = Readonly<{schemaVersion: 'aaw.desktop-runtime/v1'; platform: 'win32'; arch: 'x64'; nodeVersion: '24.20.0'; dataRoot: string;
  components: Partial<Record<RuntimeComponentId, Component>>;
  build: Readonly<{id: string; exitCode: 0; generated: readonly RuntimePin[]; [key: string]: unknown}>}>;
const locations: Record<RuntimeComponentId, string> = {
  opencode: '.local/runtime/opencode/1.18.17/opencode.exe', guardian: '.local/runtime/native/guardian.exe',
  windowsFs: '.local/runtime/native/windows-fs-native.node', commandRunner: '.local/runtime/native/command-runner.exe',
  workRunner: '.local/runtime/native/work-runner.exe', workProof: '.local/runtime/work-proof.json',
  node: '.local/runtime/node/node.exe', nodeLicense: '.local/runtime/node/LICENSE',
  commandBootstrap: 'tools/agent-command-runner-bootstrap.ps1', commandAdmission: '.local/runtime/command-admission.json',
};
const nativeSources: Partial<Record<RuntimeComponentId, readonly string[]>> = {
  guardian: ['tools/agent-engine-lifecycle-guardian.cc', 'tools/agent-work-cycle-runner-native-security.h', 'tools/portable-native-build.mjs'],
  commandRunner: ['tools/agent-command-runner-native.cc', 'tools/agent-work-cycle-runner-native-security.h', 'tools/portable-native-build.mjs'],
  workRunner: ['tools/agent-work-cycle-runner-native.cc', 'tools/agent-work-cycle-runner-native-security.h', 'tools/portable-native-build.mjs'],
  windowsFs: ['packages/windows-fs-native/src/addon.cc', 'packages/windows-fs-native/binding.gyp', 'tools/portable-native-build.mjs'],
};
const fail = (): never => {throw Error('DESKTOP_RUNTIME_UNAVAILABLE');};
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function relativeFile(value: unknown): value is string {
  return typeof value === 'string' && value.length < 512 && !path.isAbsolute(value) && !value.includes('\\')
    && !value.includes(':') && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
function ordinary(file: string): fs.BigIntStats {
  const absolute = path.resolve(file), chain: string[] = [];
  for (let current = absolute; ; current = path.dirname(current)) {chain.unshift(current); if (current === path.dirname(current)) break;}
  for (const [index, entry] of chain.entries()) {
    const stat = fs.lstatSync(entry, {bigint: true});
    if (stat.isSymbolicLink() || fs.realpathSync.native(entry).toLowerCase() !== entry.toLowerCase()
      || (index !== chain.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail();
  }
  return fs.lstatSync(absolute, {bigint: true});
}
function read(file: string, limit: number): Buffer {
  const before = ordinary(file); if (before.size > BigInt(limit)) fail();
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, {bigint: true}), bytes = fs.readFileSync(fd), after = ordinary(file), closed = fs.fstatSync(fd, {bigint: true});
    if ([opened, after, closed].some(value => value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size
      || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs || value.nlink !== 1n)
      || bytes.length !== Number(before.size)) fail();
    return bytes;
  } finally {fs.closeSync(fd);}
}
function pin(value: unknown): RuntimePin {
  const item = value as RuntimePin;
  if (!item || !relativeFile(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 256*1024*1024 || !/^[a-f0-9]{64}$/u.test(item.sha256)) fail();
  const file = path.resolve(runtimePaths().installationRoot, ...item.path.split('/'));
  const bytes = read(file, item.bytes);
  if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) fail();
  return Object.freeze({path: file, bytes: item.bytes, sha256: item.sha256});
}
export function runtimeManifestPin(): RuntimePin {
  if (runtimePaths().mode === 'packaged') {const pin = packagedContext().distribution.pin; const bytes = read(pin.path, pin.bytes); if (digest(bytes) !== pin.sha256) fail(); return pin;}
  const file = path.join(runtimePaths().runtimeRoot, 'runtime-manifest.json'), bytes = read(file, 1024*1024);
  return Object.freeze({path: file, bytes: bytes.length, sha256: digest(bytes)});
}
export function runtimeManifest(): Manifest {
  try {
    if (runtimePaths().mode !== 'source') fail();
    const proof = runtimeManifestPin(), manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(read(proof.path, proof.bytes))) as Manifest;
    if (manifest.schemaVersion !== 'aaw.desktop-runtime/v1' || manifest.platform !== 'win32' || manifest.arch !== 'x64'
      || manifest.nodeVersion !== '24.20.0' || manifest.dataRoot !== runtimePaths().dataRoot || !manifest.components
      || typeof manifest.components !== 'object' || Array.isArray(manifest.components) || Object.keys(manifest.components).some(key => !Object.hasOwn(locations,key))
      || !manifest.build || manifest.build.exitCode !== 0 || typeof manifest.build.id !== 'string' || !Array.isArray(manifest.build.generated) || manifest.build.generated.length > 32) fail();
    const generated: RuntimePin[] = [];
    for (const entry of manifest.build.generated) {if (!entry.path.startsWith('.local/runtime/build/')) fail(); generated.push(pin(entry));}
    const pathHeaders = generated.filter(entry => path.basename(entry.path) === 'runtime-paths.h');
    if (pathHeaders.length !== 1) fail();
    const header = pathHeaders[0]!, bytes = read(header.path, Math.min(header.bytes, 64*1024));
    if (bytes.length !== header.bytes || digest(bytes) !== header.sha256) fail();
    const lines = new TextDecoder('utf-8', {fatal: true}).decode(bytes).split(/\r?\n/u);
    for (const [name, value] of [['installationRuntime', runtimePaths().runtimeRoot], ['dataLocal', runtimePaths().dataRoot]] as const) {
      const declaration = `inline constexpr wchar_t ${name}[]=L${JSON.stringify(value + path.sep)};`;
      if (lines.filter(line => line === declaration).length !== 1) fail();
    }
    return manifest;
  } catch {return fail();}
}
/** Installation is explicit. Missing, moved or changed components remain unavailable. */
export function runtimeComponent(id: RuntimeComponentId): RuntimePin {
  try {
    if (runtimePaths().mode === 'packaged') return packagedRuntimeComponent(id);
    const manifest = runtimeManifest(), item = manifest.components[id];
    if (!item) return fail();
    if (item.path !== locations[id] || !Array.isArray(item.sources) || item.sources.length > 16) fail();
    const required = nativeSources[id] ?? [], names = item.sources.map(source => source.path);
    if (new Set(names).size !== names.length || required.some(source => !names.includes(source)) || names.some(source => !relativeFile(source) || source.startsWith('.local/'))) fail();
    for (const source of item.sources) {
      if (!/^[a-f0-9]{64}$/u.test(source.sha256) || digest(read(path.join(runtimePaths().installationRoot, ...source.path.split('/')), 2*1024*1024)) !== source.sha256) fail();
    }
    if (id === 'opencode' && (item.version !== '1.18.17' || item.bytes !== 178721160 || item.sha256 !== '2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54')) fail();
    if (id === 'node' && (item.bytes !== 93381448 || item.sha256 !== '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5')) fail();
    if (id === 'nodeLicense' && item.sha256 !== 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9') fail();
    return pin(item);
  } catch {return fail();}
}
