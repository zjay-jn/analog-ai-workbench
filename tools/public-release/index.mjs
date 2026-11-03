import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, readdir, readFile, realpath, mkdir, open} from 'node:fs/promises';
import {basename, dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const defaultSourceRoot = resolve(toolDirectory, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.split(sep).join('/');
const within = (parent, child) => { const tail = relative(parent, child); return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)); };
const fail = code => { throw new Error(code); };
const absent = error => error?.code === 'ENOENT';

// Report rule/path/line only. Never include matching text or secret fragments.
const secretRules = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gu],
  ['GITHUB_TOKEN', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu],
  ['MODEL_API_TOKEN', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gu],
  ['NPM_TOKEN', /\bnpm_[A-Za-z0-9]{30,}\b/gu],
  ['NPMRC_AUTH', /^\s*(?:\/\/[^\s=]+:)?(?:_authToken|_auth|password)\s*=\s*(?!\$\{)[^\s#;]{12,}/gimu],
  ['AWS_ACCESS_ID', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ['CREDENTIAL_URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{8,}@/giu],
];

export async function loadPolicy() {
  return JSON.parse(await readFile(join(toolDirectory, 'policy.json'), 'utf8'));
}

function validatePolicy(policy) {
  if (policy?.schemaVersion !== 'aaw.public-source-policy/v1') fail('INVALID_POLICY');
  for (const key of ['rootFiles', 'sourceTrees', 'additionalFiles', 'extensions', 'publicRootDocuments', 'publicAdditionalDocuments', 'deniedSegments', 'deniedExtensions', 'unresolvedRights', 'secretExceptions']) if (!Array.isArray(policy[key])) fail('INVALID_POLICY');
  for (const key of ['maxFileBytes', 'maxTotalBytes']) if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) fail('INVALID_POLICY');
  for (const name of [...policy.rootFiles, ...policy.sourceTrees, ...policy.publicRootDocuments, ...policy.publicAdditionalDocuments]) if (typeof name !== 'string' || !name || /[\\/]/u.test(name) || name === '.' || name === '..') fail('INVALID_POLICY');
  for (const item of policy.unresolvedRights) if (!safeRelative(item.path) || typeof item.rule !== 'string') fail('INVALID_POLICY');
  if (!Array.isArray(policy.resolvedRights ?? [])) fail('INVALID_RESOLVED_RIGHTS');
  for (const item of policy.resolvedRights ?? []) if (!safeRelative(item.path) || item.license !== 'MIT' || !safeRelative(item.permissionRecord)
    || !['root', 'manifest', 'manifest_entries'].includes(item.licenseDeclaration)) fail('INVALID_RESOLVED_RIGHTS');
  if (new Set((policy.resolvedRights ?? []).map(item => item.path.toLowerCase())).size !== (policy.resolvedRights ?? []).length) fail('INVALID_RESOLVED_RIGHTS');
  for (const item of policy.additionalFiles) if (!safeRelative(item)) fail('INVALID_POLICY');
  for (const item of policy.secretExceptions) if (!safeRelative(item.path) || !/^[a-f0-9]{64}$/u.test(item.fileSha256) || !Number.isSafeInteger(item.matches) || item.matches < 1 || !item.reason?.trim() || !item.reviewRef?.trim() || !secretRules.some(([rule]) => rule === item.rule)) fail('INVALID_SECRET_EXCEPTION');
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.includes(':') && value.split('/').every(part => part && part !== '.' && part !== '..');
}

async function assertNoLinkAncestors(target) {
  let current = resolve(target);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('SYMLINK_REFUSED');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function deniedReason(path, policy) {
  const parts = path.toLowerCase().split('/');
  if (parts.some(part => policy.deniedSegments.includes(part))) return 'PRIVATE_OR_GENERATED_PATH';
  const filename = parts.at(-1);
  if (/^\.env(?:\.|$)/u.test(filename) || /^(?:credentials?|secrets?|api[-_]?keys?)(?:\.(?:json|txt|ini|conf|ya?ml))?$/u.test(filename) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(filename)) return 'SENSITIVE_FILENAME';
  if (policy.deniedExtensions.includes(extname(filename))) return 'PRIVATE_OR_BINARY_EXTENSION';
  return null;
}

export async function auditSource({sourceRoot = defaultSourceRoot, policy: suppliedPolicy} = {}) {
  const policy = suppliedPolicy ?? await loadPolicy();
  validatePolicy(policy);
  const source = resolve(sourceRoot);
  await assertNoLinkAncestors(source);
  const canonicalSource = await realpath(source);
  const files = [], blockers = [], exclusions = [], reviewedExceptions = [];
  const destinations = new Set();
  let totalBytes = 0;
  const addBlocker = (path, rule, detail) => blockers.push({path, rule, ...(detail ? {detail} : {})});

  async function admit(sourcePath, destination = sourcePath, required = false) {
    if (!safeRelative(sourcePath) || !safeRelative(destination)) fail('INVALID_POLICY_PATH');
    const denied = deniedReason(sourcePath, policy);
    if (denied) {
      exclusions.push({path: sourcePath, rule: denied});
      if (denied !== 'PRIVATE_OR_GENERATED_PATH') addBlocker(sourcePath, denied);
      return;
    }
    const absolute = resolve(source, sourcePath);
    let stat;
    try { await assertNoLinkAncestors(absolute); stat = await lstat(absolute); }
    catch (error) {
      if (error.message === 'SYMLINK_REFUSED') { addBlocker(sourcePath, 'SYMLINK_REFUSED'); return; }
      if (absent(error)) { if (required) addBlocker(sourcePath, 'REQUIRED_FILE_MISSING'); return; }
      throw error;
    }
    if (stat.isSymbolicLink()) { addBlocker(sourcePath, 'SYMLINK_REFUSED'); return; }
    if (!within(canonicalSource, await realpath(absolute))) { addBlocker(sourcePath, 'SOURCE_OUTSIDE_ROOT'); return; }
    if (required && !stat.isFile()) { addBlocker(sourcePath, 'REQUIRED_FILE_NOT_REGULAR'); return; }
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await admit(`${sourcePath}/${name}`, `${destination}/${name}`);
      return;
    }
    if (!stat.isFile()) { addBlocker(sourcePath, 'SPECIAL_FILE_REFUSED'); return; }
    const extension = sourcePath.split('/').at(-1) === '.gitkeep' ? '.gitkeep' : extname(sourcePath).toLowerCase();
    if (!required && !policy.extensions.includes(extension)) { addBlocker(sourcePath, 'UNREVIEWED_EXTENSION'); return; }
    if (stat.size > policy.maxFileBytes) { addBlocker(sourcePath, 'FILE_TOO_LARGE'); return; }
    totalBytes += stat.size;
    if (totalBytes > policy.maxTotalBytes) { addBlocker(sourcePath, 'SOURCE_TOO_LARGE'); return; }
    const data = await readFile(absolute);
    if (data.includes(0)) { addBlocker(sourcePath, 'BINARY_CONTENT_REFUSED'); return; }
    let text;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(data); }
    catch { addBlocker(sourcePath, 'NON_UTF8_CONTENT'); return; }
    const digest = hash(data);
    const destinationKey = destination.toLowerCase();
    if (destinations.has(destinationKey) || destinationKey === 'public_source_manifest.json') { addBlocker(sourcePath, 'DESTINATION_COLLISION'); return; }
    destinations.add(destinationKey);
    files.push({source: sourcePath, destination, bytes: data.length, sha256: digest});
    for (const grant of policy.resolvedRights ?? []) if (grant.path === sourcePath && grant.licenseDeclaration !== 'root') {
      let declaration;
      try { declaration = JSON.parse(text); } catch { addBlocker(sourcePath, 'LICENSE_DECLARATION_INVALID'); continue; }
      const matches = grant.licenseDeclaration === 'manifest' ? declaration?.license === grant.license
        : Array.isArray(declaration?.entries) && declaration.entries.length > 0 && declaration.entries.every(entry => entry?.license === grant.license);
      if (!matches) addBlocker(sourcePath, 'LICENSE_DECLARATION_MISMATCH');
    }
    for (const [rule, expression] of secretRules) {
      const matches = [...text.matchAll(expression)];
      if (!matches.length) continue;
      const exception = policy.secretExceptions.find(item => item.path === sourcePath && item.rule === rule && item.fileSha256 === digest && item.matches === matches.length);
      if (exception) { reviewedExceptions.push({path: sourcePath, rule, fileSha256: digest, matches: matches.length, reviewRefSha256: hash(exception.reviewRef)}); continue; }
      for (const match of matches) addBlocker(sourcePath, rule, {line: text.slice(0, match.index).split('\n').length});
    }
    for (const restriction of policy.unresolvedRights) if (restriction.path === sourcePath) addBlocker(sourcePath, restriction.rule, restriction.basis);
  }

  for (const path of policy.rootFiles) await admit(path, path, true);
  for (const path of policy.additionalFiles) await admit(path, path, true);
  for (const path of policy.sourceTrees) await admit(path);
  for (const name of policy.publicRootDocuments) {
    await admit(`docs/public/${name}`, name, true);
    await admit(`docs/public/${name}`, `docs/public/${name}`, true);
  }
  for (const name of policy.publicAdditionalDocuments) {
    await admit(`docs/public/${name}`, `docs/${name}`, true);
    await admit(`docs/public/${name}`, `docs/public/${name}`, true);
  }
  for (const grant of policy.resolvedRights ?? []) if (files.some(file => file.source === grant.path)
    && !files.some(file => file.source === grant.permissionRecord)) addBlocker(grant.path, 'PERMISSION_RECORD_NOT_INCLUDED');
  // Excluded top-level directories are named without opening their contents.
  const selected = new Set([...policy.rootFiles, ...policy.sourceTrees, ...policy.additionalFiles.map(path => path.split('/')[0]), 'docs']);
  for (const name of (await readdir(source)).sort()) if (!selected.has(name)) exclusions.push({path: name, rule: 'TOP_LEVEL_NOT_ALLOWLISTED'});
  files.sort((a, b) => a.destination.localeCompare(b.destination, 'en'));
  blockers.sort((a, b) => a.path.localeCompare(b.path, 'en') || a.rule.localeCompare(b.rule, 'en'));
  exclusions.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const policySha256 = hash(JSON.stringify(policy));
  const plan = {schemaVersion: 'aaw.public-source-plan/v1', policySha256, files, blockers, reviewedExceptions};
  return {...plan, status: blockers.length ? 'BLOCKED' : 'READY_FOR_EXPORT', planSha256: hash(JSON.stringify(plan)), fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), exclusions, scanCoverage: 'Allowlisted UTF-8 files only; heuristic credential patterns, not a guarantee of absence. Excluded private directories are not read.'};
}

export async function exportSource({sourceRoot = defaultSourceRoot, destination, expectedPlanSha256, policy} = {}) {
  if (!/^[a-f0-9]{64}$/u.test(expectedPlanSha256 ?? '')) fail('PLAN_SHA256_REQUIRED');
  if (!destination || !isAbsolute(destination)) fail('ABSOLUTE_DESTINATION_REQUIRED');
  const source = resolve(sourceRoot), target = resolve(destination);
  if (within(source, target)) fail('DESTINATION_INSIDE_SOURCE');
  if (within(target, source)) fail('DESTINATION_CONTAINS_SOURCE');
  await assertNoLinkAncestors(dirname(target));
  const canonicalSource = await realpath(source);
  const canonicalTarget = join(await realpath(dirname(target)), basename(target));
  if (within(canonicalSource, canonicalTarget)) fail('DESTINATION_INSIDE_SOURCE');
  if (within(canonicalTarget, canonicalSource)) fail('DESTINATION_CONTAINS_SOURCE');
  try { await lstat(target); fail('DESTINATION_EXISTS'); } catch (error) { if (!absent(error)) throw error; }
  const audit = await auditSource({sourceRoot: source, policy});
  if (audit.planSha256 !== expectedPlanSha256) fail('PLAN_CHANGED');
  if (audit.blockers.length) fail('EXPORT_BLOCKED');
  // Re-read and bind every byte before creating a destination. No dependency, model,
  // shell, WSL, Git or network operations occur in this tool.
  const contents = [];
  for (const file of audit.files) {
    const path = resolve(source, file.source);
    await assertNoLinkAncestors(path);
    const bytes = await readFile(path);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('SOURCE_CHANGED');
    contents.push(bytes);
  }
  await mkdir(target); // Exclusive: must not preexist; never delete or overwrite.
  for (let index = 0; index < audit.files.length; index++) {
    const file = audit.files[index], output = resolve(target, file.destination);
    if (!within(target, output)) fail('DESTINATION_ESCAPE');
    await mkdir(dirname(output), {recursive: true});
    await assertNoLinkAncestors(dirname(output));
    const handle = await open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    try { await handle.writeFile(contents[index]); } finally { await handle.close(); }
    if (hash(await readFile(output)) !== file.sha256) fail('COPY_VERIFICATION_FAILED');
  }
  const manifest = {schemaVersion: 'aaw.public-source-export/v1', policySha256: audit.policySha256, planSha256: audit.planSha256, files: audit.files, reviewedExceptions: audit.reviewedExceptions};
  const receipt = await open(join(target, 'PUBLIC_SOURCE_MANIFEST.json'), 'wx', 0o644);
  try { await receipt.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); } finally { await receipt.close(); }
  return {status: 'EXPORTED', destination: target, planSha256: audit.planSha256, fileCount: audit.fileCount, totalBytes: audit.totalBytes};
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'plan', ...rest] = args;
  if (!['plan', 'audit', 'export'].includes(command)) fail('COMMAND_MUST_BE_PLAN_AUDIT_OR_EXPORT');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!['--source', '--destination', '--plan-sha256'].includes(key) || !value || value.startsWith('--') || options[key]) fail('INVALID_ARGUMENTS');
    options[key] = value;
  }
  if (command !== 'export' && (options['--destination'] || options['--plan-sha256'])) fail('EXPORT_ARGUMENTS_WITHOUT_EXPORT');
  const sourceRoot = options['--source'] ?? defaultSourceRoot;
  const result = command === 'export'
    ? await exportSource({sourceRoot, destination: options['--destination'], expectedPlanSha256: options['--plan-sha256']})
    : await auditSource({sourceRoot});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'audit' && result.blockers.length) process.exitCode = 1;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    // Error messages from fs may contain local paths; only publish fixed codes.
    const code = /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'PUBLIC_SOURCE_OPERATION_FAILED';
    process.stderr.write(`${JSON.stringify({status: 'FAILED', code})}\n`);
    process.exitCode = 1;
  }
}
