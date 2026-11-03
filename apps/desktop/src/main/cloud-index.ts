import path from 'node:path';
import {app} from 'electron';
import {configureRuntimePaths} from './runtime-paths';

const applicationRoot = path.resolve(__dirname, '../../..');
const selected = process.argv.filter(value => value.startsWith('--storage-root='));
if (selected.length > 1 || selected.length === 1 && !path.isAbsolute(selected[0]!.slice('--storage-root='.length))) throw Error('RUNTIME_PATH_CONFIGURATION');
const storageRoot = selected.length ? path.resolve(selected[0]!.slice('--storage-root='.length)) : path.join(app.getPath('appData'), 'AnalogAIWorkbench');
configureRuntimePaths({installationRoot: applicationRoot, storageRoot});
void import('./engine-live/cloud-bootstrap.js').then(({startCloudDesktop}) => startCloudDesktop({ mode: 'production', applicationRoot, storageRoot }))
  .catch(() => { console.error('CLOUD_BOOTSTRAP_INITIALIZATION'); process.exitCode = 1; });
