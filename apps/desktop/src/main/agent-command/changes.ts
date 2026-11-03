import { COMMAND_LIMITS as C } from '../../shared/agent/agent-command';
import { WORK_CYCLE_LIMITS as W, isWorkCycleRelativePath } from '../../shared/agent/agent-work-cycle';
import { commandJsonFits, commandObject, commandSha } from '../../shared/agent/agent-command-validation';
import { fileNameAllowed, validFileText } from '../../shared/agent/file-context';
import { CommandError, type CommandProducedChanges, type CommandRecord } from './types';
import { commandDigest, commandSignature } from './logs';

export const commandChangesVersion=(changes:Omit<CommandProducedChanges,'manifestVersion'>):string=>commandSignature(['aaw.command.changes.v1',changes.baselineVersion,changes.files.map(f=>[f.relativePath,f.beforeVersion,f.version,f.bytes.byteLength]),changes.deleted.map(f=>[f.relativePath,f.beforeVersion])]);
export function validateCommandChanges(changes:CommandProducedChanges,baseline:CommandRecord['intent']['baseline']):void{
  if(!commandObject(changes,['baselineVersion','manifestVersion','files','deleted'])||!commandSha(changes.baselineVersion)||!commandSha(changes.manifestVersion)||!Array.isArray(changes.files)||changes.files.length>W.artifactsPerExecution||!Array.isArray(changes.deleted)||changes.deleted.length>W.files)throw new CommandError('INVALID_REQUEST');
  const seen=new Set<string>();let total=0;
  const acceptPath=(relative:unknown):relative is string=>isWorkCycleRelativePath(relative)&&!relative.split('/').some(p=>p.startsWith('.'))&&fileNameAllowed(relative.split('/').at(-1)!);
  for(const f of changes.files){if(!commandObject(f,['relativePath','beforeVersion','version','bytes'])||!acceptPath(f.relativePath)||!commandSha(f.version)||f.beforeVersion!==null&&!commandSha(f.beforeVersion)||!(f.bytes instanceof Uint8Array)||f.bytes.byteLength>W.fileBytes||commandDigest(f.bytes)!==f.version)throw new CommandError('INVALID_REQUEST');
    const old=baseline.find(b=>b.relativePath===f.relativePath);if((old?.version??null)!==f.beforeVersion||old?.version===f.version||seen.has(f.relativePath.toLowerCase()))throw new CommandError('CONFLICT');seen.add(f.relativePath.toLowerCase());
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(f.bytes);}catch{throw new CommandError('UNSUPPORTED_ENCODING');}if(!validFileText(text.replace(/\r\n?/gu,'\n')))throw new CommandError('UNSUPPORTED_TEXT');total+=f.bytes.byteLength;
  }
  for(const f of changes.deleted){if(!commandObject(f,['relativePath','beforeVersion'])||!acceptPath(f.relativePath)||!commandSha(f.beforeVersion)||baseline.find(b=>b.relativePath===f.relativePath)?.version!==f.beforeVersion||seen.has(f.relativePath.toLowerCase()))throw new CommandError('CONFLICT');seen.add(f.relativePath.toLowerCase());}
  if(total>W.outputBytes||changes.manifestVersion!==commandChangesVersion(changes)||!commandJsonFits({baselineVersion:changes.baselineVersion,manifestVersion:changes.manifestVersion,files:changes.files.map(f=>({...f,bytes:f.bytes.byteLength})),deleted:changes.deleted},C.recordBytes))throw new CommandError('BUDGET_EXCEEDED');
}
