import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const child=spawn(require('electron'),[fileURLToPath(new URL('../dist/cloud/main/index.js',import.meta.url))],{stdio:'inherit',windowsHide:true});
child.once('error',()=>{console.error('Cloud desktop could not start.');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
