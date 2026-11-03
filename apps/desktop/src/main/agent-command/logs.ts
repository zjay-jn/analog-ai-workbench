import { createHash } from 'node:crypto';
import { COMMAND_LIMITS as L, type CommandLogPage, type CommandLogSummary, type CommandStream, type CommandToolArguments } from '../../shared/agent/agent-command';
import { commandJsonFits, parseCommandArguments } from '../../shared/agent/agent-command-validation';
import { CommandError, type CommandChunk, type CommandRecord, type CommandRepository } from './types';

export const commandDigest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const commandSignature = (value: unknown): string => commandDigest(JSON.stringify(value));
export const emptyPrefix = (executionId: string, stream: CommandStream): string => commandSignature(['aaw.command.log.v1',executionId,stream]);
export const chunkPrefix = (previous: string, chunk: Pick<CommandChunk,'offset'|'bytes'|'sha256'>): string => commandSignature([previous,chunk.offset,chunk.bytes,chunk.sha256]);
export const emptyLog = (executionId: string, stream: CommandStream): CommandLogSummary => ({stream,persistedBytes:0,observedBytes:0,prefixVersion:emptyPrefix(executionId,stream),closed:false,coverage:'open',sha256:null});

/** Returns a new record only; caller publishes it with one durable record CAS. */
export function appendCommandLog(repository: CommandRepository, record: CommandRecord, stream: CommandStream, input: Uint8Array): Readonly<{record:CommandRecord;limited:boolean}> {
  if (!(input instanceof Uint8Array) || input.byteLength > L.logChunkBytes) throw new CommandError('INVALID_REQUEST');
  const old=record.execution.logs[stream]; if(old.closed) throw new CommandError('CONFLICT');
  if(!input.byteLength) return {record,limited:false};
  const total=record.execution.logs.stdout.persistedBytes+record.execution.logs.stderr.persistedBytes;
  const records=record.chunks.stdout.length+record.chunks.stderr.length;
  const amount=records >= L.logRecords ? 0 : Math.min(input.byteLength,Math.max(0,record.intent.environment.limits.logBytes-total));
  const limited=amount<input.byteLength || total+amount>=record.intent.environment.limits.logBytes;
  const chunks=[...record.chunks[stream]];
  let prefix=old.prefixVersion;
  if(amount) {
    const bytes=input.slice(0,amount), object=repository.writeChunk(record.execution.executionId,bytes);
    const chunk={object,offset:old.persistedBytes,bytes:amount,sha256:commandDigest(bytes)};
    prefix=chunkPrefix(prefix,chunk);chunks.push({...chunk,prefixVersion:prefix});
  }
  const summary:CommandLogSummary={...old,persistedBytes:old.persistedBytes+amount,observedBytes:old.observedBytes+input.byteLength,prefixVersion:prefix,coverage:limited?'partial_at_limit':old.coverage};
  if(!Number.isSafeInteger(summary.observedBytes))throw new CommandError('BUDGET_EXCEEDED');
  return {record:{...record,chunks:{...record.chunks,[stream]:chunks},execution:{...record.execution,logs:{...record.execution.logs,[stream]:summary},...(records>=L.logRecords?{error:{code:'LOG_RECORD_LIMIT',stage:'log',nativeCode:null}}:{})}},limited};
}
export function sealCommandLog(repository:CommandRepository,record:CommandRecord,stream:CommandStream,eof:boolean,nativeDigest:string|null):CommandRecord {
  const old=record.execution.logs[stream],hash=createHash('sha256');
  for(const chunk of record.chunks[stream])hash.update(repository.readChunk(record.execution.executionId,chunk));
  const digest=hash.digest('hex');
  const complete=eof && old.observedBytes===old.persistedBytes && nativeDigest===digest && old.coverage!=='partial_at_limit';
  const summary:CommandLogSummary={...old,closed:true,sha256:digest,coverage:old.coverage==='partial_at_limit'?'partial_at_limit':complete?'complete':'incomplete'};
  return {...record,execution:{...record.execution,logs:{...record.execution.logs,[stream]:summary}}};
}
export function readCommandLog(repository:CommandRepository,record:CommandRecord,args:CommandToolArguments['command_log']):CommandLogPage {
  if(!parseCommandArguments('command_log',args)||args.executionId!==record.execution.executionId)throw new CommandError('INVALID_REQUEST');
  const summary=record.execution.logs[args.stream],chunks=record.chunks[args.stream],prefix=args.expectedPrefixVersion??summary.prefixVersion;
  const end=prefix===emptyPrefix(args.executionId,args.stream)?0:chunks.find(c=>c.prefixVersion===prefix)?.offset;
  const last=chunks.find(c=>c.prefixVersion===prefix);
  if(end===undefined)throw new CommandError('CURSOR_STALE');
  const snapshotBytes=last?last.offset+last.bytes:0;
  if(args.offset>snapshotBytes)throw new CommandError('CURSOR_STALE');
  const max=Math.min(args.maxBytes,snapshotBytes-args.offset),parts:Uint8Array[]=[];
  for(const chunk of chunks){if(chunk.offset>=args.offset+max)break;if(chunk.offset+chunk.bytes<=args.offset)continue;
    const raw=repository.readChunk(args.executionId,chunk);parts.push(raw.slice(Math.max(0,args.offset-chunk.offset),Math.min(chunk.bytes,args.offset+max-chunk.offset)));}
  const raw=Buffer.concat(parts);if(raw.length!==max)throw new CommandError('STORAGE_FAILED');
  let amount=raw.length;
  for(;;){const pageBytes=raw.subarray(0,amount);let format:'utf8'|'base64'='utf8',data:string;
    try{data=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(pageBytes);}catch{format='base64';data=pageBytes.toString('base64');}
    const endOffset=args.offset+amount;
    const page:CommandLogPage={executionId:args.executionId,stream:args.stream,prefixVersion:prefix,offset:args.offset,endOffset,snapshotBytes,availableBytes:summary.persistedBytes,format,data,bytesSha256:commandDigest(pageBytes),nextCursor:endOffset<snapshotBytes?{offset:endOffset,prefixVersion:prefix}:null,streamClosed:summary.closed&&snapshotBytes===summary.persistedBytes,coverage:summary.coverage,hasNewerBytes:summary.persistedBytes>snapshotBytes};
    if(commandJsonFits(page,L.toolResultBytes-1024))return page;
    if(amount<=1)throw new CommandError('BUDGET_EXCEEDED');amount=Math.max(1,Math.floor(amount*0.75));
  }
}
