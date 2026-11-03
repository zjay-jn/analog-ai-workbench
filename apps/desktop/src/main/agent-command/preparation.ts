import { COMMAND_LIMITS as L } from '../../shared/agent/agent-command';
import { WORK_CYCLE_LIMITS as W } from '../../shared/agent/agent-work-cycle';
import { CommandPreparationError, type CommandRecord } from './types';
import { commandSignature } from './logs';
/** Admission reserve, not an OS disk quota. Account for both native and main log copies. */
export function commandPreparationReserve(runtimeBytes:number):bigint{return BigInt(runtimeBytes+2*L.logBytes+2*W.workspaceBytes+2*4*1024*1024+16*1024*1024+2*L.recordBytes);}
export function checkCommandPreparation(record:CommandRecord,runtimeBytes:number,availableBytes:bigint,now:number):void{
  const error=(code:string):never=>{throw new CommandPreparationError(code,commandSignature({schema:'aaw.command.no-process.v1',executionId:record.execution.executionId,signature:record.execution.signature,nonce:record.intent.nonce,code,nativeAttempted:false,resourcesCreated:false}));};
  if(availableBytes<commandPreparationReserve(runtimeBytes))error('INSUFFICIENT_DISK_SPACE');
  if(now>=Date.parse(record.execution.deadlineAt))error('PREPARATION_DEADLINE');
  const cwd=record.execution.cwdRelativePath;if(cwd&&!record.intent.baseline.some(f=>f.relativePath.startsWith(cwd+'/')))error('CWD_UNAVAILABLE');
}
