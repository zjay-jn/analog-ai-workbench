import path from 'node:path';
import { isCommandEnvironment } from '../../shared/agent/agent-command-validation';
import { COMMAND_PRODUCT, nativePinned, type NativeFilePin } from './native-files';
import { createWindowsCommandDriver, type CommandDriverProfile } from './windows-driver';
import { createWslCommandDriver, createWslRecoveryDriver, type WslCommandDriverProfile } from './wsl-driver';
import type { CommandDriver } from './types';
import type {WslPrestartRecoveryPin} from './wsl-prestart-recovery';

export const COMMAND_ADMISSION:NativeFilePin=Object.freeze({path:path.join(COMMAND_PRODUCT,'.local/quality-evidence/20260914-agent-command-native-01/native-build-04/runtime-admission.json'),bytes:4704,sha256:'bd013cb13bfc2b3e856f4a93ddd0270c617700eb798bffb7eb9ddd3348f3e743'});
/** Root fills this exact pin only after the WSL runtime admission is actually verified. */
export const WSL_COMMAND_ADMISSION:NativeFilePin|null=Object.freeze({path:path.join(COMMAND_PRODUCT,'.local/command-repair-20261028/runtime-admission-candidate.json'),bytes:5958,sha256:'487110053f8ad3928afda3e26b263a03e97c341cbca4dc9a2f4fa01c2eb3db0b'});
/** Retained only for local recovery. Never starts the old supervisor or grants a new command. */
export const WSL_COMMAND_LEGACY_ADMISSIONS:readonly NativeFilePin[]=Object.freeze([
  Object.freeze({path:path.join(COMMAND_PRODUCT,'.local/quality-evidence/20260916-wsl-opencode-release-01/runtime-admission.json'),bytes:8857,sha256:'7535e4aed68e4f89780f839a37575f413337748005cbac3a5a4447d205bad5c4'}),
  Object.freeze({path:path.join(COMMAND_PRODUCT,'.local/quality-evidence/20260915-wsl-command-01/wsl-runtime-admission-01.json'),bytes:5937,sha256:'13a30602f1bc44b0d983d7ffd1ce2bd2d7cd7f096ae279ccd4d1e9e76bb44ef2'}),
]);
/** The reviewed admission is immutable; a nearby candidate manifest never grants execution. */
export function registeredCommandDrivers():readonly CommandDriver[]{
  const drivers:CommandDriver[]=[];
  let prestartRecovery:readonly WslPrestartRecoveryPin[]=[];
  try{
    const admission=JSON.parse(nativePinned(COMMAND_ADMISSION,512*1024).toString('utf8'));
    if(admission.schema!=='aaw.command.runtime-admission.v1'||admission.status!=='SCOPED_NATIVE_READY_FOR_INTEGRATION'||!isCommandEnvironment(admission.environment)||admission.environment.platform!=='windows'||admission.environment.availability!=='ready'||admission.environment.revision!=='5110cbb8af8cbc13627f2fa91bade180c73ca6656edf5d89fa1c5084d62064e9')throw new Error('Invalid Windows command admission');
    const pin=(v:{path:string;bytes:number;sha256:string}):NativeFilePin=>({path:path.resolve(COMMAND_PRODUCT,v.path),bytes:v.bytes,sha256:v.sha256});
    const profile:CommandDriverProfile={environment:admission.environment,native:pin(admission.native),node:pin(admission.runtime.node),license:pin(admission.runtime.license),bootstrap:pin(admission.runtime.bootstrap),proof:COMMAND_ADMISSION};
    drivers.push(createWindowsCommandDriver(profile));
  }catch{/* One unavailable environment must not hide a separately admitted one. */}
  if(WSL_COMMAND_ADMISSION)try{
    const admission=JSON.parse(nativePinned(WSL_COMMAND_ADMISSION,512*1024).toString('utf8'));
    if(admission.schema!=='aaw.command.wsl.runtime-admission.v1'||admission.status!=='SCOPED_WSL_READY_FOR_INTEGRATION'||!isCommandEnvironment(admission.environment)||admission.environment.platform!=='wsl'||admission.environment.availability!=='ready'||admission.environment.isolation!=='wsl-bubblewrap')throw new Error('Invalid WSL command admission');
    const pin=(v:{path:string;bytes:number;sha256:string}):NativeFilePin=>({path:path.resolve(COMMAND_PRODUCT,v.path),bytes:v.bytes,sha256:v.sha256});
    if(admission.prestartRecovery!==undefined){
      if(!Array.isArray(admission.prestartRecovery)||admission.prestartRecovery.length>32)throw new Error('Invalid recovery certificate registry');
      prestartRecovery=admission.prestartRecovery.map((value:WslPrestartRecoveryPin)=>({certificate:pin(value.certificate),auditor:pin(value.auditor),supervisor:pin(value.supervisor),launch:pin(value.launch),launcher:pin(value.launcher)}));
    }
    const profile:WslCommandDriverProfile={environment:admission.environment,supervisor:pin(admission.supervisor),proof:WSL_COMMAND_ADMISSION,wslPath:admission.wslPath,linuxPythonPath:admission.linuxPythonPath,bubblewrapPath:admission.bubblewrapPath,prestartRecovery};
    drivers.push(createWslCommandDriver(profile));
  }catch{/* Retain Windows availability and old records when WSL admission fails. */}
  for(const proof of WSL_COMMAND_LEGACY_ADMISSIONS)try{
    const admission=JSON.parse(nativePinned(proof,512*1024).toString('utf8'));
    if(admission.schema!=='aaw.command.wsl.runtime-admission.v1'||admission.status!=='SCOPED_WSL_READY_FOR_INTEGRATION'||!isCommandEnvironment(admission.environment)||admission.environment.platform!=='wsl'||admission.environment.availability!=='ready'||admission.environment.isolation!=='wsl-bubblewrap')throw new Error('Invalid legacy WSL admission');
    if(!drivers.some(d=>d.environment.environmentId===admission.environment.environmentId&&d.environment.revision===admission.environment.revision))drivers.push(createWslRecoveryDriver(admission.environment,prestartRecovery));
  }catch{/* Missing old evidence remains unconfirmed; there is no runtime fallback. */}
  return drivers;
}
