import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRuntimePaths} from '../apps/desktop/src/main/runtime-paths';
import {loadPackagedDistribution, packageManifestDocument, packagedAsset, PACKAGED_COMPONENT_PATHS, PACKAGE_MANIFEST_PATH, type PackagePin} from '../apps/desktop/src/main/packaged-runtime';

const parent = path.join(process.cwd(), '.local/packaged-runtime-tests'); fs.mkdirSync(parent, {recursive: true});
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const files = new Map<string, PackagePin>();
  const write = (name: string, text: string) => {
    const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text);
    const pin = {path: name, bytes: Buffer.byteLength(text), sha256: sha(Buffer.from(text))}; files.set(name, pin); return pin;
  };
  for (const name of ['dist/cloud/main/index.js', 'dist/preload/preload/cloud.js', 'dist/preload/preload/sessions.js', 'dist/renderer/index.html',
    'dist/packaged-runtime-init.cjs', 'tools/agent-engine-pilot-sum.mjs', 'tools/agent-project-read-tools.mjs', ...Object.values(PACKAGED_COMPONENT_PATHS)]) write(name, 'synthetic test bytes; never executed: ' + name);
  write('package.json', JSON.stringify({name: 'analog-ai-workbench', version: '0.1.0-alpha.0', main: 'dist/cloud/main/index.js'}));
  const manifest = {schemaVersion: 'aaw.packaged-runtime/v1', platform: 'win32', arch: 'x64', nodeVersion: '24.20.0', version: '0.1.0-alpha.0',
    sourceRevision: {commit: '1'.repeat(40), dirty: false, sourceSha256: '2'.repeat(64)},
    components: Object.fromEntries(Object.entries(PACKAGED_COMPONENT_PATHS).map(([id, name]) => [id, files.get(name)!])), files: [...files.values()]};
  const save = () => {const file = path.join(root, ...PACKAGE_MANIFEST_PATH.split('/')); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(manifest));};
  save(); return {root, files, manifest, save, write};
}

test('source and packaged layouts are explicit; an install manifest never selects the mode', () => {
  const root = fixture().root, storageRoot = path.join(root, 'synthetic-profile');
  assert.equal(createRuntimePaths({installationRoot: root, storageRoot}).mode, 'source');
  assert.equal(createRuntimePaths({installationRoot: root, storageRoot, mode: 'packaged'}).mode, 'packaged');
});
test('static packaged inventory verifies tiny synthetic files without claiming SDK or user readiness', () => {
  const f = fixture(), loaded = loadPackagedDistribution(f.root);
  assert.equal(loaded.manifest.files.length, f.files.size); assert.equal(loaded.manifest.version, f.manifest.version);
  assert.equal(packagedAsset(loaded, 'windowsFs').path, path.join(f.root, PACKAGED_COMPONENT_PATHS.windowsFs));
  assert.throws(() => packagedAsset(loaded, 'node'), /PACKAGED_RUNTIME_INVALID/);
  assert.equal(Object.hasOwn(loaded.manifest, 'dataRoot'), false); assert.equal(Object.hasOwn(loaded.manifest, 'build'), false);
});
test('a package can move to a different install path without importing old-machine readiness', () => {
  const f = fixture(), moved = path.join(parent, 'moved-' + path.basename(f.root)); fs.cpSync(f.root, moved, {recursive: true});
  assert.equal(loadPackagedDistribution(moved).components.guardian.path, path.join(moved, PACKAGED_COMPONENT_PATHS.guardian));
});
test('the package schema refuses old source roots/proofs, escaping components and prototype identifiers', () => {
  const f = fixture();
  assert.throws(() => packageManifestDocument({...f.manifest, dataRoot: 'old-machine'}));
  assert.throws(() => packageManifestDocument({...f.manifest, schemaVersion: 'aaw.desktop-runtime/v1'}));
  assert.throws(() => packageManifestDocument({...f.manifest, components: {...f.manifest.components, constructor: f.manifest.components.node}}));
  assert.throws(() => packageManifestDocument({...f.manifest, components: {...f.manifest.components, node: {...f.manifest.components.node, path: '../node.exe'}}}));
  for (const name of ['.local/runtime/runtime-manifest.json', '.local/runtime/work-proof.json', 'apps/source.ts', 'node_modules/extra/index.js']) {
    assert.throws(() => packageManifestDocument({...f.manifest, files: [...f.manifest.files, {path: name, bytes: 1, sha256: '0'.repeat(64)}]}));
  }
});
test('exact inventory rejects changed bytes, additional files and case collisions', () => {
  const changed = fixture(); fs.appendFileSync(path.join(changed.root, PACKAGED_COMPONENT_PATHS.windowsFs), 'changed');
  assert.throws(() => loadPackagedDistribution(changed.root));
  const extra = fixture(); extra.write('unexpected.txt', 'not inventoried'); assert.throws(() => loadPackagedDistribution(extra.root, {exactInventory: true}));
  assert.deepEqual(loadPackagedDistribution(extra.root).inventory.extraPaths, ['unexpected.txt']);
  const collision = fixture(); assert.throws(() => packageManifestDocument({...collision.manifest,
    files: [...collision.manifest.files, {...collision.manifest.files[0]!, path: collision.manifest.files[0]!.path.toUpperCase()}]}));
});
test('package reads reject linked assets and linked ancestors without following them', () => {
  const f = fixture(), asset = path.join(f.root, PACKAGED_COMPONENT_PATHS.windowsFs);
  fs.linkSync(asset, path.join(f.root, 'linked.node')); assert.throws(() => loadPackagedDistribution(f.root));
  const alias = path.join(parent, 'alias-' + path.basename(f.root)); fs.symlinkSync(f.root, alias, 'junction');
  assert.throws(() => loadPackagedDistribution(alias));
});
