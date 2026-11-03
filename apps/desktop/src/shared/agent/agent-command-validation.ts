import { COMMAND_LIMITS as L, COMMAND_TOOL_NAMES, type CommandToolName, type CommandToolArguments, type CommandEnvironment, type CommandExecution, type CommandLogPage, type CommandLogSummary, type CommandRuntime, type CommandArtifactCollection } from './agent-command';
import { isWorkCycleRelativePath } from './agent-work-cycle';

const bytes = (v: string): number => new TextEncoder().encode(v).length;
export const commandId = (v: unknown): v is string => typeof v === 'string' && bytes(v) <= L.idBytes && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(v);
export const commandSha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const commandInteger = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
/** Null is an explicit observe-only policy, not an unknown count or a large quota. */
export const commandProcessCount = (v: unknown, limit: number | null, min = 0): v is number => commandInteger(v,min) && (limit === null || v <= limit);
export function commandObject(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length !== keys.length) return false;
  return keys.every(k => { const p = Object.getOwnPropertyDescriptor(v,k); return p?.enumerable && 'value' in p; });
}
export const commandJsonFits = (v: unknown, max: number): boolean => { try { return bytes(JSON.stringify(v)) <= max; } catch { return false; } };
const text = (v: unknown, max: number): v is string => typeof v === 'string' && bytes(v) <= max && !/\p{Surrogate}/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v));
const choice = (v: unknown, list: readonly string[]): boolean => typeof v === 'string' && list.includes(v);
const nullable = (v: unknown, check: (v: unknown) => boolean): boolean => v === null || check(v);
export const commandCwd = (v: unknown): v is string => v === '' || isWorkCycleRelativePath(v) && !v.split('/').some(part => part.startsWith('.'));
export const commandLinuxPath = (v: unknown): v is string => typeof v === 'string' && text(v,1024) && v.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(v) && (v === '/' || v.split('/').slice(1).every(p=>!!p && p !== '.' && p !== '..'));
const wslName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(v);
export function isCommandRuntime(v:unknown):v is CommandRuntime {
  return commandObject(v,['platform','distribution','user','cwd','workDirectory','baselineDirectory']) && v.platform === 'wsl'
    && wslName(v.distribution) && wslName(v.user) && commandLinuxPath(v.cwd) && commandLinuxPath(v.workDirectory) && nullable(v.baselineDirectory,commandLinuxPath);
}
export function isCommandArtifactCollection(v:unknown):v is CommandArtifactCollection {
  return commandObject(v,['scope','skippedEntries']) && v.scope==='bounded_text_exports' && commandInteger(v.skippedEntries);
}
export const isCommandToolName = (v: unknown): v is CommandToolName => typeof v === 'string' && (COMMAND_TOOL_NAMES as readonly string[]).includes(v);
export function parseCommandArguments<K extends CommandToolName>(name: K, value: unknown): CommandToolArguments[K] | null {
  let ok = false;
  switch (name) {
    case 'command_environment': ok = commandObject(value,[]); break;
    case 'command_start': ok = commandObject(value,['requestId','environmentId','environmentRevision','workspaceId','baselineVersion','cwdRelativePath','commandText','timeoutMs'])
      && commandId(value.requestId) && commandId(value.environmentId) && commandSha(value.environmentRevision) && commandId(value.workspaceId) && commandSha(value.baselineVersion)
      && commandCwd(value.cwdRelativePath) && text(value.commandText,L.commandBytes) && value.commandText.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.commandText)
      && commandInteger(value.timeoutMs,1,L.maxTimeoutMs); break;
    case 'command_status': ok = commandObject(value,['executionId','afterRevision','waitMs']) && commandId(value.executionId) && nullable(value.afterRevision,v=>commandInteger(v,1)) && commandInteger(value.waitMs,0,L.statusWaitMs); break;
    case 'command_log': ok = commandObject(value,['executionId','stream','offset','maxBytes','expectedPrefixVersion']) && commandId(value.executionId) && choice(value.stream,['stdout','stderr']) && commandInteger(value.offset,0,L.logBytes) && commandInteger(value.maxBytes,1,L.logPageBytes) && nullable(value.expectedPrefixVersion,commandSha); break;
    case 'command_stop': ok = commandObject(value,['executionId']) && commandId(value.executionId); break;
  }
  return ok && commandJsonFits(value,L.toolResultBytes) ? structuredClone(value) as CommandToolArguments[K] : null;
}
export function isCommandEnvironment(v: unknown): v is CommandEnvironment {
  const hasWsl=!!v && typeof v==='object' && Object.hasOwn(v,'wsl');
  if (!commandObject(v,['environmentId','revision','displayName','platform','shell','tools','isolation','profileRevision','availability','reason','projectAccess','baselineAccess','workAccess','network','hostEnvironment','packageInstallation','executableScope','survivesAppClose','limits',...(hasWsl?['wsl']:[])]) || !commandJsonFits(v,L.environmentBytes)) return false;
  if (!commandId(v.environmentId) || !commandSha(v.revision) || !text(v.displayName,256) || !choice(v.platform,['windows','wsl']) || !commandSha(v.profileRevision)) return false;
  const s = v.shell, b = v.limits;
  if (!(commandObject(s,['kind','version','sha256','scriptEncoding','interactive']) && text(s.version,128) && commandSha(s.sha256) && s.interactive === false
    && Array.isArray(v.tools) && v.tools.length <= 8 && v.tools.every(t=>commandObject(t,['name','version','sha256']) && text(t.name,128) && text(t.version,128) && commandSha(t.sha256))
    && choice(v.availability,['ready','unavailable']) && nullable(v.reason,x=>text(x,1024)) && (v.availability !== 'ready' || v.reason === null)
    && v.workAccess === 'execution_copy' && v.survivesAppClose === false
    && commandObject(b,['processes','logBytes','defaultTimeoutMs','maxTimeoutMs']) && (v.platform==='wsl' && b.processes===null || commandInteger(b.processes,1,L.processes)) && commandInteger(b.logBytes,1,L.logBytes) && commandInteger(b.maxTimeoutMs,1,L.maxTimeoutMs) && commandInteger(b.defaultTimeoutMs,1,Number(b.maxTimeoutMs)))) return false;
  if(v.platform==='windows')return !hasWsl && s.kind==='powershell' && s.scriptEncoding==='utf8_bom' && v.isolation==='windows-appcontainer-job'
    && v.projectAccess==='none' && v.baselineAccess==='read_only' && v.network==='denied' && v.hostEnvironment==='not_inherited' && v.packageInstallation==='unsupported' && v.executableScope==='appcontainer_os_acl';
  const w=v.wsl;
  if(!hasWsl || s.kind!=='bash' || s.scriptEncoding!=='utf8' || !choice(v.isolation,['wsl-user-process-supervisor','wsl-namespace-supervisor','wsl-bubblewrap'])
    || v.projectAccess!=='declared_roots' || v.baselineAccess!=='verified_copy' || v.network!=='inherited' || v.hostEnvironment!=='controlled' || v.packageInstallation!=='not_provided' || v.executableScope!=='wsl_user_permissions'
    || !commandObject(w,['distribution','user','homeDirectory','shellPath','executionRoot','sourceRoots']) || !wslName(w.distribution) || !wslName(w.user)
    || !commandLinuxPath(w.homeDirectory) || !commandLinuxPath(w.shellPath) || w.shellPath==='/' || !commandLinuxPath(w.executionRoot) || w.executionRoot==='/' || !Array.isArray(w.sourceRoots) || w.sourceRoots.length>8)return false;
  return w.sourceRoots.every(r=>commandObject(r,['path','access','enforcement']) && commandLinuxPath(r.path) && choice(r.access,['read_only','read_write']) && choice(r.enforcement,['authorization_only','os_read_only']) && (r.enforcement!=='os_read_only'||r.access==='read_only'))
    && new Set(w.sourceRoots.map(r=>r.path)).size===w.sourceRoots.length;
}
export function isCommandLogSummary(v: unknown): v is CommandLogSummary {
  return commandObject(v,['stream','persistedBytes','observedBytes','prefixVersion','closed','coverage','sha256']) && choice(v.stream,['stdout','stderr']) && commandInteger(v.persistedBytes,0,L.logBytes)
    && commandInteger(v.observedBytes,Number(v.persistedBytes)) && commandSha(v.prefixVersion) && typeof v.closed === 'boolean' && choice(v.coverage,['open','complete','partial_at_limit','incomplete']) && nullable(v.sha256,commandSha)
    && (v.closed ? v.coverage !== 'open' && commandSha(v.sha256) : v.sha256 === null && v.coverage !== 'complete') && (v.coverage !== 'complete' || v.persistedBytes === v.observedBytes);
}
export function isCommandExecution(v: unknown): v is CommandExecution {
  const hasRuntime=!!v && typeof v==='object' && Object.hasOwn(v,'runtime');
  const hasCollection=!!v && typeof v==='object' && Object.hasOwn(v,'artifactCollection');
  if (!commandObject(v,['executionId','runId','workspaceId','requestId','signature','environment','baselineVersion','cwdRelativePath','commandText','commandSha256','scriptSha256','revision','phase','createdAt','deadlineAt','startedAt','completedAt','stopRequested','exit','job','cleanup','logs','artifacts','changes','error',...(hasRuntime?['runtime']:[]),...(hasCollection?['artifactCollection']:[])]) || !commandJsonFits(v,L.toolResultBytes-1024) || hasRuntime && !nullable(v.runtime,isCommandRuntime) || hasCollection && !isCommandArtifactCollection(v.artifactCollection)) return false;
  if(!Array.isArray(v.artifacts)||v.artifacts.length>8||!v.artifacts.every(a=>commandObject(a,['fileId','version'])&&commandId(a.fileId)&&commandSha(a.version))||new Set(v.artifacts.map(a=>a.fileId)).size!==v.artifacts.length)return false;
  if (!['executionId','runId','workspaceId','requestId'].every(k=>commandId(v[k])) || !['signature','baselineVersion','commandSha256','scriptSha256'].every(k=>commandSha(v[k])) || !commandInteger(v.revision,1)) return false;
  if (!commandCwd(v.cwdRelativePath) || !text(v.commandText,L.commandBytes) || !choice(v.phase,['intent','starting','running','settling','terminal','reconciliation_required']) || !date(v.createdAt) || !date(v.deadlineAt) || !nullable(v.startedAt,date) || !nullable(v.completedAt,date)) return false;
  const e=v.environment, s=v.stopRequested, x=v.exit, j=v.job, c=v.cleanup, l=v.logs, a=v.changes, err=v.error;
  if (!commandObject(e,['environmentId','revision','displayName']) || !commandId(e.environmentId) || !commandSha(e.revision) || !text(e.displayName,256)) return false;
  if (s !== null && (!commandObject(s,['reason','requestedAt']) || !choice(s.reason,['user','deadline','log_limit','shutdown','model_finished','storage_failure','engine_failure']) || !date(s.requestedAt))) return false;
  if (x !== null && (!commandObject(x,['shellExitCode','shellExited','observedAt','termination']) || !nullable(x.shellExitCode,z=>commandInteger(z,-4294967295,4294967295)) || typeof x.shellExited !== 'boolean' || !date(x.observedAt) || !choice(x.termination,['exited','failed_start','stopped','timed_out','log_limit','fault']) || x.shellExitCode !== null && !x.shellExited)) return false;
  // Public rows do not contain the frozen limit. Only an observed WSL runtime can
  // carry larger counts; private records and wire parsing also bind the profile.
  const processLimit=hasRuntime && v.runtime!==null && v.startedAt!==null ? null : L.processes;
  if (!commandObject(j,['activeProcesses','emptyConfirmed','observedAt']) || !nullable(j.activeProcesses,z=>commandProcessCount(z,processLimit)) || typeof j.emptyConfirmed !== 'boolean' || !nullable(j.observedAt,date) || j.emptyConfirmed && (j.activeProcesses !== 0 || !date(j.observedAt))) return false;
  if (!commandObject(c,['state','observedAt','proofSha256']) || !choice(c.state,['pending','confirmed','failed']) || !nullable(c.observedAt,date) || !nullable(c.proofSha256,commandSha) || c.state === 'confirmed' && (!j.emptyConfirmed || !date(c.observedAt) || !commandSha(c.proofSha256))) return false;
  if (!commandObject(l,['stdout','stderr']) || !isCommandLogSummary(l.stdout) || !isCommandLogSummary(l.stderr) || l.stdout.stream !== 'stdout' || l.stderr.stream !== 'stderr' || l.stdout.persistedBytes+l.stderr.persistedBytes > L.logBytes) return false;
  if (!commandObject(a,['state','manifestVersion','count','acceptance']) || !choice(a.state,['pending','verified','unavailable']) || !nullable(a.manifestVersion,commandSha) || !nullable(a.count,z=>commandInteger(z,0,64)) || !choice(a.acceptance,['not_requested','pending','confirmed','conflict']) || a.state === 'verified' && (!commandSha(a.manifestVersion) || a.count === null) || a.acceptance === 'confirmed' && a.state !== 'verified') return false;
  if (err !== null && (!commandObject(err,['code','stage','nativeCode']) || typeof err.code !== 'string' || !/^[A-Z0-9_]{1,64}$/u.test(err.code) || !choice(err.stage,['prepare','start','run','log','cleanup','recovery']) || !nullable(err.nativeCode,z=>commandInteger(z,-4294967295,4294967295)))) return false;
  return v.phase !== 'terminal' || date(v.completedAt) && x !== null;
}
export function isCommandLogPage(v: unknown): v is CommandLogPage {
  if (!commandObject(v,['executionId','stream','prefixVersion','offset','endOffset','snapshotBytes','availableBytes','format','data','bytesSha256','nextCursor','streamClosed','coverage','hasNewerBytes']) || !commandJsonFits(v,L.toolResultBytes-1024)) return false;
  if (!commandId(v.executionId) || !choice(v.stream,['stdout','stderr']) || !commandSha(v.prefixVersion) || !commandInteger(v.snapshotBytes,0,L.logBytes) || !commandInteger(v.offset,0,Number(v.snapshotBytes)) || !commandInteger(v.endOffset,Number(v.offset),Math.min(Number(v.snapshotBytes),Number(v.offset)+L.logPageBytes)) || !commandInteger(v.availableBytes,Number(v.snapshotBytes),L.logBytes) || !commandSha(v.bytesSha256)) return false;
  if (!choice(v.format,['utf8','base64']) || !text(v.data,L.toolResultBytes) || typeof v.streamClosed !== 'boolean' || !choice(v.coverage,['open','complete','partial_at_limit','incomplete']) || typeof v.hasNewerBytes !== 'boolean' || v.hasNewerBytes !== (Number(v.availableBytes)>Number(v.snapshotBytes))) return false;
  const length=Number(v.endOffset)-Number(v.offset);
  if(v.format==='utf8'?bytes(v.data)!==length:!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v.data)||v.data.length/4*3-(v.data.endsWith('==')?2:v.data.endsWith('=')?1:0)!==length)return false;
  if(v.streamClosed&&(v.coverage==='open'||v.hasNewerBytes))return false;
  const n = v.nextCursor;
  return Number(v.endOffset) === Number(v.snapshotBytes) ? n === null : commandObject(n,['offset','prefixVersion']) && n.offset === v.endOffset && n.prefixVersion === v.prefixVersion;
}
