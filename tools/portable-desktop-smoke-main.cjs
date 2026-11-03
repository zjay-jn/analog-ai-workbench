const {app} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {createHash} = require('node:crypto');
const {syncBuiltinESMExports} = require('node:module');

// This switch belongs to the test process, not the production application.
app.disableHardwareAcceleration();

async function smoke() {
  const {checkoutRoot, artifactRoot, parseSmokeOptions, assertUnaliased, assertFirstProfile, smokeAddonPin, captureSmokePage} = await import('./portable-desktop-smoke.mjs');
  const {ordinary} = await import('./portable-runtime-lib.mjs');
  const planFile = process.argv[2];
  if (!planFile || !path.isAbsolute(planFile)) throw Error('SMOKE_PLAN_INVALID');
  const output = path.dirname(planFile), relative = path.relative(artifactRoot, output).split(path.sep);
  if (path.basename(planFile) !== 'plan.json' || relative.length !== 2 || !/^run-[a-f0-9-]{36}$/u.test(relative[0]) || !['first', 'cold'].includes(relative[1])) throw Error('SMOKE_PLAN_OUTSIDE_ARTIFACTS');
  assertUnaliased(output);
  if (ordinary(planFile).size > 64 * 1024) throw Error('SMOKE_PLAN_TOO_LARGE');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (!Array.isArray(plan.forbiddenRoots) || plan.forbiddenRoots.length > 1) throw Error('SMOKE_PLAN_INVALID');
  const options = parseSmokeOptions([`--app-root=${plan.appRoot}`, `--storage-root=${plan.storageRoot}`, `--phase=${plan.phase}`,
    ...plan.forbiddenRoots.map(root => `--forbidden-root=${root}`)]);
  const productionEntry = path.join(checkoutRoot, 'dist/cloud/main/index.js');
  if (plan.output !== output || plan.phase !== relative[1] || plan.storageRoot !== options.storageRoot
      || plan.productionEntry !== productionEntry || plan.profileRoot !== path.join(options.storageRoot, '.local/cloud-user-data')
      || !/^AAW portable smoke [a-f0-9-]{36}$/u.test(plan.marker)
      || !/^workbench\.[a-z-]+\.v\d+$/u.test(plan.settingsVersion) || !/^workbench\.[a-z-]+\.v\d+$/u.test(plan.workspaceVersion)) throw Error('SMOKE_PLAN_INVALID');
  const windowsFs = smokeAddonPin(checkoutRoot, options.storageRoot);
  if (plan.windowsFs?.path !== windowsFs.path || plan.windowsFs?.bytes !== windowsFs.bytes || plan.windowsFs?.sha256 !== windowsFs.sha256) throw Error('SMOKE_ADDON_PLAN_MISMATCH');
  ordinary(productionEntry);
  if (createHash('sha256').update(fs.readFileSync(productionEntry)).digest('hex') !== plan.productionEntrySha256) throw Error('PRODUCTION_ENTRY_CHANGED');
  assertUnaliased(options.storageRoot);
  if (plan.phase === 'first') assertFirstProfile(options.storageRoot);
  const report = {schemaVersion: 'aaw.portable-ui-startup/v1', phase: plan.phase, status: 'RUNNING',
    productionEntry, productionEntrySha256: plan.productionEntrySha256, storageRoot: plan.storageRoot, profileRoot: plan.profileRoot,
    networkAttempts: [], childProcessAttempts: [], forbiddenFilesystemAttempts: [], rendererFailures: [], shutdownFailures: [], captureAttempts: [], processDiagnostics: [], normalQuit: false, windowClosed: false, addonLoaded: false};
  const resultFile = path.join(output, 'result.json');
  const save = () => fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
  const clearBoundaries = () => ['networkAttempts', 'childProcessAttempts', 'forbiddenFilesystemAttempts', 'rendererFailures', 'shutdownFailures'].every(key => report[key].length === 0);
  function fail(code) {report.status = 'FAIL'; report.code = code; save(); process.exitCode = 1; app.quit();}
  const originalConsoleError = console.error;
  console.error = function(...values) {
    for (const value of values) if (value === 'CLOUD_SHUTDOWN_FAILED' || value === 'CLOUD_SHUTDOWN_TIMEOUT') report.shutdownFailures.push(value);
    return originalConsoleError.apply(this, values);
  };
  app.on('child-process-gone', (_event, details) => {report.processDiagnostics.push({type: details.type, reason: details.reason, exitCode: details.exitCode}); save();});

  // Guards apply only to this new test process. They are not an OS-wide sandbox.
  const denied = plan.forbiddenRoots.map(root => path.resolve(root).replaceAll('\\', '/').toLowerCase());
  function checkFile(value) {
    let file;
    try {file = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;} catch {return;}
    if (typeof file !== 'string') return;
    const normalized = path.resolve(file).replaceAll('\\', '/').toLowerCase();
    const boundary = denied.find(root => normalized === root || normalized.startsWith(root + '/'));
    if (boundary) {report.forbiddenFilesystemAttempts.push({boundary}); throw Error('FORBIDDEN_FILESYSTEM_ATTEMPT');}
  }
  const destinationMethods = new Set(['renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync', 'rename', 'copyFile', 'cp', 'link', 'symlink']);
  for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'readdirSync', 'realpathSync', 'existsSync', 'accessSync',
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'linkSync', 'symlinkSync',
    'readFile', 'open', 'stat', 'lstat', 'readdir', 'realpath', 'exists', 'access', 'writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir',
    'rename', 'copyFile', 'cp', 'link', 'symlink', 'createReadStream', 'createWriteStream']) {
    const original = fs[name];
    fs[name] = function(...args) {checkFile(args[0]); if (destinationMethods.has(name)) checkFile(args[1]); return original.apply(this, args);};
    if (original.native) fs[name].native = function(...args) {checkFile(args[0]); return original.native.apply(this, args);};
  }
  for (const name of ['readFile', 'open', 'stat', 'lstat', 'readdir', 'realpath', 'access', 'writeFile', 'appendFile', 'mkdir', 'unlink',
    'rm', 'rmdir', 'rename', 'copyFile', 'cp', 'link', 'symlink']) {
    const original = fs.promises[name];
    fs.promises[name] = async function(...args) {checkFile(args[0]); if (destinationMethods.has(name)) checkFile(args[1]); return original.apply(this, args);};
  }
  const forbidNetwork = source => () => {report.networkAttempts.push({source}); throw Error('STARTUP_NETWORK_FORBIDDEN');};
  for (const moduleName of ['node:http', 'node:https']) for (const method of ['request', 'get']) require(moduleName)[method] = forbidNetwork(moduleName + '.' + method);
  for (const method of ['connect', 'createConnection']) require('node:net')[method] = forbidNetwork('node:net.' + method);
  require('node:tls').connect = forbidNetwork('node:tls.connect');
  globalThis.fetch = async () => forbidNetwork('main.fetch')();
  const childProcess = require('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = () => {
    report.childProcessAttempts.push({method}); throw Error('STARTUP_CHILD_PROCESS_FORBIDDEN');
  };
  syncBuiltinESMExports();
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, callback) => {
    const external = /^(?:https?|wss?):/u.test(details.url);
    if (external) report.networkAttempts.push({source: 'renderer.request'});
    callback({cancel: external});
  }));
  fs.mkdirSync(plan.profileRoot, {recursive: true});
  assertUnaliased(plan.profileRoot);
  app.setPath('userData', plan.profileRoot);
  app.setPath('sessionData', plan.profileRoot);
  process.argv = [process.execPath, productionEntry, '--storage-root=' + plan.storageRoot];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let captured = false;
  app.on('browser-window-created', (_event, window) => {
    window.once('closed', () => {report.windowClosed = true; save();});
    window.webContents.on('render-process-gone', (_event, details) => report.rendererFailures.push({reason: details.reason, exitCode: details.exitCode}));
    window.webContents.once('did-finish-load', () => {
      if (captured) return; captured = true;
      void (async () => {
        report.stage = 'wait-for-production-ui';
        let previous = '', stable = 0, state;
        for (let attempt = 0; attempt < 100; attempt++) {
          state = await window.webContents.executeJavaScript(`(() => ({text:document.body.innerText,textarea:!!document.querySelector('textarea'),settings:!!window.workbenchModelSettings,workspace:!!window.workbenchWorkspace}))()`);
          if (state.text === previous && state.textarea && state.settings && state.workspace) stable++; else stable = 0;
          previous = state.text;
          if (stable >= 3) break;
          await sleep(200);
        }
        if (!state?.textarea || !state.settings || !state.workspace || stable < 3) throw Error('UI_NOT_READY');
        report.ui = {title: window.getTitle(), text: state.text, textarea: state.textarea, stable: true};
        report.stage = 'read-settings';
        const settings = await window.webContents.executeJavaScript(`window.workbenchModelSettings.readSettings({contractVersion:${JSON.stringify(plan.settingsVersion)}})`);
        if (!settings.ok || settings.value.storage !== 'ready' || settings.value.providers.length !== 2 || settings.value.providers.some(provider => provider.configured)) throw Error('FRESH_SETTINGS_NOT_READY_OR_HAS_KEYS');
        report.settings = {storage: settings.value.storage, configured: settings.value.providers.map(provider => ({provider: provider.provider, configured: provider.configured}))};
        report.stage = 'read-workspace';
        const workspace = await window.webContents.executeJavaScript(`window.workbenchWorkspace.read({contractVersion:${JSON.stringify(plan.workspaceVersion)}})`);
        if (!workspace.ok || workspace.value.projects.length !== 1 || workspace.value.projects.some(project => project.sessionIds.length)) throw Error('FRESH_WORKSPACE_INVALID');
        const project = workspace.value.projects[0];
        if (plan.phase === 'cold' && (project.name !== plan.marker || !state.text.includes(plan.marker) || workspace.value.revision < 1)) throw Error('COLD_PROJECT_NOT_RESTORED');
        report.workspace = {revision: workspace.value.revision, projects: workspace.value.projects.length, name: project.name, sessions: 0};
        report.stage = 'capture-main';
        const image = await captureSmokePage(window, 'workbench', attempt => {report.captureAttempts.push(attempt); save();});
        fs.writeFileSync(path.join(output, 'workbench.png'), image.png);
        report.screenshot = 'workbench.png'; report.screenshotSize = image.size;
        if (plan.phase === 'first') {
          report.stage = 'open-synthetic-menu';
          let openedMenu = false;
          for (let attempt = 0; attempt < 50; attempt++) {
            openedMenu = await window.webContents.executeJavaScript(`(() => {const button=document.querySelector('.file-workbench button[aria-label="打开文档"]');if(!button||button.disabled)return false;button.click();return true;})()`);
            if (openedMenu) break; await sleep(100);
          }
          if (!openedMenu) throw Error('SYNTHETIC_MENU_UNAVAILABLE');
          let clicked = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            clicked = await window.webContents.executeJavaScript(`(() => {const items=[...document.querySelectorAll('[role="menuitem"]')].filter(node=>node.textContent.trim()==='打开合成原理图');if(items.length!==1||items[0].disabled)return false;items[0].click();return true;})()`);
            if (clicked) break; await sleep(100);
          }
          if (!clicked) throw Error('SYNTHETIC_MENU_ITEM_UNAVAILABLE');
          report.stage = 'wait-for-synthetic-svg';
          let schematic;
          for (let attempt = 0; attempt < 100; attempt++) {
            schematic = await window.webContents.executeJavaScript(`(() => {const panel=document.querySelector('[data-schematic-kind="synthetic"]'),svg=panel?.querySelector('svg[data-schematic-canvas="true"]'),box=svg?.getBoundingClientRect();return {status:panel?.dataset.status??null,svg:!!svg,graphics:svg?.querySelectorAll('polyline,line,rect,path,circle,polygon,text').length??0,width:box?.width??0,height:box?.height??0};})()`);
            if (schematic.status === 'ready' && schematic.svg && schematic.graphics >= 4 && schematic.width > 0 && schematic.height > 0) break;
            await sleep(100);
          }
          if (schematic?.status !== 'ready' || !schematic.svg || schematic.graphics < 4 || schematic.width <= 0 || schematic.height <= 0) throw Error('SYNTHETIC_NOT_RENDERED');
          report.stage = 'capture-synthetic'; await sleep(300);
          const syntheticImage = await captureSmokePage(window, 'synthetic', attempt => {report.captureAttempts.push(attempt); save();});
          fs.writeFileSync(path.join(output, 'synthetic.png'), syntheticImage.png);
          report.synthetic = {...schematic, openedThrough: 'FileWorkbench menu DOM click -> renderer openSynthetic controller', screenshot: 'synthetic.png'};
          report.stage = 'persist-project-marker';
          const persisted = await window.webContents.executeJavaScript(`(async()=>{const response=await window.workbenchWorkspace.read({contractVersion:${JSON.stringify(plan.workspaceVersion)}});if(!response.ok)return response;const state=response.value;state.projects[0].name=${JSON.stringify(plan.marker)};return window.workbenchWorkspace.save({contractVersion:${JSON.stringify(plan.workspaceVersion)},expectedRevision:state.revision,state});})()`);
          if (!persisted.ok || persisted.value.projects[0].name !== plan.marker) throw Error('PERSISTENCE_MARKER_FAILED');
          report.persistedMarker = plan.marker;
        }
        if (!clearBoundaries()) throw Error('STARTUP_BOUNDARY_ATTEMPT');
        report.stage = 'close-own-window'; report.status = 'PASS'; save(); window.close();
      })().catch(error => {
        report.testError = {name: error.name, message: String(error.message).slice(0, 400), stack: String(error.stack).replaceAll(productionEntry, '<production-entry>').slice(0, 1600)};
        fail(/^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'STARTUP_VERIFICATION_FAILED');
      });
    });
  });
  const watchdog = setTimeout(() => fail('STARTUP_TIMEOUT'), 45000);
  app.on('will-quit', () => {clearTimeout(watchdog); report.normalQuit = true; if (!clearBoundaries()) {report.status = 'FAIL'; report.code = 'STARTUP_BOUNDARY_ATTEMPT'; process.exitCode = 1;} save();});
  process.on('exit', code => {
    report.exitCode = code;
    if (code !== 0 || !clearBoundaries() || !report.normalQuit || !report.windowClosed) {
      report.status = 'FAIL'; report.code ??= code !== 0 ? 'PROCESS_EXIT_FAILED' : 'STARTUP_BOUNDARY_OR_CLOSE_FAILED'; process.exitCode = 1;
    }
    save();
  });
  process.on('uncaughtException', error => {report.testError = {name: error.name, message: String(error.message).slice(0, 400)}; fail('STARTUP_UNCAUGHT_EXCEPTION');});
  process.on('unhandledRejection', error => {report.testError = {message: String(error?.message ?? error).slice(0, 400)}; fail('STARTUP_UNHANDLED_REJECTION');});
  try {
    report.stage = 'load-native-addon';
    const addon = require(windowsFs.path);
    const names = ['getCapabilities', 'openValidatedRoot', 'inspectRelative', 'readVerifiedText', 'replaceVerifiedText', 'reconcileVerifiedText', 'closeRoot'];
    const descriptors = Object.getOwnPropertyDescriptors(addon);
    if (Object.keys(descriptors).length !== names.length || names.some(name => typeof descriptors[name]?.value !== 'function')) throw Error('SMOKE_ADDON_EXPORTS_INVALID');
    report.addonLoaded = true;
    report.addon = {path: path.relative(checkoutRoot, windowsFs.path), sha256: windowsFs.sha256, exports: names.map(name => ({name, type: 'function'})),
      electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi, scope: 'Loaded and checked export types only; no addon API invoked.'};
    save();
    require(productionEntry);
  } catch (error) {report.testError = {name: error.name, message: String(error.message).slice(0, 400)}; fail(report.addonLoaded ? 'PRODUCTION_ENTRY_FAILED' : 'SMOKE_ADDON_LOAD_FAILED');}
}

void smoke().catch(error => {console.error(error.message); process.exitCode = 1; app.quit();});
