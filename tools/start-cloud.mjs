import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installedElectron} from './electron-runtime.mjs';
const options=process.argv.slice(2);
if(options.length>1||options.some(value=>!value.startsWith('--storage-root=')||!value.slice('--storage-root='.length)))throw Error('Usage: npm start -- --storage-root=<absolute-directory>');
let executable;
try {
  executable=installedElectron(fileURLToPath(new URL('../',import.meta.url)));
}catch {throw Error('Electron is not installed. Run npm run setup:desktop after npm ci.');}
const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;delete environment.ELECTRON_OVERRIDE_DIST_PATH;
const child=spawn(executable,[fileURLToPath(new URL('../dist/cloud/main/index.js',import.meta.url)),...options],{stdio:'inherit',windowsHide:true,env:environment});
child.once('error',()=>{console.error('Cloud desktop could not start.');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
