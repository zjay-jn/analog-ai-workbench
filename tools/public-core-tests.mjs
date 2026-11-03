import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A deliberately bounded suite: this does not assert that private integration
// tests or the complete desktop product work on a clean public installation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = path.join(root, 'tests/tsconfig.public.json');
const { include } = JSON.parse(readFileSync(config, 'utf8'));
const tests = include.filter(file => /^[a-z0-9-]+\.test\.ts$/u.test(file));
if (tests.length !== 11 || process.argv.length !== 2) throw Error('Unexpected public core test configuration');
for (const directory of [path.join(root, '.local'), path.join(root, '.local/public-test-build')]) {
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink() || realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) throw Error('Refuse aliased test output');
}
const output = mkdtempSync(path.join(root, '.local/public-test-build/run-'));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run([path.join(root, 'node_modules/typescript/bin/tsc'), '-p', config, '--outDir', output]);
run(['--test', ...tests.map(file => path.join(output, 'tests', file.replace(/\.ts$/u, '.js')))]);
