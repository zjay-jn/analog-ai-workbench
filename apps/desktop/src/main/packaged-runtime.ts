import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export type PackagePin = Readonly<{path: string; bytes: number; sha256: string}>;
export const PACKAGED_COMPONENT_PATHS = Object.freeze({
  node: '.local/runtime/node/node.exe', nodeLicense: '.local/runtime/node/LICENSE',
  opencode: '.local/runtime/opencode/1.18.17/opencode.exe', guardian: '.local/runtime/native/guardian.exe',
  commandRunner: '.local/runtime/native/command-runner.exe', workRunner: '.local/runtime/native/work-runner.exe',
  windowsFs: '.local/runtime/native/windows-fs-native.node', commandBootstrap: 'tools/agent-command-runner-bootstrap.ps1',
});
export type PackagedComponentId = keyof typeof PACKAGED_COMPONENT_PATHS;
export type PackagedManifest = Readonly<{schemaVersion: 'aaw.packaged-runtime/v1'; platform: 'win32'; arch: 'x64'; nodeVersion: '24.20.0';
  version: string; sourceRevision: Readonly<{commit: string; dirty: boolean; sourceSha256: string}>;
  components: Readonly<Record<PackagedComponentId, PackagePin>>; files: readonly PackagePin[]}>;
export type PackagedDistribution = Readonly<{installationRoot: string; manifest: PackagedManifest; pin: PackagePin;
  components: Readonly<Record<PackagedComponentId, PackagePin>>; inventory: Readonly<{extraPaths: readonly string[]; omitted: number}>}>;
export const PACKAGE_MANIFEST_PATH = '.local/runtime/package-manifest.json';
const required = ['package.json', 'dist/cloud/main/index.js', 'dist/preload/preload/cloud.js', 'dist/preload/preload/sessions.js',
  'dist/renderer/index.html', 'dist/packaged-runtime-init.cjs', 'tools/agent-engine-pilot-sum.mjs', 'tools/agent-project-read-tools.mjs'];
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(): never {throw Error('PACKAGED_RUNTIME_INVALID');}
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function relative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 1024 && !path.isAbsolute(value) && !/[\\:\u0000-\u001f]/u.test(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
function pin(value: unknown): value is PackagePin {
  return exact(value, ['path', 'bytes', 'sha256']) && relative(value.path) && Number.isSafeInteger(value.bytes)
    && Number(value.bytes) > 0 && Number(value.bytes) <= 256*1024*1024 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256);
}
export function packagedOrdinary(file: string, directory = false): fs.BigIntStats {
  const absolute = path.resolve(file), chain: string[] = [];
  for (let cursor = absolute;; cursor = path.dirname(cursor)) {chain.unshift(cursor); if (path.dirname(cursor) === cursor) break;}
  let final!: fs.BigIntStats;
  for (const [index, entry] of chain.entries()) {
    const info = fs.lstatSync(entry, {bigint: true}), isDirectory = index < chain.length - 1 || directory;
    if (info.isSymbolicLink() || fs.realpathSync.native(entry).toLowerCase() !== entry.toLowerCase()
      || (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)) fail();
    final = info;
  }
  return final;
}
export function readPackagedFile(file: string, maxBytes: number): Buffer {
  const before = packagedOrdinary(file); if (before.size > BigInt(maxBytes)) fail();
  const descriptor = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(descriptor, {bigint: true}), data = fs.readFileSync(descriptor), after = packagedOrdinary(file), closed = fs.fstatSync(descriptor, {bigint: true});
    if ([opened, after, closed].some(info => info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size
      || info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs || info.nlink !== 1n) || data.length !== Number(before.size)) fail();
    return data;
  } finally {fs.closeSync(descriptor);}
}
export function packagedPinned(file: PackagePin): Buffer {
  const data = readPackagedFile(file.path, file.bytes);
  if (data.length !== file.bytes || digest(data) !== file.sha256) fail();
  return data;
}
export function packageManifestDocument(value: unknown): PackagedManifest {
  if (!exact(value, ['schemaVersion', 'platform', 'arch', 'nodeVersion', 'version', 'sourceRevision', 'components', 'files'])
    || value.schemaVersion !== 'aaw.packaged-runtime/v1' || value.platform !== 'win32' || value.arch !== 'x64' || value.nodeVersion !== '24.20.0'
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(value.version)
    || !exact(value.sourceRevision, ['commit', 'dirty', 'sourceSha256']) || typeof value.sourceRevision.commit !== 'string'
    || !/^[a-f0-9]{40}$/u.test(value.sourceRevision.commit) || typeof value.sourceRevision.dirty !== 'boolean'
    || typeof value.sourceRevision.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sourceRevision.sourceSha256)
    || !exact(value.components, Object.keys(PACKAGED_COMPONENT_PATHS)) || !Array.isArray(value.files) || !value.files.length || value.files.length > 10000) fail();
  const names = new Map<string, PackagePin>(); let total = 0;
  for (const item of value.files) {
    if (!pin(item) || item.path === PACKAGE_MANIFEST_PATH || names.has(item.path.toLowerCase())) fail();
    const parts = item.path.toLowerCase().split('/');
    if (parts.some(part => ['.git', 'node_modules', 'apps', 'packages', 'tests'].includes(part))
      || /^\.local\/runtime\/(?:build|verification|headers|downloads)(?:\/|$)/u.test(item.path)
      || ['.local/runtime/runtime-manifest.json', '.local/runtime/work-proof.json', '.local/runtime/command-admission.json'].includes(item.path)) fail();
    total += item.bytes; if (total > 1024*1024*1024) fail(); names.set(item.path.toLowerCase(), item);
  }
  for (const name of required) if (!names.has(name)) fail();
  for (const [id, location] of Object.entries(PACKAGED_COMPONENT_PATHS)) {
    const component = value.components[id];
    const listed = names.get(location.toLowerCase());
    if (!pin(component) || component.path !== location || !listed || listed.bytes !== component.bytes || listed.sha256 !== component.sha256) fail();
  }
  return structuredClone(value) as PackagedManifest;
}
/** Static inventory only. A valid distribution never establishes current-user execution readiness. */
export function loadPackagedDistribution(installationRoot: string, options: Readonly<{exactInventory?: boolean}> = {}): PackagedDistribution {
  const root = path.resolve(installationRoot); packagedOrdinary(root, true);
  const manifestFile = path.join(root, ...PACKAGE_MANIFEST_PATH.split('/')), bytes = readPackagedFile(manifestFile, 1024*1024);
  const manifest = packageManifestDocument(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  const expected = new Set(manifest.files.map(item => item.path));
  for (const item of manifest.files) packagedPinned({...item, path: path.join(root, ...item.path.split('/'))});
  const directories = new Set<string>();
  for (const name of expected) {const parts = name.split('/'); for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));}
  const extraPaths: string[] = []; let omitted = 0, count = 0;
  const extra = (name: string) => {if (options.exactInventory) fail(); if (extraPaths.length < 64) extraPaths.push(name); else omitted++;};
  const scan = (directory: string): void => {
    packagedOrdinary(directory, true);
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), key = path.relative(root, target).split(path.sep).join('/');
      if (key === PACKAGE_MANIFEST_PATH) continue;
      if (directories.has(key)) {scan(target); continue;}
      if (!expected.has(key)) {extra(key); continue;}
      packagedOrdinary(target); count++;
    }
  };
  scan(root); if (count !== expected.size) fail();
  const product = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(readPackagedFile(path.join(root, 'package.json'), 64*1024)));
  if (product.name !== 'analog-ai-workbench' || product.version !== manifest.version || product.main !== 'dist/cloud/main/index.js'
    || product.type !== undefined && product.type !== 'commonjs') fail();
  const components = Object.fromEntries(Object.entries(manifest.components).map(([id, component]) => [id, Object.freeze({...component, path: path.join(root, ...component.path.split('/'))})])) as Record<PackagedComponentId, PackagePin>;
  return Object.freeze({installationRoot: root, manifest, components: Object.freeze(components), inventory: Object.freeze({extraPaths: Object.freeze(extraPaths), omitted}),
    pin: Object.freeze({path: manifestFile, bytes: bytes.length, sha256: digest(bytes)})});
}
export function packagedAsset(distribution: PackagedDistribution, id: PackagedComponentId): PackagePin {
  const value = distribution.components[id]; if (!value) fail();
  if (id === 'node' && (value.bytes !== 93381448 || value.sha256 !== '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5')
    || id === 'nodeLicense' && value.sha256 !== 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9'
    || id === 'opencode' && (value.bytes !== 178721160 || value.sha256 !== '2d8ed451c4c3e4dd69b9dec026030ec5bd00814b8f2b81483f8d80e35d8dce54')) fail();
  packagedPinned(value); return value;
}
