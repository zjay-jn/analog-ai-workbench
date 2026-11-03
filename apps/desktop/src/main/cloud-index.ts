import path from 'node:path';
import {app, dialog} from 'electron';
import {configureRuntimePaths} from './runtime-paths';
import {preparePackagedStartup} from './packaged-startup';

const applicationRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '../../..');
const selected = process.argv.filter(value => value.startsWith('--storage-root='));
if (app.isPackaged && selected.length || selected.length > 1 || selected.length === 1 && !path.isAbsolute(selected[0]!.slice('--storage-root='.length))) throw Error('RUNTIME_PATH_CONFIGURATION');
const storageRoot = selected.length ? path.resolve(selected[0]!.slice('--storage-root='.length)) : path.join(app.getPath('appData'), 'AnalogAIWorkbench');
async function start(): Promise<void> {
  let configuredStorageRoot = storageRoot;
  if (app.isPackaged) {
    const roots = await preparePackagedStartup({applicationRoot, expectedStorageRoot: storageRoot, onConfigured: roots => {
      app.setPath('userData', roots.profileRoot);
      if (!app.requestSingleInstanceLock()) throw Error('PACKAGED_ALREADY_RUNNING');
    }});
    configuredStorageRoot = roots.storageRoot;
  } else configureRuntimePaths({installationRoot: applicationRoot, storageRoot});
  const {startCloudDesktop} = await import('./engine-live/cloud-bootstrap.js');
  await startCloudDesktop({mode: 'production', applicationRoot, storageRoot: configuredStorageRoot});
}
void start().catch(error => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'CLOUD_BOOTSTRAP_INITIALIZATION';
  if (code === 'PACKAGED_ALREADY_RUNNING') {app.quit(); return;}
  console.error(code); process.exitCode = 1;
  if (app.isPackaged) {dialog.showErrorBox('运行环境准备失败', `请查看本地诊断记录。错误代码：${code}`); app.quit();}
});
