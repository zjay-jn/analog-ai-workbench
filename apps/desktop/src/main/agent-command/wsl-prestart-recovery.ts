import {isDeepStrictEqual} from 'node:util';
import {COMMAND_LIMITS as L} from '../../shared/agent/agent-command';
import {commandObject,commandSha} from '../../shared/agent/agent-command-validation';
import {nativePinned,type NativeFilePin} from './native-files';
import type {CommandDriverOutcome,CommandRecord} from './types';
import {parseWslTerminal,wslDigest,wslIdentityMatches} from './wsl-protocol';

export type WslPrestartRecoveryPin=Readonly<{certificate:NativeFilePin;auditor:NativeFilePin;supervisor:NativeFilePin;launch:NativeFilePin;launcher:NativeFilePin}>;
const date=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)&&Number.isFinite(Date.parse(v));
const integer=(v:unknown,min=0):v is number=>Number.isSafeInteger(v)&&Number(v)>=min;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const pinMatches=(v:unknown,bytes:Buffer):boolean=>commandObject(v,['bytes','sha256'])&&v.bytes===bytes.length&&v.sha256===wslDigest(bytes);
const processIdentity=(v:unknown):v is Record<string,unknown>=>commandObject(v,['pid','ppid','startTicks'])&&integer(v.pid,1)&&integer(v.ppid)&&typeof v.startTicks==='string'&&/^\d+$/u.test(v.startTicks);
const linuxPath=(v:string):string=>/^C:\\/iu.test(v)?'/mnt/c/'+v.slice(3).replaceAll('\\','/'):'invalid';
const samePin=(value:unknown,pin:NativeFilePin):boolean=>commandObject(value,['path','bytes','sha256'])&&value.path===pin.path&&value.bytes===pin.bytes&&value.sha256===pin.sha256;

/** Only explicitly registered, reviewed certificates can augment old local evidence.
 * No probe, process, model or command is started when history is reopened. */
export function readWslPrestartRecovery(record:CommandRecord,read:(name:string,max:number)=>Buffer,pins:readonly WslPrestartRecoveryPin[],readPin:(pin:NativeFilePin,max:number)=>Buffer=nativePinned):Readonly<{outcome:CommandDriverOutcome;logs:Readonly<{stdout:Buffer;stderr:Buffer}>}>|null{
  if(record.intent.environment.platform!=='wsl'||record.execution.startedAt!==null||record.execution.runtime!==null||pins.length>32)return null;
  for(const approved of pins)try{
    const pinned=(pin:NativeFilePin,max:number):Buffer=>{const data=readPin(pin,max);if(!integer(pin.bytes,1)||pin.bytes>max||!commandSha(pin.sha256)||data.length!==pin.bytes||wslDigest(data)!==pin.sha256)throw Error('pin');return data;};
    const bytes=pinned(approved.certificate,1024*1024),auditor=pinned(approved.auditor,64*1024),source=pinned(approved.supervisor,128*1024),certificate:unknown=JSON.parse(bytes.toString('utf8'));
    if(!commandObject(certificate,['schema','method','runId','identity','distribution','user','supervisorSha256','auditorSha256','observedAt','bootId','linuxReceipt','driverReceipt','logs','census'])||certificate.schema!=='aaw.command.wsl.prestart-recovery.v1'||certificate.method!=='complete_outer_pid_census'||certificate.runId!==record.execution.runId||!wslIdentityMatches(certificate.identity,record)||certificate.distribution!=='ROCKY9_LLM_LAB'||certificate.user!=='maxwell'||record.intent.environment.wsl.distribution!==certificate.distribution||record.intent.environment.wsl.user!==certificate.user||certificate.supervisorSha256!==wslDigest(source)||certificate.auditorSha256!==wslDigest(auditor)||!date(certificate.observedAt)||typeof certificate.bootId!=='string'||!/^[a-f0-9-]{36}$/u.test(certificate.bootId))continue;
    // NSpid depth alone is relative to /proc. A separately reviewed, pinned Windows
    // direct wsl.exe launch establishes the observer outside the command sandbox.
    pinned(approved.launcher,64*1024);
    const launch:unknown=JSON.parse(pinned(approved.launch,64*1024).toString('utf8'));
    if(!object(launch)||launch.schema!=='aaw.command.wsl.prestart-audit-launch.v1'||launch.platform!=='win32'||launch.executable!=='C:\\Windows\\System32\\wsl.exe'||launch.shell!==false||launch.exitCode!==0||launch.signal!==null||!samePin(launch.launcher,approved.launcher)||!samePin(launch.auditor,approved.auditor)||!samePin(launch.certificate,approved.certificate)||!object(launch.request)||typeof launch.request.path!=='string'||!date(launch.startedAt)||!date(launch.completedAt)||Date.parse(launch.startedAt)>Date.parse(certificate.observedAt)||Date.parse(launch.completedAt)<Date.parse(certificate.observedAt)||!isDeepStrictEqual(launch.argv,['-d','ROCKY9_LLM_LAB','-u','maxwell','--exec','/usr/bin/python3','-I',linuxPath(approved.auditor.path),linuxPath(launch.request.path),linuxPath(approved.certificate.path)]))continue;
    const census=certificate.census;
    if(!commandObject(census,['before','after','rows','errors','outerNamespace','auditPid'])||!Array.isArray(census.before)||census.before.length===0||census.before.length>32768||!census.before.every(processIdentity)||!isDeepStrictEqual(census.before,census.after)||!Array.isArray(census.rows)||census.rows.length!==census.before.length||!Array.isArray(census.errors)||census.errors.length!==0||!integer(census.auditPid,1)||typeof census.outerNamespace!=='string'||!/^pid:\[\d+\]$/u.test(census.outerNamespace))continue;
    const identities=census.before as Record<string,unknown>[];
    if(new Set(identities.map(p=>p.pid)).size!==identities.length||!identities.some(p=>p.pid===census.auditPid))continue;
    const flags=['executionMentioned','nonceMentioned','privateWorkMentioned','supervisorIdentityMatch','bubblewrap','supervisorSourceMentioned'];
    if(!census.rows.every((row,index)=>commandObject(row,['pid','ppid','startTicks','nspidDepth','sameOuterNamespace',...flags])&&row.pid===identities[index]!.pid&&row.ppid===identities[index]!.ppid&&row.startTicks===identities[index]!.startTicks&&row.nspidDepth===1&&(row.sameOuterNamespace===true||row.sameOuterNamespace===null)&&flags.every(k=>row[k]===false)))continue;
    const raw=read('wsl-linux-result.json',L.recordBytes),terminal=parseWslTerminal(JSON.parse(raw.toString('utf8')),record),driverRaw=read('wsl-driver-result.json',L.recordBytes),driver:unknown=JSON.parse(driverRaw.toString('utf8'));
    const life=terminal.lifecycle;
    if(!pinMatches(certificate.linuxReceipt,raw)||!pinMatches(certificate.driverReceipt,driverRaw)||Date.parse(certificate.observedAt)<Date.parse(terminal.completedAt)||terminal.startedAt!==null||terminal.cleanupConfirmed||terminal.exit.shellExited||terminal.exit.shellExitCode!==null||life.namespacePid!==null||life.namespaceStartTicks!==null||life.namespaceInode!==null||life.namespaceProcessesRemaining!==null||life.namespaceInitReaped||terminal.error?.code!=='WSL_CLEANUP_UNCONFIRMED'||terminal.exported.length||terminal.deleted.length)continue;
    if(!commandObject(driver,['receipt','snapshot'])||!isDeepStrictEqual(driver.snapshot,terminal)||!object(driver.receipt))continue;
    const receipt=driver.receipt;
    if(receipt.schema!=='aaw.command.wsl.driver-result.v1'||!wslIdentityMatches(receipt.identity,record)||receipt.supervisorSha256!==certificate.supervisorSha256||receipt.linuxResultSha256!==wslDigest(JSON.stringify(terminal))||receipt.wslExited!==true||receipt.wslExitCode!==0||receipt.linuxCleanupConfirmed!==false||receipt.wireFailed!==false||receipt.callbackFailed!==false)continue;
    const logs={stdout:read('wsl-stdout.bin',L.logBytes),stderr:read('wsl-stderr.bin',L.logBytes)};
    const certifiedLogs=certificate.logs;
    if(!commandObject(certifiedLogs,['stdout','stderr'])||!(['stdout','stderr'] as const).every(stream=>{const log=terminal.logs[stream];return pinMatches(certifiedLogs[stream],logs[stream])&&log.coverage==='complete'&&log.eof&&log.observedBytes===logs[stream].length&&log.persistedBytes===logs[stream].length&&log.sha256===wslDigest(logs[stream]);}))continue;
    return {logs,outcome:{exit:terminal.exit,job:{activeProcesses:0,emptyConfirmed:true,observedAt:certificate.observedAt},cleanup:{state:'confirmed',observedAt:certificate.observedAt,proofSha256:wslDigest(bytes)},eof:{stdout:true,stderr:true},logSha256:{stdout:terminal.logs.stdout.sha256,stderr:terminal.logs.stderr.sha256},logMetadata:terminal.logs,error:terminal.error,changes:null,artifactCollection:{scope:'bounded_text_exports',skippedEntries:terminal.skippedFiles}}};
  }catch{/* A damaged/mismatched certificate never clears unknown process state. */}
  return null;
}
