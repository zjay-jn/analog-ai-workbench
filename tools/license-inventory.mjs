import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arguments_ = process.argv.slice(2);
if (arguments_.some(value => value !== '--check') || arguments_.length > 1) throw Error('Usage: node tools/license-inventory.mjs [--check]');
const raw = readFileSync(resolve(root, 'package-lock.json'));
const lock = JSON.parse(raw);
const entries = Object.entries(lock.packages ?? {}).filter(([location]) => location !== '').map(([location, item]) => ({
  location,
  name: item.name ?? location.split('node_modules/').at(-1),
  version: item.version ?? null,
  license: item.license ?? 'UNKNOWN',
  development: item.dev === true,
  optional: item.optional === true,
  integrity: item.integrity ?? null,
})).sort((a, b) => a.location.localeCompare(b.location, 'en'));
const inventory = {schemaVersion: 'aaw.lockfile-license-inventory/v1',
  lockfileSha256: createHash('sha256').update(raw).digest('hex'),
  scope: 'npm lockfile metadata only; excludes OpenCode executable contents, Electron runtime contents, private EDA assets and a binary distribution notice audit',
  packageCount: entries.length, unknownLicenseCount: entries.filter(item => item.license === 'UNKNOWN').length, packages: entries};
const directory = existsSync(resolve(root, 'docs/public/README.md')) ? 'docs/public' : 'docs';
const output = resolve(root, directory, 'DEPENDENCY_LICENSES.json');
const text = JSON.stringify(inventory, null, 2) + '\n';
if (arguments_.includes('--check')) {
  if (!existsSync(output) || readFileSync(output, 'utf8') !== text) throw Error('LICENSE_INVENTORY_STALE: run npm run licenses:inventory');
} else writeFileSync(output, text, 'utf8');
console.log(JSON.stringify({status: 'PASS', packages: entries.length, unknownLicenses: inventory.unknownLicenseCount, output: directory + '/DEPENDENCY_LICENSES.json', checkOnly: arguments_.includes('--check')}));
