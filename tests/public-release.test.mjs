import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, symlink, writeFile, lstat} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {auditSource, exportSource, loadPolicy} from '../tools/public-release/index.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = join(root, '.local', 'public-release-tests');
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  await mkdir(temporaryRoot, {recursive: true});
  const sandbox = await mkdtemp(join(temporaryRoot, 'case-'));
  const source = join(sandbox, 'source');
  await mkdir(source);
  const policy = await loadPolicy();
  for (const name of policy.rootFiles) await writeFile(join(source, name), name === 'package.json' ? '{"name":"synthetic-public-source","private":true}' : 'synthetic\n');
  for (const name of policy.additionalFiles) { await mkdir(dirname(join(source, name)), {recursive: true}); await writeFile(join(source, name), 'synthetic\n'); }
  await mkdir(join(source, 'docs', 'public'), {recursive: true});
  for (const name of policy.publicRootDocuments) await writeFile(join(source, 'docs', 'public', name), `public ${name}\n`);
  for (const name of policy.publicAdditionalDocuments) await writeFile(join(source, 'docs', 'public', name), `public ${name}\n`);
  await mkdir(join(source, 'apps'));
  await writeFile(join(source, 'apps', 'sample.ts'), 'export const message = "synthetic";\n');
  return {sandbox, source, policy, target: join(sandbox, 'export')};
}

test('public source plan uses document overrides, hashes files and never reads private state', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'README.md'), 'private history');
  await writeFile(join(f.source, 'AGENTS.md'), 'private history');
  await mkdir(join(f.source, '.local'));
  await writeFile(join(f.source, '.local', 'secrets.json'), '{"private":true}');
  await mkdir(join(f.source, 'docs', 'internal'));
  await writeFile(join(f.source, 'docs', 'internal', 'history.md'), 'private');
  const audit = await auditSource({sourceRoot: f.source, policy: f.policy});
  assert.equal(audit.status, 'READY_FOR_EXPORT');
  assert.equal(audit.files.find(file => file.destination === 'README.md').source, 'docs/public/README.md');
  assert.equal(audit.files.find(file => file.destination === 'docs/public/README.md').source, 'docs/public/README.md');
  assert.equal(audit.files.find(file => file.destination === 'apps/sample.ts').sha256, sha('export const message = "synthetic";\n'));
  assert(!audit.files.some(file => /\.local|internal/.test(file.source)));
  assert.equal((await auditSource({sourceRoot: f.source, policy: f.policy})).planSha256, audit.planSha256);
  await assert.rejects(lstat(f.target), {code: 'ENOENT'});
});

test('unresolved public grants refuse export before creating its destination', async t => {
  const f = await fixture(t);
  const restricted = 'packages/synthetic-rights-block.ts';
  const policy = {...f.policy, unresolvedRights: [{path: restricted, rule: 'LAB_PUBLIC_GRANT_UNRESOLVED', basis: 'Synthetic unresolved grant used only for this boundary test.'}]};
  await mkdir(resolve(f.source, restricted, '..'), {recursive: true});
  await writeFile(join(f.source, restricted), '// synthetic stand-in for a rights-blocked file\n');
  const audit = await auditSource({sourceRoot: f.source, policy});
  assert(audit.blockers.some(item => item.rule === 'LAB_PUBLIC_GRANT_UNRESOLVED'));
  await assert.rejects(exportSource({sourceRoot: f.source, destination: f.target, expectedPlanSha256: audit.planSha256, policy}), /EXPORT_BLOCKED/);
  await assert.rejects(lstat(f.target), {code: 'ENOENT'});
});

test('cleared source rights require the recorded grant and matching manifest declarations', async t => {
  const f = await fixture(t);
  const granted = 'packages/synthetic-grant.manifest.json';
  await mkdir(join(f.source, 'packages'));
  await writeFile(join(f.source, granted), JSON.stringify({license: 'MIT'}));
  const grant = {path: granted, license: 'MIT', licenseDeclaration: 'manifest', permissionRecord: 'docs/public/SOURCE_PERMISSIONS.md'};
  const policy = {...f.policy, resolvedRights: [grant]};
  const ready = await auditSource({sourceRoot: f.source, policy});
  assert.equal(ready.status, 'READY_FOR_EXPORT');
  await assert.rejects(auditSource({sourceRoot: f.source, policy: {...policy, resolvedRights: [grant, grant]}}), /INVALID_RESOLVED_RIGHTS/);
  const missingRecord = {...policy, resolvedRights: [{...grant, permissionRecord: 'docs/private-not-in-export.md'}]};
  const missing = await auditSource({sourceRoot: f.source, policy: missingRecord});
  assert(missing.blockers.some(item => item.rule === 'PERMISSION_RECORD_NOT_INCLUDED'));
  await assert.rejects(exportSource({sourceRoot: f.source, destination: f.target, expectedPlanSha256: missing.planSha256, policy: missingRecord}), /EXPORT_BLOCKED/);
  await writeFile(join(f.source, granted), JSON.stringify({license: 'UNLICENSED'}));
  assert((await auditSource({sourceRoot: f.source, policy})).blockers.some(item => item.rule === 'LICENSE_DECLARATION_MISMATCH'));
  const entriesPolicy = {...policy, resolvedRights: [{...grant, licenseDeclaration: 'manifest_entries'}]};
  await writeFile(join(f.source, granted), JSON.stringify({entries: [{license: 'MIT'}, {license: 'UNLICENSED'}]}));
  assert((await auditSource({sourceRoot: f.source, policy: entriesPolicy})).blockers.some(item => item.rule === 'LICENSE_DECLARATION_MISMATCH'));
  await writeFile(join(f.source, granted), JSON.stringify({entries: [{license: 'MIT'}, {license: 'MIT'}]}));
  assert.equal((await auditSource({sourceRoot: f.source, policy: entriesPolicy})).status, 'READY_FOR_EXPORT');
  await assert.rejects(lstat(f.target), {code: 'ENOENT'});
});

test('secret findings in tests are blocked and output never contains the credential', async t => {
  const f = await fixture(t);
  const token = ['ghp', '_', 'x'.repeat(36)].join('');
  await mkdir(join(f.source, 'tests'));
  await writeFile(join(f.source, 'tests', 'sample.test.ts'), `const example = '${token}';\n`);
  const audit = await auditSource({sourceRoot: f.source, policy: f.policy});
  assert(audit.blockers.some(item => item.path === 'tests/sample.test.ts' && item.rule === 'GITHUB_TOKEN'));
  assert(!JSON.stringify(audit).includes(token));
  const exception = {path: 'tests/sample.test.ts', rule: 'GITHUB_TOKEN', fileSha256: sha(`const example = '${token}';\n`), matches: 1, reason: `Synthetic generated test value ${token}`, reviewRef: `synthetic-independent-review-${token}`};
  const approvedPolicy = {...f.policy, secretExceptions: [exception]};
  const reviewed = await auditSource({sourceRoot: f.source, policy: approvedPolicy});
  assert.equal(reviewed.blockers.length, 0);
  assert(!JSON.stringify(reviewed).includes(token));
  await writeFile(join(f.source, 'tests', 'sample.test.ts'), `const example = '${token}';\n// changed\n`);
  assert((await auditSource({sourceRoot: f.source, policy: approvedPolicy})).blockers.some(item => item.rule === 'GITHUB_TOKEN'));
});

test('source drift, missing approval docs and unknown files block exports', async t => {
  const f = await fixture(t);
  const first = await auditSource({sourceRoot: f.source, policy: f.policy});
  await writeFile(join(f.source, 'apps', 'sample.ts'), 'changed\n');
  await assert.rejects(exportSource({sourceRoot: f.source, destination: f.target, expectedPlanSha256: first.planSha256, policy: f.policy}), /PLAN_CHANGED/);
  await writeFile(join(f.source, 'apps', 'unexpected.dat'), 'unreviewed');
  assert((await auditSource({sourceRoot: f.source, policy: f.policy})).blockers.some(item => item.rule === 'UNREVIEWED_EXTENSION'));
  const missing = await fixture(t);
  const {unlink} = await import('node:fs/promises');
  await unlink(join(missing.source, 'docs', 'public', 'SECURITY.md'));
  assert((await auditSource({sourceRoot: missing.source, policy: missing.policy})).blockers.some(item => item.rule === 'REQUIRED_FILE_MISSING'));
  const malformed = await fixture(t);
  await unlink(join(malformed.source, 'docs', 'public', 'SECURITY.md'));
  await mkdir(join(malformed.source, 'docs', 'public', 'SECURITY.md'));
  assert((await auditSource({sourceRoot: malformed.source, policy: malformed.policy})).blockers.some(item => item.rule === 'REQUIRED_FILE_NOT_REGULAR'));
  const missingAdditional = await fixture(t);
  const requiredAdditional = missingAdditional.policy.publicAdditionalDocuments[0];
  await unlink(join(missingAdditional.source, 'docs', 'public', requiredAdditional));
  const missingAudit = await auditSource({sourceRoot: missingAdditional.source, policy: missingAdditional.policy});
  assert(missingAudit.blockers.some(item => item.path === `docs/public/${requiredAdditional}` && item.rule === 'REQUIRED_FILE_MISSING'));
  await assert.rejects(exportSource({sourceRoot: missingAdditional.source, destination: missingAdditional.target, expectedPlanSha256: missingAudit.planSha256, policy: missingAdditional.policy}), /EXPORT_BLOCKED/);
  await assert.rejects(lstat(missingAdditional.target), {code: 'ENOENT'});
});

test('source credential code is included while payloads in selected source trees are excluded and block export', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'apps', '.gitkeep'), '');
  await writeFile(join(f.source, 'apps', 'credential-store.ts'), 'export const test = true;\n');
  await writeFile(join(f.source, 'apps', 'credentials.json'), '{"private":true}');
  const audit = await auditSource({sourceRoot: f.source, policy: f.policy});
  assert.equal(audit.status, 'BLOCKED');
  assert(audit.files.some(file => file.source === 'apps/credential-store.ts'));
  assert(audit.files.some(file => file.source === 'apps/.gitkeep'));
  assert(!audit.files.some(file => file.source === 'apps/credentials.json'));
  assert(audit.exclusions.some(item => item.path === 'apps/credentials.json' && item.rule === 'SENSITIVE_FILENAME'));
  assert(audit.blockers.some(item => item.path === 'apps/credentials.json' && item.rule === 'SENSITIVE_FILENAME'));
});

test('export requires a new external destination and exact plan then verifies copied bytes', async t => {
  const f = await fixture(t);
  const audit = await auditSource({sourceRoot: f.source, policy: f.policy});
  await assert.rejects(exportSource({sourceRoot: f.source, destination: f.target, policy: f.policy}), /PLAN_SHA256_REQUIRED/);
  await assert.rejects(exportSource({sourceRoot: f.source, destination: join(f.source, 'nested'), expectedPlanSha256: audit.planSha256, policy: f.policy}), /DESTINATION_INSIDE_SOURCE/);
  const result = await exportSource({sourceRoot: f.source, destination: f.target, expectedPlanSha256: audit.planSha256, policy: f.policy});
  assert.equal(result.status, 'EXPORTED');
  for (const file of audit.files) assert.equal(sha(await readFile(join(f.target, file.destination))), file.sha256);
  assert.equal((JSON.parse(await readFile(join(f.target, 'PUBLIC_SOURCE_MANIFEST.json'), 'utf8'))).planSha256, audit.planSha256);
  const roundtrip = await auditSource({sourceRoot: f.target, policy: f.policy});
  assert.equal(roundtrip.status, 'READY_FOR_EXPORT');
  assert.equal(roundtrip.planSha256, audit.planSha256);
  await assert.rejects(exportSource({sourceRoot: f.source, destination: f.target, expectedPlanSha256: audit.planSha256, policy: f.policy}), /DESTINATION_EXISTS/);
});

test('symlinked source content and destination parents are refused without traversal', async t => {
  const f = await fixture(t);
  const outside = join(f.sandbox, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.ts'), 'outside data');
  try { await symlink(outside, join(f.source, 'apps', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('OS does not permit synthetic symlinks'); return; } throw error; }
  const audit = await auditSource({sourceRoot: f.source, policy: f.policy});
  assert(audit.blockers.some(item => item.rule === 'SYMLINK_REFUSED' && item.path === 'apps/linked'));
  assert(!audit.files.some(item => item.source.includes('secret.ts')));
  const templateLink = await fixture(t);
  const {unlink} = await import('node:fs/promises');
  for (const name of [...templateLink.policy.publicRootDocuments, ...templateLink.policy.publicAdditionalDocuments]) await unlink(join(templateLink.source, 'docs', 'public', name));
  const {rmdir} = await import('node:fs/promises');
  await rmdir(join(templateLink.source, 'docs', 'public'));
  await mkdir(join(templateLink.source, 'public-doc-target'));
  for (const name of templateLink.policy.publicRootDocuments) await writeFile(join(templateLink.source, 'public-doc-target', name), 'not reached');
  await symlink(join(templateLink.source, 'public-doc-target'), join(templateLink.source, 'docs', 'public'), process.platform === 'win32' ? 'junction' : 'dir');
  const linkedAudit = await auditSource({sourceRoot: templateLink.source, policy: templateLink.policy});
  assert(linkedAudit.blockers.some(item => item.rule === 'SYMLINK_REFUSED' && item.path === 'docs/public/README.md'));
  assert(!linkedAudit.files.some(item => item.destination === 'README.md'));
  const clean = await fixture(t);
  await symlink(outside, join(clean.sandbox, 'linked-parent'), process.platform === 'win32' ? 'junction' : 'dir');
  const cleanAudit = await auditSource({sourceRoot: clean.source, policy: clean.policy});
  await assert.rejects(exportSource({sourceRoot: clean.source, destination: join(clean.sandbox, 'linked-parent', 'target'), expectedPlanSha256: cleanAudit.planSha256, policy: clean.policy}), /SYMLINK_REFUSED/);
});
