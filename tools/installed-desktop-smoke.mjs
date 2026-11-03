import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash, randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ordinary, mkdir, within} from './portable-runtime-lib.mjs';
import {assertFirstProfile, assertUnaliased} from './portable-desktop-smoke.mjs';

export const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const installedSmokeEvidenceRoot = path.join(checkoutRoot, '.local/installed-ui-smoke/evidence');
const ownershipRoot = path.join(checkoutRoot, '.local/installed-ui-smoke/ownership');
const shaPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const addonNames = ['getCapabilities', 'openValidatedRoot', 'inspectRelative', 'readVerifiedText', 'replaceVerifiedText', 'reconcileVerifiedText', 'closeRoot'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function localAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/u.test(value)
    || (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/u.test(value) || value.slice(2).includes(':')))) throw Error('ABSOLUTE_LOCAL_PATH_REQUIRED');
  const result = path.resolve(value);
  if (path.dirname(result) === result) throw Error('DRIVE_ROOT_FORBIDDEN');
  return result;
}

/** Parse only explicit installed-executable arguments; importing this module performs no I/O. */
export function parseInstalledSmokeOptions(values) {
  const options = new Map();
  for (const value of values) {
    const split = value.indexOf('='), key = value.slice(0, split), input = value.slice(split + 1);
    if (split < 1 || !input || !['--exe', '--exe-sha256', '--phase'].includes(key) || options.has(key)) throw Error('INSTALLED_SMOKE_ARGUMENT_INVALID');
    options.set(key, input);
  }
  const exe = localAbsolute(options.get('--exe')), expectedExeSha = options.get('--exe-sha256'), phase = options.get('--phase') ?? 'both';
  if (path.basename(exe) !== 'AnalogAIWorkbench.exe' || !shaPattern.test(expectedExeSha ?? '')) throw Error('EXPLICIT_INSTALLED_EXE_PIN_REQUIRED');
  if (!['first', 'cold', 'both'].includes(phase)) throw Error('INSTALLED_SMOKE_PHASE_INVALID');
  return {exe, expectedExeSha, phase};
}

/** Do not pass SDK paths, model tokens, preload switches, or host Node configuration to the app. */
export function installedSmokeEnvironment(nativeProfile, inherited = process.env, temporary) {
  const systemRoot = localAbsolute(nativeProfile.profile.systemRoot), system32 = path.join(systemRoot, 'System32');
  const environment = {};
  const allowed = ['USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE'];
  for (const name of allowed) {
    const pair = Object.entries(inherited).find(([key]) => key.toUpperCase() === name);
    if (pair && typeof pair[1] === 'string' && !pair[1].includes('\0')) environment[name] = pair[1];
  }
  Object.assign(environment, {SystemRoot: systemRoot, windir: systemRoot, SystemDrive: path.parse(systemRoot).root.slice(0, 2),
    ComSpec: path.join(system32, 'cmd.exe'), PATH: system32, APPDATA: path.dirname(nativeProfile.profile.storageRoot)});
  if (temporary) environment.TEMP = environment.TMP = localAbsolute(temporary);
  return environment;
}

function read(file, max = 1024 * 1024) {
  const before = ordinary(file);
  if (before.size > max) throw Error('INSTALLED_SMOKE_FILE_LIMIT');
  const bytes = fs.readFileSync(file), after = ordinary(file);
  if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('INSTALLED_SMOKE_FILE_CHANGED');
  return bytes;
}
const json = file => JSON.parse(read(file).toString('utf8'));
function writeJson(file, value) {fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});}
function componentPin(appRoot, manifest, id, relative, limit) {
  const pin = manifest.components?.[id];
  if (pin?.path !== relative || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > limit || !shaPattern.test(pin.sha256 ?? '')) throw Error('INSTALLED_NATIVE_LAYOUT_INVALID');
  const file = path.join(appRoot, relative), bytes = read(file, limit);
  if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw Error('INSTALLED_NATIVE_CHANGED');
  return {path: file, bytes: bytes.length, sha256: pin.sha256};
}

export function validateInstalledProfile(value, appRoot) {
  const profile = value?.profile;
  if (value?.schema !== 'aaw.packaged-native-profile/v1' || !shaPattern.test(value.profileRevision ?? '')
    || profile?.schema !== 'aaw.packaged-command-profile/v1' || profile.policyRevision !== 'aaw.packaged-command-policy/v1'
    || !shaPattern.test(profile.userSidSha256 ?? '') || profile.shellVersion !== '5.1') throw Error('INSTALLED_NATIVE_PROFILE_INVALID');
  for (const name of ['installationRoot', 'runtimeRoot', 'storageRoot', 'dataRoot', 'systemRoot']) localAbsolute(profile[name]);
  if (!samePath(profile.installationRoot, appRoot) || !samePath(profile.runtimeRoot, path.join(appRoot, '.local/runtime'))
    || path.basename(profile.storageRoot) !== 'AnalogAIWorkbench' || !samePath(profile.dataRoot, path.join(profile.storageRoot, '.local'))
    || within(appRoot, profile.storageRoot) || within(profile.storageRoot, appRoot)) throw Error('INSTALLED_NATIVE_ROOT_CHANGED');
  if (!Array.isArray(profile.systemFiles) || profile.systemFiles.length !== 4) throw Error('INSTALLED_NATIVE_PROFILE_INVALID');
  for (const [index, role] of ['shell', 'shellConfig', 'automation', 'clr'].entries()) {
    const file = profile.systemFiles[index];
    if (file?.role !== role || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !shaPattern.test(file.sha256 ?? '')
      || !within(profile.systemRoot, localAbsolute(file.path))) throw Error('INSTALLED_NATIVE_PROFILE_INVALID');
  }
  return value;
}

function bindings(value, context, attemptId, runtime = true) {
  const profile = context.nativeProfile.profile;
  return value?.packageManifestSha256 === context.packageSha && value.profileRevision === context.nativeProfile.profileRevision
    && value.attemptId === attemptId && samePath(value.installationRoot, context.appRoot)
    && samePath(value.storageRoot, profile.storageRoot) && samePath(value.dataRoot, profile.dataRoot)
    && (!runtime || samePath(value.runtimeRoot, profile.runtimeRoot));
}

/** A READY candidate is insufficient without its exact finalized factory commitment. */
export function validateInstalledReady(record, result, factory, context) {
  const attemptId = record?.attemptId;
  if (!uuidPattern.test(attemptId ?? '') || record.schemaVersion !== 'aaw.packaged-runtime-admission/v1' || record.status !== 'READY'
    || !bindings(record, context, attemptId, false) || JSON.stringify(record.nativeProfile) !== JSON.stringify(context.nativeProfile)) throw Error('PACKAGED_BOOTSTRAP_NOT_READY');
  if (result?.schemaVersion !== 'aaw.packaged-initialization-result/v1' || result.status !== 'READY' || !bindings(result, context, attemptId)
    || factory?.schemaVersion !== 'aaw.packaged-factory-inspection/v1' || factory.status !== 'PASS' || !bindings(factory, context, attemptId)
    || factory.registeredWindowsDrivers !== 1 || factory.commandAvailability !== 'ready'
    || factory.hasRetainedWorkEntries !== false || factory.workAvailable !== true) throw Error('PACKAGED_FINAL_COMMIT_MISSING');
  return {attemptId, profileRevision: record.profileRevision, registeredWindowsDrivers: 1, commandAvailability: 'ready',
    workAvailable: true, hasRetainedWorkEntries: false};
}

function readAttemptPin(context, value, attemptId, name) {
  const relative = `runtime-admission/init-${attemptId}/${name}.json`;
  if (value?.path !== relative || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 512 * 1024 || !shaPattern.test(value.sha256 ?? '')) throw Error('PACKAGED_COMMIT_PIN_INVALID');
  const bytes = read(path.join(context.nativeProfile.profile.dataRoot, relative), 512 * 1024);
  if (bytes.length !== value.bytes || hash(bytes) !== value.sha256) throw Error('PACKAGED_COMMIT_PIN_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}

function currentReady(context) {
  const record = json(path.join(context.nativeProfile.profile.dataRoot, 'runtime-admission/current.json'));
  if (!uuidPattern.test(record.attemptId ?? '')) throw Error('PACKAGED_BOOTSTRAP_NOT_READY');
  const result = json(path.join(context.nativeProfile.profile.dataRoot, 'runtime-admission/init-' + record.attemptId, 'result.json'));
  const factory = readAttemptPin(context, result.factoryInspection, record.attemptId, 'factory-inspection');
  const ready = validateInstalledReady(record, result, factory, context);
  for (const [field, name] of [['workProof', 'work-proof'], ['guardianProof', 'guardian-proof'], ['commandAdmission', 'command-admission']]) {
    const proof = readAttemptPin(context, record[field], record.attemptId, name);
    if (proof.packageManifestSha256 !== context.packageSha || proof.profileRevision !== context.nativeProfile.profileRevision) throw Error('PACKAGED_COMMIT_PIN_INVALID');
    if (field === 'commandAdmission' && (proof.verification?.status !== 'PASS' || proof.verification.eachExecutedOnce !== true
      || JSON.stringify(proof.verification.commands) !== '[0,7]' || proof.verification.executions?.length !== 2)) throw Error('PACKAGED_COMMAND_SELFTEST_MISSING');
  }
  return ready;
}

export function validateInstalledAddon(proof, expectedPin) {
  if (proof?.schemaVersion !== 'aaw.packaged-electron-addon/v1' || proof.status !== 'PASS' || proof.electron !== '43.4.0'
    || !/^24\.18\.\d+$/u.test(proof.node ?? '')
    || !samePath(proof.pin?.path, expectedPin.path) || proof.pin.bytes !== expectedPin.bytes || proof.pin.sha256 !== expectedPin.sha256
    || !Array.isArray(proof.exports) || proof.exports.length !== addonNames.length
    || proof.exports.some((item, index) => item.name !== addonNames[index] || item.type !== 'function')
    || proof.scope !== 'Load and export type checks only; no native filesystem API called.') throw Error('PACKAGED_ELECTRON_ADDON_PROOF_MISSING');
  return {electron: proof.electron, node: proof.node, pin: proof.pin, exports: proof.exports, loadOnly: true};
}

function bootNames(context) {
  const directory = path.join(context.nativeProfile.profile.dataRoot, 'runtime-admission/boots');
  assertUnaliased(directory);
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory);
  if (names.length > 256) throw Error('PACKAGED_BOOT_PROOF_LIMIT');
  return names;
}
export function installedFreshBootName(current, previous) {
  const fresh = current.filter(name => !previous.includes(name));
  if (fresh.length !== 1 || !fresh[0].startsWith('boot-') || !uuidPattern.test(fresh[0].slice(5))) throw Error('PACKAGED_FRESH_ADDON_PROOF_MISSING');
  return fresh[0];
}
function freshAddon(context, previous) {
  const boot = installedFreshBootName(bootNames(context), previous);
  return {...validateInstalledAddon(json(path.join(context.nativeProfile.profile.dataRoot, 'runtime-admission/boots', boot, 'addon-loaded.json')), context.addonPin), boot};
}

export function installedOwnershipKey(context) {
  return hash(JSON.stringify([path.resolve(context.appRoot).toLowerCase(), path.resolve(context.nativeProfile.profile.storageRoot).toLowerCase(), context.nativeProfile.profile.userSidSha256]));
}
export function validateInstalledOwnership(value, context) {
  if (value?.schemaVersion !== 'aaw.installed-desktop-smoke-ownership/v1' || value.status !== 'PASS' || value.normalClose !== true
    || value.key !== installedOwnershipKey(context) || !samePath(value.appRoot, context.appRoot)
    || !samePath(value.storageRoot, context.nativeProfile.profile.storageRoot) || value.userSidSha256 !== context.nativeProfile.profile.userSidSha256
    || value.packageSha !== context.packageSha || value.expectedExeSha !== context.options.expectedExeSha
    || value.profileRevision !== context.nativeProfile.profileRevision || !/^AAW installed smoke [a-f0-9-]{36}$/u.test(value.marker ?? '')
    || !uuidPattern.test(value.runId ?? '')) throw Error('COLD_PROFILE_NOT_OWNED');
  return value.marker;
}

export function installedRendererMatches(value, rendererFile) {
  try {const url = new URL(value); return url.protocol === 'file:' && !url.search && !url.hash && samePath(fileURLToPath(url), rendererFile);} catch {return false;}
}

class CDP {
  constructor(url) {this.pending = new Map(); this.serial = 0; this.ws = new WebSocket(url);}
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.ws.close(); reject(Error('CDP_CONNECT_TIMEOUT'));}, 6000);
      this.ws.addEventListener('open', () => {clearTimeout(timer); resolve();}, {once: true});
      this.ws.addEventListener('error', () => {clearTimeout(timer); reject(Error('CDP_CONNECT_FAILED'));}, {once: true});
    });
    this.ws.addEventListener('message', event => {
      let value; try {value = JSON.parse(String(event.data));} catch {return;}
      if (value.id) {
        const item = this.pending.get(value.id);
        if (item) {this.pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error('CDP_METHOD_FAILED_' + item.method)) : item.resolve(value.result);}
      } else this.onEvent?.(value);
    });
    this.ws.addEventListener('close', () => {for (const item of this.pending.values()) {clearTimeout(item.timer); item.reject(Error('CDP_CLOSED'));} this.pending.clear();});
    return this;
  }
  send(method, params = {}, timeout = 6000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(Error('CDP_TIMEOUT_' + method));}, timeout);
      this.pending.set(id, {resolve, reject, timer, method});
      try {this.ws.send(JSON.stringify({id, method, params}));} catch {clearTimeout(timer); this.pending.delete(id); reject(Error('CDP_CLOSED'));}
    });
  }
  async evaluate(expression) {const response = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}); if (response.exceptionDetails) throw Error('CDP_EVALUATION_FAILED'); return response.result?.value;}
  close() {try {this.ws.close();} catch {}}
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function debuggerSocket(value, port) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(port) || url.username || url.password) throw Error('CDP_ENDPOINT_NOT_OWNED');
  return value;
}
async function capture(cdp, folder, name) {
  await cdp.send('Page.bringToFront');
  const frame = await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({visibility:document.visibilityState,width:innerWidth,height:innerHeight}))))');
  const image = await cdp.send('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false});
  const bytes = Buffer.from(image.data ?? '', 'base64');
  if (bytes.length < 24 || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || frame?.visibility !== 'visible') throw Error('SCREENSHOT_INVALID');
  fs.writeFileSync(path.join(folder, name), bytes, {flag: 'wx'});
  return {name, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), frame};
}

async function launch(context, current, marker, output) {
  const {options, nativeProfile} = context;
  if (current === 'first') assertFirstProfile(nativeProfile.profile.storageRoot);
  const previousBoots = bootNames(context), folder = path.join(output, current); mkdir(folder);
  const temporary = path.join(folder, 'temp'); mkdir(temporary);
  const port = await freePort(), report = {phase: current, status: 'RUNNING', stage: 'launch', executable: options.exe,
    packageSha: context.packageSha, profileRevision: nativeProfile.profileRevision, rendererNetworkAttempts: [], shutdownFailures: [],
    screenshots: [], normalClose: false, entryReplaced: false, storageOverridden: false};
  const child = spawn(options.exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port],
    {cwd: path.dirname(options.exe), env: installedSmokeEnvironment(nativeProfile, process.env, temporary), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let closed = false, code = null, stdout = '', stderr = '', page, browser, gracefulRequested = false, expired = false;
  const shutdownFailures = new Set(), tails = {stdout: '', stderr: ''};
  const observe = (stream, bytes) => {
    const value = bytes.toString(), joined = tails[stream] + value;
    for (const failure of joined.match(/CLOUD_SHUTDOWN_(?:FAILED|TIMEOUT)/gu) ?? []) shutdownFailures.add(failure);
    tails[stream] = joined.slice(-64);
    report[stream + 'Bytes'] = (report[stream + 'Bytes'] ?? 0) + bytes.length;
    return value;
  };
  const exited = new Promise(resolve => {child.once('error', () => {closed = true; resolve();}); child.once('close', value => {closed = true; code = value; resolve();});});
  child.stdout.on('data', bytes => {stdout = (stdout + observe('stdout', bytes)).slice(0, 65536);});
  child.stderr.on('data', bytes => {stderr = (stderr + observe('stderr', bytes)).slice(0, 65536);});
  const timer = setTimeout(() => {expired = true; page?.close(); browser?.close(); try {child.kill();} catch {}}, 360000);
  try {
    report.pid = child.pid; report.stage = 'wait-production-target'; const deadline = Date.now() + 300000; let target;
    while (!closed && Date.now() < deadline && !expired) {
      if (/PACKAGED_(?:INITIALIZER_FAILED|NATIVE_ADDON_LOAD_FAILED|RUNTIME_INVALID|NATIVE_PROFILE_UNAVAILABLE)|CLOUD_BOOTSTRAP_INITIALIZATION/u.test(stderr)) throw Error('PRODUCTION_BOOTSTRAP_FAILED');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(1000), redirect: 'error'});
        const targets = await response.json();
        target = targets.find(item => item.type === 'page' && installedRendererMatches(item.url, context.rendererFile));
        if (target) break;
      } catch {}
      await sleep(150);
    }
    if (!target || closed || expired) throw Error('OWNED_PRODUCTION_WINDOW_UNAVAILABLE');
    page = await new CDP(debuggerSocket(target.webSocketDebuggerUrl, port)).open();
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000), redirect: 'error'})).json();
    browser = await new CDP(debuggerSocket(version.webSocketDebuggerUrl, port)).open();
    page.onEvent = event => {
      if (event.method !== 'Fetch.requestPaused') return;
      let network = true, origin = 'invalid-url';
      try {const url = new URL(event.params.request.url); network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol); origin = url.origin;} catch {}
      if (network) {
        if (report.rendererNetworkAttempts.length < 64) report.rendererNetworkAttempts.push({origin});
        void page.send('Fetch.failRequest', {requestId: event.params.requestId, errorReason: 'BlockedByClient'}).catch(() => {});
      } else void page.send('Fetch.continueRequest', {requestId: event.params.requestId}).catch(() => {});
    };
    await page.send('Fetch.enable', {patterns: [{urlPattern: '*'}]});
    report.stage = 'verify-ui'; let ui;
    for (let attempt = 0; attempt < 60; attempt++) {
      ui = await page.evaluate('({text:document.body.innerText,textarea:!!document.querySelector("textarea"),settings:!!window.workbenchModelSettings,workspace:!!window.workbenchWorkspace,noNode:typeof process==="undefined"&&typeof require==="undefined"})');
      if (ui.textarea && ui.settings && ui.workspace) break; await sleep(100);
    }
    if (!ui?.textarea || !ui.settings || !ui.workspace || !ui.noNode) throw Error('PRODUCTION_UI_NOT_READY');
    report.ui = {textarea: ui.textarea, settings: ui.settings, workspace: ui.workspace, noNode: ui.noNode};
    const settings = await page.evaluate('window.workbenchModelSettings.readSettings({contractVersion:"workbench.model-settings.v1"})');
    if (!settings.ok || settings.value.storage !== 'ready' || settings.value.providers.some(provider => provider.configured)) throw Error('MODEL_SETTINGS_NOT_EMPTY');
    report.settings = {storage: settings.value.storage, providers: settings.value.providers.map(provider => ({provider: provider.provider, configured: provider.configured}))};
    const workspace = await page.evaluate('window.workbenchWorkspace.read({contractVersion:"workbench.workspace.v1"})');
    if (!workspace.ok || workspace.value.projects.length !== 1 || workspace.value.projects[0].sessionIds.length
      || (current === 'cold' ? workspace.value.projects[0].name !== marker || workspace.value.revision < 1 : workspace.value.revision !== 0)) throw Error('WORKSPACE_UNEXPECTED');
    report.workspace = {revision: workspace.value.revision, name: workspace.value.projects[0].name, sessions: 0};
    report.bootstrap = currentReady(context); report.addon = freshAddon(context, previousBoots); report.packagedBootstrapObserved = true;
    report.stage = 'capture-main'; report.screenshots.push(await capture(page, folder, 'workbench.png'));
    if (current === 'first') {
      report.stage = 'open-synthetic';
      if (!await page.evaluate('(()=>{const b=[...document.querySelectorAll(".file-workbench button")].find(n=>n.getAttribute("aria-label")==="打开文档");if(!b||b.disabled)return false;b.click();return true})()')) throw Error('SYNTHETIC_MENU_MISSING');
      await sleep(100);
      if (!await page.evaluate('(()=>{const items=[...document.querySelectorAll("[role=menuitem]")].filter(n=>n.textContent.trim()==="打开合成原理图");if(items.length!==1)return false;items[0].click();return true})()')) throw Error('SYNTHETIC_ITEM_MISSING');
      let schematic;
      for (let attempt = 0; attempt < 80; attempt++) {
        schematic = await page.evaluate('(()=>{const p=document.querySelector("[data-schematic-kind=synthetic]"),svg=p?.querySelector("svg[data-schematic-canvas=true]"),r=svg?.getBoundingClientRect();return {status:p?.dataset.status,graphics:svg?.querySelectorAll("polyline,line,rect,path,circle,polygon,text").length??0,width:r?.width??0,height:r?.height??0}})()');
        if (schematic.status === 'ready' && schematic.graphics >= 4 && schematic.width > 0 && schematic.height > 0) break; await sleep(100);
      }
      if (schematic?.status !== 'ready' || schematic.graphics < 4 || schematic.width <= 0 || schematic.height <= 0) throw Error('SYNTHETIC_NOT_RENDERED');
      report.synthetic = schematic; report.stage = 'capture-synthetic'; report.screenshots.push(await capture(page, folder, 'synthetic.png'));
      report.stage = 'save-synthetic-project';
      const saved = await page.evaluate(`(async()=>{const r=await window.workbenchWorkspace.read({contractVersion:"workbench.workspace.v1"});if(!r.ok)return r;const state=r.value;state.projects[0].name=${JSON.stringify(marker)};return window.workbenchWorkspace.save({contractVersion:"workbench.workspace.v1",expectedRevision:state.revision,state})})()`);
      if (!saved.ok || saved.value.projects[0].name !== marker) throw Error('PROJECT_SAVE_FAILED'); report.persistedMarker = marker;
    } else if (!ui.text.includes(marker)) throw Error('COLD_PROJECT_NOT_VISIBLE');
    if (report.rendererNetworkAttempts.length || expired) throw Error('INSTALLED_SMOKE_BOUNDARY_FAILED');
    report.status = 'PASS';
  } catch (error) {report.status = 'FAIL'; report.error = String(error.message).slice(0, 400);}
  finally {
    report.stageBeforeClose = report.stage;
    if (!closed && browser) {gracefulRequested = true; try {await browser.send('Browser.close', {}, 2000);} catch {}}
    if (!closed && page) {try {await page.evaluate('window.close(); true'); gracefulRequested = true;} catch {}}
    if (!closed) await Promise.race([exited, sleep(12000)]);
    if (!closed) {try {child.kill();} catch {} report.forcedStop = true; await Promise.race([exited, sleep(3000)]);}
    clearTimeout(timer);
    report.exitCode = code; report.normalClose = closed && code === 0 && gracefulRequested && !report.forcedStop && !expired;
    report.shutdownFailures = [...shutdownFailures];
    if (!report.normalClose || report.shutdownFailures.length || report.rendererNetworkAttempts.length) report.status = 'FAIL';
    if (report.status === 'PASS') {
      try {
        report.bootstrapAfterClose = currentReady(context);
        if (report.bootstrapAfterClose.attemptId !== report.bootstrap.attemptId) throw Error('PACKAGED_ATTEMPT_CHANGED');
      } catch {report.status = 'FAIL'; report.error = 'PACKAGED_COMMIT_CHANGED_DURING_CLOSE';}
    }
    page?.close(); browser?.close();
    if (!closed) {child.unref(); child.stdout.destroy(); child.stderr.destroy();}
    fs.writeFileSync(path.join(folder, 'stdout.log'), stdout, {flag: 'wx'}); fs.writeFileSync(path.join(folder, 'stderr.log'), stderr, {flag: 'wx'});
    writeJson(path.join(folder, 'result.json'), report);
  }
  return report;
}

function installedContext(options) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('WINDOWS_X64_REQUIRED');
  if (hash(read(options.exe, 256 * 1024 * 1024)) !== options.expectedExeSha) throw Error('INSTALLED_EXE_CHANGED');
  const appRoot = path.join(path.dirname(options.exe), 'resources/app');
  const manifestBytes = read(path.join(appRoot, '.local/runtime/package-manifest.json')), manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 'aaw.packaged-runtime/v1' || manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.nodeVersion !== '24.20.0') throw Error('INSTALLED_PACKAGE_REQUIRED');
  const commandPin = componentPin(appRoot, manifest, 'commandRunner', '.local/runtime/native/command-runner.exe', 4 * 1024 * 1024);
  const addonPin = componentPin(appRoot, manifest, 'windowsFs', '.local/runtime/native/windows-fs-native.node', 64 * 1024 * 1024);
  const probe = spawnSync(commandPin.path, ['--probe-profile'], {cwd: appRoot, env: {}, shell: false, windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 65536});
  if (probe.status !== 0 || probe.error || probe.stderr.length) throw Error('INSTALLED_NATIVE_PROFILE_UNAVAILABLE');
  const nativeProfile = validateInstalledProfile(JSON.parse(probe.stdout), appRoot);
  const context = {options, appRoot, manifest, packageSha: hash(manifestBytes), commandPin, addonPin, nativeProfile, rendererFile: path.join(appRoot, 'dist/renderer/index.html')};
  assertUnaliased(nativeProfile.profile.storageRoot);
  return context;
}

/** Run one owned invocation, preserving every failed run and every user-store file. */
export async function runInstalledDesktopSmoke(values) {
  const runId = randomUUID(), output = path.join(installedSmokeEvidenceRoot, 'run-' + runId); mkdir(output);
  const summary = {schemaVersion: 'aaw.installed-desktop-smoke/v1', status: 'FAIL', runId, phase: null, exe: null, expectedExeSha: null,
    appRoot: null, packageSha: null, storageRoot: null, marker: null, results: [],
    scope: 'Actual installed executable and untouched packaged production main through loopback CDP; no alternate entry, preload hook, fake engine or storage override. No chat/model command issued. Renderer external requests blocked after CDP attaches; main/OS network is not instrumented. No profile files are cleared.'};
  try {
    const options = parseInstalledSmokeOptions(values); Object.assign(summary, options);
    const context = installedContext(options), key = installedOwnershipKey(context);
    Object.assign(summary, {appRoot: context.appRoot, packageSha: context.packageSha, storageRoot: context.nativeProfile.profile.storageRoot, dataRoot: context.nativeProfile.profile.dataRoot});
    let marker = 'AAW installed smoke ' + randomUUID();
    if (options.phase === 'cold') marker = validateInstalledOwnership(json(path.join(ownershipRoot, key + '.json')), context);
    else assertFirstProfile(context.nativeProfile.profile.storageRoot);
    summary.marker = marker;
    for (const current of options.phase === 'both' ? ['first', 'cold'] : [options.phase]) {
      const report = await launch(context, current, marker, output); summary.results.push(report);
      if (report.status !== 'PASS') break;
      if (current === 'first') {
        mkdir(ownershipRoot); const ownerFile = path.join(ownershipRoot, key + '.json');
        // Never replace an ownership record or adopt a populated profile.
        writeJson(ownerFile, {schemaVersion: 'aaw.installed-desktop-smoke-ownership/v1', status: 'PASS', key, runId, normalClose: true,
          appRoot: context.appRoot, storageRoot: context.nativeProfile.profile.storageRoot, userSidSha256: context.nativeProfile.profile.userSidSha256,
          packageSha: context.packageSha, expectedExeSha: options.expectedExeSha, profileRevision: context.nativeProfile.profileRevision, marker});
      }
    }
    summary.status = summary.results.length === (options.phase === 'both' ? 2 : 1) && summary.results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL';
  } catch (error) {summary.error = String(error.message).slice(0, 400);}
  const evidence = path.join(output, 'summary.json'); writeJson(evidence, summary);
  return {schemaVersion: 'aaw.installed-desktop-smoke-result/v1', status: summary.status, evidence, marker: summary.marker,
    storageRoot: summary.storageRoot, packageSha256: summary.packageSha};
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  try {const result = await runInstalledDesktopSmoke(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.status !== 'PASS') process.exitCode = 1;}
  catch (error) {console.log(JSON.stringify({schemaVersion: 'aaw.installed-desktop-smoke-result/v1', status: 'FAIL', evidence: null, marker: null,
    storageRoot: null, packageSha256: null, error: String(error.message).slice(0, 400)})); process.exitCode = 1;}
}
