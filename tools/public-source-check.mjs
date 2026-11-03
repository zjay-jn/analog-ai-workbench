import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 2) throw Error('Public source check accepts no output path');
const parent = path.join(root, '.local/public-source-check');
for (const directory of [path.join(root, '.local'), parent]) {
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) throw Error('Refuse aliased build output');
}
const output = mkdtempSync(path.join(parent, 'build-'));
const dist = path.join(root, 'dist');
function snapshot(directory) {
  if (!existsSync(directory)) return [];
  const rows = [];
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name), stat = lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink()) throw Error('Refuse aliased build evidence');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) rows.push({ path: path.relative(directory, file).replaceAll('\\', '/'), bytes: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
      else throw Error('Unexpected build evidence entry');
    }
  }
  walk(directory);
  return rows;
}
const before = snapshot(dist);
const builds = [
  ['main', 'apps/desktop/vite.main.config.mts'],
  ['preload', 'apps/desktop/vite.preload.config.mts'],
  ['cloud-main', 'apps/desktop/vite.main.cloud.config.mts'],
  ['cloud-preload', 'apps/desktop/vite.preload.cloud.config.mts'],
  ['renderer', 'apps/desktop/vite.config.mts'],
];
let failure = false;
const results = [];
async function bundle(profile, config) {
  await build({ ...config, configFile: false, root: config.root ?? root, build: { ...config.build, outDir: path.join(output, profile) } });
  results.push({ profile, exitCode: 0 });
}
for (const [profile, filename] of builds) {
  try {
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(root, filename));
    if (!loaded) throw Error('Missing source build configuration');
    const config = loaded.config;
    if (profile === 'cloud-preload') {
      // Its production closeBundle hook performs a second Vite build with a
      // fixed dist path, ignoring a CLI --outDir. Replace that exact hook with
      // two explicit standalone bundles, both under this private check output.
      if (config.plugins?.length !== 1 || config.plugins[0]?.name !== 'standalone-session-preload') throw Error('Cloud preload build hook changed');
      const isolated = { ...config, plugins: [] };
      await bundle(profile, isolated);
      await bundle('session-preload', { ...isolated, build: { ...isolated.build, ssr: path.join(root, 'apps/desktop/src/preload/sessions.ts'), rollupOptions: { ...isolated.build.rollupOptions, output: { ...isolated.build.rollupOptions.output, entryFileNames: 'preload/sessions.js' } } } });
    } else await bundle(profile, config);
  } catch (error) {
    console.error(error);
    results.push({ profile, exitCode: 1 });
    failure = true;
    break;
  }
}
const distUnchanged = JSON.stringify(before) === JSON.stringify(snapshot(dist));
const evidence = { schema: 'aaw.public-source-build.v1', scope: 'source-bundling-only; no Electron/native/model/OA execution', results, distUnchanged, outputs: snapshot(output) };
writeFileSync(path.join(output, 'build-check.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ results, distUnchanged, evidence: path.relative(root, path.join(output, 'build-check.json')).replaceAll('\\', '/') }));
if (failure || !distUnchanged) process.exitCode = 1;
