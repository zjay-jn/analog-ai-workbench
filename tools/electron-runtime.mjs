import fs from 'node:fs';
import path from 'node:path';
import {ordinary} from './portable-runtime-lib.mjs';

/** Unlike require('electron'), this never installs or downloads anything. */
export function installedElectron(root) {
  try {
  const directory=path.join(root,'node_modules/electron');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  if(manifest.version!=='43.4.0')throw Error('ELECTRON_43_4_0_DEPENDENCY_REQUIRED');
  const name=fs.readFileSync(path.join(directory,'path.txt'),'utf8').trim();
  if(name!=='electron.exe')throw Error('ELECTRON_DESKTOP_SETUP_REQUIRED');
  const version=fs.readFileSync(path.join(directory,'dist/version'),'utf8').trim().replace(/^v/u,'');
  if(version!=='43.4.0')throw Error('ELECTRON_DESKTOP_SETUP_REQUIRED');
  const executable=path.join(directory,'dist',name);ordinary(executable);return executable;
  } catch(error) {
    if(['ENOENT','ENOTDIR'].includes(error?.code))throw Error('ELECTRON_DESKTOP_SETUP_REQUIRED');
    throw error;
  }
}
