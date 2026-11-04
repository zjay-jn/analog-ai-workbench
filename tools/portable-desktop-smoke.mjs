import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {installedElectron} from './electron-runtime.mjs';
import {mkdir, ordinary, within} from './portable-runtime-lib.mjs';

export const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const artifactRoot = path.join(checkoutRoot, '.local/desktop-smoke');
const privateStores = ['model-settings', 'chat-history', 'chat-drafts', 'project-workspace',
  'project-folders', 'display-paths', 'agent-engine-live', 'agent-project-read', 'agent-work-cycle',
  'agent-project-read-model', 'agent-engine-pilot/conversations'];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function absolute(value) {
  if (!value || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)
      || (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/u.test(value) || value.slice(2).includes(':')))) throw Error('ABSOLUTE_LOCAL_PATH_REQUIRED');
  const result = path.resolve(value);
  if (path.dirname(result) === result) throw Error('DRIVE_ROOT_FORBIDDEN');
  return result;
}

export function parseSmokeOptions(values) {
  const options = new Map();
  for (const value of values) {
    const split = value.indexOf('=');
    const key = value.slice(0, split), input = value.slice(split + 1);
    if (split < 1 || !input || !['--app-root', '--storage-root', '--phase', '--forbidden-root'].includes(key) || options.has(key)) throw Error('SMOKE_ARGUMENT_INVALID');
    options.set(key, input);
  }
  const appRoot = options.has('--app-root') ? absolute(options.get('--app-root')) : checkoutRoot;
  if (appRoot !== checkoutRoot) throw Error('APP_ROOT_MUST_BE_THIS_CHECKOUT');
  const storageRoot = absolute(options.get('--storage-root'));
  const localProfile = storageRoot !== artifactRoot && within(artifactRoot, storageRoot);
  if (!localProfile && !/^aaw-portable-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(path.basename(storageRoot))) throw Error('DEDICATED_SMOKE_STORAGE_REQUIRED');
  if (within(storageRoot, checkoutRoot) || storageRoot === artifactRoot) throw Error('SMOKE_STORAGE_OVERLAPS_INSTALLATION');
  const phase = options.get('--phase') ?? 'both';
  if (!['first', 'cold', 'both'].includes(phase)) throw Error('SMOKE_PHASE_INVALID');
  // A forbidden root is only compared as a path. Do not inspect or read it.
  const forbiddenRoots = options.has('--forbidden-root') ? [absolute(options.get('--forbidden-root'))] : [];
  for (const denied of forbiddenRoots) for (const target of [checkoutRoot, storageRoot, artifactRoot]) {
    if (within(denied, target) || within(target, denied)) throw Error('FORBIDDEN_ROOT_OVERLAPS_TEST');
  }
  return {appRoot, storageRoot, phase, forbiddenRoots};
}

/** Verify existing ancestors without creating or following a profile alias. */
export function assertUnaliased(target) {
  for (let current = path.resolve(target);; current = path.dirname(current)) {
    let stat;
    try {stat = fs.lstatSync(current);} catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase())) throw Error('SMOKE_SCOPE_ALIASED');
    if (path.dirname(current) === current) break;
  }
}

/** Refuse prior settings/history/workspace, including pending files. Never delete it. */
export function assertFirstProfile(storageRoot) {
  assertUnaliased(storageRoot);
  for (const relative of privateStores) {
    const directory = path.join(storageRoot, '.local', relative);
    assertUnaliased(directory);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw Error('FIRST_PROFILE_NOT_EMPTY');
  }
}

function json(file) {
  if (ordinary(file).size > 2 * 1024 * 1024) throw Error('SMOKE_REPORT_TOO_LARGE');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Read and pin the installed addon; this function never loads native code. */
export function smokeAddonPin(installationRoot, storageRoot) {
  const manifestFile = path.join(installationRoot, '.local/runtime/runtime-manifest.json');
  const manifest = json(manifestFile), component = manifest.components?.windowsFs;
  const relative = '.local/runtime/native/windows-fs-native.node';
  if (manifest.schemaVersion !== 'aaw.desktop-runtime/v1' || manifest.platform !== 'win32' || manifest.arch !== 'x64'
      || manifest.dataRoot !== path.join(storageRoot, '.local') || component?.path !== relative
      || !Number.isSafeInteger(component.bytes) || component.bytes <= 0 || component.bytes > 64 * 1024 * 1024
      || !/^[a-f0-9]{64}$/u.test(component.sha256)) throw Error('SMOKE_ADDON_MANIFEST_INVALID');
  const file = path.join(installationRoot, relative);
  if (ordinary(file).size !== component.bytes || digest(file) !== component.sha256) throw Error('SMOKE_ADDON_PIN_MISMATCH');
  return {path: file, bytes: component.bytes, sha256: component.sha256};
}

/** Wait for painting, and retry one transient Viz surface-copy failure only. */
export async function captureSmokePage(window, label, record, {wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), timeoutMs = 4000} = {}) {
  const bounded = async (operation, code) => {
    let timer;
    try {return await Promise.race([operation(), new Promise((_, reject) => {timer = setTimeout(() => reject(Error(code)), timeoutMs);})]);}
    finally {clearTimeout(timer);}
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const observation = {label, attempt, visible: window.isVisible(), minimized: window.isMinimized(), contentSize: window.getContentSize()};
    try {
      if (window.isMinimized()) window.restore();
      window.showInactive();
      window.webContents.setBackgroundThrottling(false);
      observation.frame = await bounded(() => window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({visibility:document.visibilityState,width:innerWidth,height:innerHeight}))))`), 'SCREENSHOT_FRAME_TIMEOUT');
      const image = await bounded(() => window.webContents.capturePage(undefined, {stayHidden: false, stayAwake: true}), 'SCREENSHOT_CAPTURE_TIMEOUT');
      if (image.isEmpty()) throw Error('SCREENSHOT_EMPTY');
      const size = image.getSize(), png = image.toPNG();
      if (size.width <= 0 || size.height <= 0 || !Buffer.isBuffer(png) || png.length <= 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('SCREENSHOT_INVALID');
      record({...observation, status: 'PASS', size, pngBytes: png.length});
      return {png, size};
    } catch (error) {
      record({...observation, status: 'FAIL', error: String(error.message).slice(0, 200)});
      if (error.message !== 'UnknownVizError' || attempt === 2) throw error;
      await wait(300);
    }
  }
  throw Error('SCREENSHOT_UNAVAILABLE');
}

function contract(file, name) {
  ordinary(file);
  const match = fs.readFileSync(file, 'utf8').match(new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`));
  if (!match) throw Error('CONTRACT_VERSION_MISSING');
  return match[1];
}
function coldMarker(options, productionEntrySha256) {
  if (!fs.existsSync(artifactRoot)) throw Error('COLD_PROFILE_NOT_OWNED');
  ordinary(artifactRoot, true);
  for (const name of fs.readdirSync(artifactRoot).filter(value => /^run-[a-f0-9-]{36}$/u.test(value)).reverse()) {
    const directory = path.join(artifactRoot, name); ordinary(directory, true);
    const summaryFile = path.join(directory, 'summary.json'), firstFile = path.join(directory, 'first/result.json');
    if (!fs.existsSync(summaryFile) || !fs.existsSync(firstFile)) continue;
    const summary = json(summaryFile), first = json(firstFile);
    if (summary.schemaVersion === 'aaw.portable-ui-cold-start/v1' && first.schemaVersion === 'aaw.portable-ui-startup/v1'
        && summary.appRoot === checkoutRoot && summary.storageRoot === options.storageRoot
        && summary.productionEntrySha256 === productionEntrySha256
        && summary.results?.some(result => result.phase === 'first' && result.status === 'PASS' && result.normalQuit && result.exitCode === 0)
        && first.status === 'PASS' && first.normalQuit && first.windowClosed && first.addonLoaded && first.exitCode === 0 && first.storageRoot === options.storageRoot
        && first.productionEntry === path.join(checkoutRoot, 'dist/cloud/main/index.js') && first.productionEntrySha256 === productionEntrySha256
        && ['networkAttempts', 'childProcessAttempts', 'forbiddenFilesystemAttempts', 'rendererFailures', 'shutdownFailures'].every(key => Array.isArray(first[key]) && first[key].length === 0)
        && typeof first.persistedMarker === 'string' && /^AAW portable smoke [a-f0-9-]{36}$/u.test(first.persistedMarker)) return first.persistedMarker;
  }
  throw Error('COLD_PROFILE_NOT_OWNED');
}

export function runDesktopSmoke(values = process.argv.slice(2)) {
  const options = parseSmokeOptions(values);
  for (const directory of [checkoutRoot, artifactRoot, options.storageRoot]) assertUnaliased(directory);
  // Check reuse before locating Electron or creating any test output.
  if (options.phase !== 'cold') assertFirstProfile(options.storageRoot);
  const productionEntry = path.join(checkoutRoot, 'dist/cloud/main/index.js');
  ordinary(productionEntry);
  const productionEntrySha256 = digest(productionEntry), electron = installedElectron(checkoutRoot);
  const windowsFs = smokeAddonPin(checkoutRoot, options.storageRoot);
  const marker = options.phase === 'cold' ? coldMarker(options, productionEntrySha256) : `AAW portable smoke ${randomUUID()}`;
  const settingsVersion = contract(path.join(checkoutRoot, 'apps/desktop/src/shared/agent/model-settings.ts'), 'SETTINGS_VERSION');
  const workspaceVersion = contract(path.join(checkoutRoot, 'apps/desktop/src/shared/agent/project-workspace.ts'), 'WORKSPACE_VERSION');
  mkdir(artifactRoot);
  const output = path.join(artifactRoot, `run-${randomUUID()}`); fs.mkdirSync(output);
  const results = [];
  for (const phase of options.phase === 'both' ? ['first', 'cold'] : [options.phase]) {
    if (phase === 'first') assertFirstProfile(options.storageRoot);
    const folder = path.join(output, phase); fs.mkdirSync(folder);
    const plan = {...options, phase, productionEntry, productionEntrySha256, windowsFs, profileRoot: path.join(options.storageRoot, '.local/cloud-user-data'),
      output: folder, settingsVersion, workspaceVersion, marker};
    const planFile = path.join(folder, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'});
    const environment = {...process.env};
    for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'NODE_OPTIONS', 'NODE_PATH']) delete environment[name];
    const result = spawnSync(electron, [path.join(checkoutRoot, 'tools/portable-desktop-smoke-main.cjs'), planFile],
      {cwd: checkoutRoot, env: environment, shell: false, windowsHide: true, encoding: 'utf8', timeout: 65000, maxBuffer: 1024 * 1024});
    fs.writeFileSync(path.join(folder, 'stdout.log'), result.stdout ?? ''); fs.writeFileSync(path.join(folder, 'stderr.log'), result.stderr ?? '');
    let report;
    try {report = json(path.join(folder, 'result.json'));} catch {report = null;}
    const boundariesClear = report && ['networkAttempts', 'childProcessAttempts', 'forbiddenFilesystemAttempts', 'rendererFailures', 'shutdownFailures'].every(key => Array.isArray(report[key]) && report[key].length === 0);
    results.push({phase, exitCode: result.status, errorCode: result.error?.code ?? null, status: report?.status ?? 'NO_REPORT',
      normalQuit: report?.normalQuit ?? false, windowClosed: report?.windowClosed ?? false, reportedExitCode: report?.exitCode ?? null,
      addonLoaded: report?.addonLoaded === true, boundariesClear: Boolean(boundariesClear), folder: path.relative(checkoutRoot, folder),
      screenshots: ['workbench.png', ...(phase === 'first' ? ['synthetic.png'] : [])].filter(name => fs.existsSync(path.join(folder, name))).map(name => {
        const file = path.join(folder, name); return {path: path.relative(checkoutRoot, file), bytes: ordinary(file).size, sha256: digest(file)};
      })});
    if (result.status !== 0 || result.error || report?.status !== 'PASS' || !report.normalQuit || !report.windowClosed || !report.addonLoaded || report.exitCode !== 0 || !boundariesClear) break;
  }
  const summary = {schemaVersion: 'aaw.portable-ui-cold-start/v1', status: results.length === (options.phase === 'both' ? 2 : 1)
      && results.every(result => result.exitCode === 0 && result.reportedExitCode === 0 && result.status === 'PASS' && result.normalQuit && result.windowClosed && result.addonLoaded
        && result.boundariesClear && result.screenshots.length === (result.phase === 'first' ? 2 : 1) && result.screenshots.every(screenshot => screenshot.bytes > 0)) ? 'PASS' : 'FAIL',
    appRoot: checkoutRoot, storageRoot: options.storageRoot, productionEntrySha256, phase: options.phase, results,
    scope: 'A new production Electron process, no configured model keys, synthetic schematic and project persistence. Native filesystem addon loading/export types are checked, without calling its APIs. Main HTTP/fetch, renderer network requests and Node child_process are blocked. Optional forbidden roots are checked without reading them. These guards are not an OS-wide monitor or a model/native-command/WSL test.'};
  const evidence = path.join(output, 'summary.json'); fs.writeFileSync(evidence, JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({...summary, evidence: path.relative(checkoutRoot, evidence)}));
  if (summary.status !== 'PASS') process.exitCode = 1;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {runDesktopSmoke();} catch (error) {console.error(error.message); process.exitCode = 1;}
}
