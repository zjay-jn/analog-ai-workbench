import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCommandController} from '../apps/desktop/src/main/agent-command/controller';
import {assertCommandTransition} from '../apps/desktop/src/main/agent-command/state';
import {commandDigest as sha} from '../apps/desktop/src/main/agent-command/logs';
import {commandChangesVersion} from '../apps/desktop/src/main/agent-command/changes';
import {CommandError,type CommandRecord,type CommandRepository,type CommandDriver,type CommandDriverOutcome,type CommandProducedChanges} from '../apps/desktop/src/main/agent-command/types';
import type {WorkCycleBaseline} from '../apps/desktop/src/main/agent-work-cycle/types';
import {COMMAND_LIMITS as L,type CommandEnvironment,type CommandStartArguments} from '../apps/desktop/src/shared/agent/agent-command';
import type {WorkCycleFile} from '../apps/desktop/src/shared/agent/agent-work-cycle';

// No filesystem or process. The workspace stand-in changes its manifest hash on every
// publish/confirm, reproducing the old empty-receipt invalidation rather than fixing a hash.
const hash=sha('environment'),empty=sha(''),tick=()=>new Promise<void>(r=>setImmediate(r));
const env:CommandEnvironment={environmentId:'synthetic-env',revision:hash,displayName:'Synthetic only',platform:'windows',shell:{kind:'powershell',version:'synthetic',sha256:hash,scriptEncoding:'utf8_bom',interactive:false},tools:[],isolation:'windows-appcontainer-job',profileRevision:hash,availability:'ready',reason:null,projectAccess:'none',baselineAccess:'read_only',workAccess:'execution_copy',network:'denied',hostEnvironment:'not_inherited',packageInstallation:'unsupported',executableScope:'appcontainer_os_acl',survivesAppClose:false,limits:{processes:8,logBytes:L.logBytes,defaultTimeoutMs:120000,maxTimeoutMs:600000}};
function fixture(){
 const rows=new Map<string,CommandRecord>();let manifest={revision:0,receipts:0},starts=0,publishes=0,confirms=0,failTerminal=false,exportFailure=false,exportOverride:Partial<WorkCycleBaseline>={};
 const initialFile:WorkCycleFile={fileId:'input-file',relativePath:'input.txt',version:sha('input'),bytes:5,confirmation:'confirmed',origin:{kind:'write',changeId:'initial'}};
 const exportBaseline=async():Promise<WorkCycleBaseline>=>{if(exportFailure)throw new CommandError('STORAGE_FAILED');return {runId:'run',workspaceId:'workspace',version:sha(JSON.stringify(manifest)),files:[{file:initialFile,bytes:Buffer.from('input')}],...exportOverride};};
 const repository:CommandRepository={load:()=>structuredClone([...rows.values()]),create(r){rows.set(r.execution.executionId,structuredClone(r));},save(old,next){assertCommandTransition(old,next);assert.deepEqual(rows.get(old.execution.executionId),old);if(failTerminal&&next.execution.phase==='terminal')throw new CommandError('STORAGE_FAILED');rows.set(next.execution.executionId,structuredClone(next));},writeChunk(){assert.fail('no output bytes');},readChunk(){assert.fail('no output bytes');},close(){}};
 const handles=new Map<string,{baseline:WorkCycleBaseline;finish:(o:CommandDriverOutcome)=>void}>(),stops:string[]=[];
 const driver:CommandDriver={environment:env,async start(record,baseline,callbacks){starts++;await callbacks.started(new Date().toISOString());let finish!:(o:CommandDriverOutcome)=>void;const done=new Promise<CommandDriverOutcome>(r=>{finish=r;});handles.set(record.execution.executionId,{baseline,finish});return{done,stop(reason){stops.push(reason);}};}};
 const workspace={async publishCommandArtifacts(id:string,changes:CommandProducedChanges){publishes++;manifest={revision:manifest.revision+1,receipts:manifest.receipts+1};return changes.files.map((f,i)=>({fileId:id+'-artifact-'+i,relativePath:'artifacts/'+id+'/'+f.relativePath,version:f.version,bytes:f.bytes.length,confirmation:'unconfirmed' as const,origin:{kind:'command' as const,executionId:id,manifestVersion:changes.manifestVersion,sourceRelativePath:f.relativePath}}));},async confirmCommandArtifacts(id:string,version:string){confirms++;manifest={...manifest,revision:manifest.revision+1};return rows.get(id)!.execution.artifacts.map(a=>({fileId:a.fileId,relativePath:'artifacts/'+id+'/out.txt',version:a.version,bytes:3,confirmation:'confirmed' as const,origin:{kind:'command' as const,executionId:id,manifestVersion:version,sourceRelativePath:'out.txt'}}));}};
 const options={runId:'run',workspaceId:'workspace',repository,drivers:[driver],workspace,exportBaseline};const controller=createCommandController(options);
 const args=(version:string,requestId=randomUUID()):CommandStartArguments=>({requestId,environmentId:env.environmentId,environmentRevision:hash,workspaceId:'workspace',baselineVersion:version,cwdRelativePath:'',commandText:'synthetic noop',timeoutMs:120000});
 async function finish(id:string,delta:Partial<Pick<CommandProducedChanges,'files'|'deleted'>>={},overrides:Partial<CommandDriverOutcome>={}){
  for(let i=0;i<10&&!handles.has(id);i++)await tick();const h=handles.get(id)!;assert(h);
  const changes={baselineVersion:h.baseline.version,files:delta.files??[],deleted:delta.deleted??[]},at=new Date().toISOString();
  h.finish({exit:{shellExitCode:0,shellExited:true,observedAt:at,termination:'exited'},job:{activeProcesses:0,emptyConfirmed:true,observedAt:at},cleanup:{state:'confirmed',observedAt:at,proofSha256:hash},eof:{stdout:true,stderr:true},logSha256:{stdout:empty,stderr:empty},error:null,changes:{...changes,manifestVersion:commandChangesVersion(changes)},artifactCollection:{scope:'bounded_text_exports',skippedEntries:2},...overrides});
  for(let i=0;i<12;i++){await tick();const p=rows.get(id)!.execution.phase;if(p==='terminal'||p==='reconciliation_required'||stops.length)break;}
 }
 return {controller,rows,args,finish,exportBaseline,manifest:()=>JSON.stringify(manifest),counts:()=>({starts,publishes,confirms}),stops,
  faultExport(value:Partial<WorkCycleBaseline>){exportOverride=value;},failExport(){exportFailure=true;},failTerminal(){failTerminal=true;},mutate(){manifest={...manifest,revision:manifest.revision+1};},
  cold:(readOnly=true)=>createCommandController({...options,readOnly})};
}
const conflict=(e:unknown)=>e instanceof CommandError&&e.code==='CONFLICT';

test('empty deltas preserve manifest bytes across two commands and cold exact retries never launch',async()=>{
 const f=fixture(),inspected=await f.controller.inspect(),version=inspected.workspace!.baselineVersion,before=f.manifest(),firstArgs=f.args(version),first=await f.controller.start(firstArgs);
 await f.finish(first.executionId);const one=f.rows.get(first.executionId)!.execution;assert.equal(one.phase,'terminal');assert.equal(one.changes.count,0);assert.equal(one.changes.state,'verified');assert.equal(one.artifactCollection?.skippedEntries,2);assert.equal(f.manifest(),before);
 const secondArgs=f.args(version),second=await f.controller.start(secondArgs);await f.finish(second.executionId);assert.equal(f.manifest(),before);assert.deepEqual(f.counts(),{starts:2,publishes:0,confirms:0});
 assert.deepEqual(await f.controller.start(firstArgs),one);await assert.rejects(f.controller.start({...firstArgs,commandText:'different'}),conflict);await f.controller.close('shutdown');
 const cold=f.cold();assert.deepEqual(await cold.status({executionId:first.executionId,afterRevision:null,waitMs:0}),one);assert.deepEqual(f.counts(),{starts:2,publishes:0,confirms:0});await assert.rejects(cold.start(firstArgs),e=>e instanceof CommandError&&e.code==='CAPABILITY_DENIED');await cold.close('shutdown');
 // A writable reopened controller also deduplicates an existing intent without launching it.
 const live=f.cold(false);assert.deepEqual(await live.start(firstArgs),one);await assert.rejects(live.start({...firstArgs,commandText:'changed'}),conflict);assert.deepEqual(f.counts(),{starts:2,publishes:0,confirms:0});await live.close('shutdown');
});

test('file or deletion deltas still publish and invalidate the old baseline',async()=>{
 for(const kind of ['file','deleted'] as const){const f=fixture(),version=(await f.exportBaseline()).version,e=await f.controller.start(f.args(version));
  await f.finish(e.executionId,kind==='file'?{files:[{relativePath:'out.txt',beforeVersion:null,version:sha('out'),bytes:Buffer.from('out')}]}:{deleted:[{relativePath:'input.txt',beforeVersion:sha('input')}]});
  assert.equal(f.rows.get(e.executionId)!.execution.changes.count,1);assert.deepEqual(f.counts(),{starts:1,publishes:1,confirms:1});await assert.rejects(f.controller.start(f.args(version)),conflict);await f.controller.close('shutdown');}
});

test('empty delta completion rejects stale or mismatched current identity and failed export',async()=>{
 for(const kind of ['version','runId','workspaceId','export'] as const){const f=fixture(),version=(await f.exportBaseline()).version,e=await f.controller.start(f.args(version));await tick();
  if(kind==='version')f.mutate();else if(kind==='export')f.failExport();else f.faultExport({[kind]:'wrong'});
  await f.finish(e.executionId);assert.equal(f.rows.get(e.executionId)!.execution.phase,'reconciliation_required');assert.notEqual(f.rows.get(e.executionId)!.execution.changes.state,'verified');assert.equal(f.counts().publishes,0);await f.controller.close('shutdown');}
});

test('empty delta does not bypass cleanup, job, delta identity or manifest validation',async()=>{
 for(const kind of ['cleanup','job','baseline','manifest'] as const){const f=fixture(),version=(await f.exportBaseline()).version,e=await f.controller.start(f.args(version)),at=new Date().toISOString(),delta={baselineVersion:version,files:[],deleted:[]};
  const overrides:Partial<CommandDriverOutcome>=kind==='cleanup'?{cleanup:{state:'failed',observedAt:at,proofSha256:null}}:kind==='job'?{job:{activeProcesses:1,emptyConfirmed:false,observedAt:at}}:{changes:{...delta,baselineVersion:kind==='baseline'?hash:version,manifestVersion:kind==='manifest'?hash:commandChangesVersion(delta)}};
  await f.finish(e.executionId,{},overrides);assert.equal(f.rows.get(e.executionId)!.execution.phase,'reconciliation_required');assert.equal(f.counts().publishes,0);await f.controller.close('shutdown');}
});

test('empty terminal storage failure never reports success or writes the workspace',async()=>{
 const f=fixture(),version=(await f.exportBaseline()).version,e=await f.controller.start(f.args(version)),before=f.manifest();f.failTerminal();await f.finish(e.executionId);
 assert.notEqual(f.rows.get(e.executionId)!.execution.phase,'terminal');assert.equal(f.manifest(),before);assert.equal(f.counts().publishes,0);assert(f.stops.includes('storage_failure'));assert.throws(()=>f.controller.list(),e=>e instanceof CommandError&&e.code==='STORAGE_FAILED');await f.controller.close('shutdown');
});
