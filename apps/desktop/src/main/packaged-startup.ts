import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {app, BrowserWindow} from 'electron';
import {configureRuntimePaths, type RuntimePaths} from './runtime-paths';
import {nativeWindowsEnvironment} from './native-environment';
import {loadPackagedDistribution, packagedAsset, packagedPinned, type PackagedDistribution} from './packaged-runtime';
import {probePackagedProfile, configurePackagedContext, assertFinalizedReady, packagedAdmissionDirectory} from './packaged-admission';
import {ensurePackagedDirectory, publishPackagedState, writePackagedJson} from './packaged-state-files';

async function initializationSplash(): Promise<(success: boolean) => void> {
  await app.whenReady();
  const keepAlive = () => {}, removeKeepAlive = () => {app.removeListener('window-all-closed', keepAlive);};
  app.on('window-all-closed', keepAlive);
  const window = new BrowserWindow({width: 420, height: 150, show: false, resizable: false, maximizable: false, minimizable: false, closable: false,
    title: 'Analog AI Workbench', autoHideMenuBar: true, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, partition: 'aaw-initialization-splash'}});
  window.setMenu(null); window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  const style = 'body{margin:0;display:grid;place-items:center;height:100vh;font:14px "Segoe UI","Microsoft YaHei",sans-serif;color:#333;background:#fafafa}';
  const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${style}</style></head><body>正在准备首次运行环境，请稍候…</body></html>`;
  const location = 'data:text/html;charset=UTF-8,' + encodeURIComponent(html);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel: details.url !== location}));
  try {await window.loadURL(location); window.showInactive();}
  catch {if (!window.isDestroyed()) window.destroy(); removeKeepAlive(); throw Error('PACKAGED_INITIALIZATION_WINDOW_FAILED');}
  return success => {
    // Keep the app alive across the short gap before the real main window is constructed.
    if (success) app.once('browser-window-created', removeKeepAlive);
    if (!window.isDestroyed()) window.destroy();
    if (!success) removeKeepAlive();
  };
}

function verifyElectronAddon(distribution: PackagedDistribution): void {
  const pin = packagedAsset(distribution, 'windowsFs'), directory = path.join(packagedAdmissionDirectory(), 'boots', 'boot-' + randomUUID());
  ensurePackagedDirectory(directory);
  try {
    if (process.versions.electron !== '43.4.0') throw Error('PACKAGED_ELECTRON_VERSION_CHANGED');
    const addon: unknown = require(pin.path), names = ['getCapabilities', 'openValidatedRoot', 'inspectRelative', 'readVerifiedText', 'replaceVerifiedText', 'reconcileVerifiedText', 'closeRoot'];
    if (!addon || typeof addon !== 'object') throw Error('PACKAGED_NATIVE_ADDON_EXPORTS');
    const descriptors = Object.getOwnPropertyDescriptors(addon);
    if (Object.keys(descriptors).length !== names.length || names.some(name => typeof descriptors[name]?.value !== 'function')) throw Error('PACKAGED_NATIVE_ADDON_EXPORTS');
    writePackagedJson(path.join(directory, 'addon-loaded.json'), {schemaVersion: 'aaw.packaged-electron-addon/v1', status: 'PASS', pin, electron: process.versions.electron,
      node: process.versions.node, exports: names.map(name => ({name, type: 'function'})), scope: 'Load and export type checks only; no native filesystem API called.'});
  } catch {
    writePackagedJson(path.join(directory, 'addon-loaded.json'), {schemaVersion: 'aaw.packaged-electron-addon/v1', status: 'NOT_READY', pin,
      electron: process.versions.electron, node: process.versions.node, code: 'PACKAGED_NATIVE_ADDON_LOAD_FAILED'});
    publishPackagedState(path.join(packagedAdmissionDirectory(), 'current.json'), {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'NOT_READY', stage: 'electron-addon-load', code: 'PACKAGED_NATIVE_ADDON_LOAD_FAILED'});
    throw Error('PACKAGED_NATIVE_ADDON_LOAD_FAILED');
  }
}

async function initialize(distribution: PackagedDistribution, input: string, directory: string): Promise<void> {
  const node = packagedAsset(distribution, 'node'), initializer = path.join(distribution.installationRoot, 'dist/packaged-runtime-init.cjs');
  const entry = distribution.manifest.files.find(file => file.path === 'dist/packaged-runtime-init.cjs');
  if (!entry) throw Error('PACKAGED_INITIALIZER_MISSING');
  packagedPinned({...entry, path: initializer});
  await new Promise<void>((resolve, reject) => {
    const child = spawn(node.path, [initializer, input], {cwd: distribution.installationRoot, env: nativeWindowsEnvironment(),
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let outBytes = 0, errBytes = 0, stopped = false, settled = false;
    const stop = () => {if (stopped) return; stopped = true; try {child.stdin.end();} catch {}};
    const timer = setTimeout(stop, 210000), hard = setTimeout(() => {
      stop(); try {child.kill();} catch {}
      child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(false);
    }, 240000);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {if (outBytes < 65536) stdout.push(chunk.subarray(0, 65536 - outBytes)); outBytes += chunk.length; if (outBytes > 65536) stop();});
    child.stderr.on('data', (chunk: Buffer) => {if (errBytes < 65536) stderr.push(chunk.subarray(0, 65536 - errBytes)); errBytes += chunk.length; if (errBytes > 65536) stop();});
    const finish = (okay: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hard);
      try {writePackagedJson(path.join(directory, 'launcher.json'), {schemaVersion: 'aaw.packaged-init-launcher/v1', status: okay ? 'PASS' : 'NOT_READY', stdoutBytes: outBytes,
        stderrBytes: errBytes, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), stopped});} catch {okay = false;}
      if (okay) resolve(); else reject(Error('PACKAGED_INITIALIZER_FAILED'));
    };
    child.once('error', () => finish(false)); child.once('close', code => finish(code === 0 && !stopped && outBytes <= 65536 && errBytes <= 65536));
  });
}

/** Runs before cloud capabilities or stores are constructed. No compiler or package manager is invoked. */
export async function preparePackagedStartup(options: Readonly<{applicationRoot: string; expectedStorageRoot: string; onConfigured?: (paths: RuntimePaths) => void}>): Promise<RuntimePaths> {
  const distribution = loadPackagedDistribution(options.applicationRoot), nativeProfile = probePackagedProfile(distribution, options.expectedStorageRoot);
  const roots = configureRuntimePaths({installationRoot: distribution.installationRoot, storageRoot: nativeProfile.profile.storageRoot, mode: 'packaged'});
  configurePackagedContext(distribution, nativeProfile);
  for (const directory of [roots.storageRoot, roots.dataRoot, roots.profileRoot, packagedAdmissionDirectory()]) ensurePackagedDirectory(directory);
  options.onConfigured?.(roots);
  verifyElectronAddon(distribution);
  try {assertFinalizedReady(); return roots;} catch {/* This bundle and current native profile require their own fresh proof. */}
  const attemptId = randomUUID(), directory = path.join(packagedAdmissionDirectory(), 'init-' + attemptId); ensurePackagedDirectory(directory);
  const input = path.join(directory, 'request.json'), binding = {attemptId, packageManifestSha256: distribution.pin.sha256, profileRevision: nativeProfile.profileRevision,
    installationRoot: roots.installationRoot, storageRoot: roots.storageRoot, dataRoot: roots.dataRoot};
  writePackagedJson(input, {schemaVersion: 'aaw.packaged-init-request/v1', ...binding});
  publishPackagedState(path.join(packagedAdmissionDirectory(), 'current.json'), {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'NOT_READY', ...binding, stage: 'initializing'});
  let closeSplash: ((success: boolean) => void) | undefined, success = false;
  try {
    closeSplash = await initializationSplash();
    await initialize(distribution, input, directory);
    const ready = assertFinalizedReady(); if (ready.admission.attemptId !== attemptId) throw Error('PACKAGED_INITIALIZER_BINDING_CHANGED');
    success = true; return roots;
  } catch {
    publishPackagedState(path.join(packagedAdmissionDirectory(), 'current.json'), {schemaVersion: 'aaw.packaged-runtime-admission/v1', status: 'NOT_READY', ...binding, stage: 'failed', code: 'PACKAGED_INITIALIZER_FAILED'});
    throw Error('PACKAGED_INITIALIZER_FAILED');
  } finally {closeSplash?.(success);}
}
