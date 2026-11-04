import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {configureRuntimePaths} from '../apps/desktop/src/main/runtime-paths';
import {runtimeComponent, runtimeManifest, runtimeManifestPin} from '../apps/desktop/src/main/runtime-manifest';
import {createWindowsCommandDriver} from '../apps/desktop/src/main/agent-command/windows-driver';
import {createCommandController} from '../apps/desktop/src/main/agent-command/controller';
import {createCommandRepository} from '../apps/desktop/src/main/agent-command/store';
import {createCommandDiagnosticJournal} from '../apps/desktop/src/main/agent-command/diagnostics';
import {commandExecutions, nativeRead} from '../apps/desktop/src/main/agent-command/native-files';
import {isCommandEnvironment} from '../apps/desktop/src/shared/agent/agent-command-validation';
import type {CommandExecution, CommandStream} from '../apps/desktop/src/shared/agent/agent-command';
import type {WorkCycleBaseline} from '../apps/desktop/src/main/agent-work-cycle/types';

async function main(){
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const inputPath=process.argv[2];
if(process.argv.length!==3||!inputPath||!path.isAbsolute(inputPath))throw Error('SMOKE_INPUT_REQUIRED');
const input=JSON.parse(fs.readFileSync(inputPath,'utf8')) as {installationRoot:string;storageRoot:string;directory:string;manifestSha256:string;admissionSha256:string};
const paths=configureRuntimePaths(input);
const relative=path.relative(path.join(paths.runtimeRoot,'verification'),input.directory);
if(!relative||path.isAbsolute(relative)||relative.startsWith('..')||path.dirname(relative)!=='.'||!/^command-[a-f0-9-]{36}$/u.test(relative)||path.join(input.directory,'input.json')!==inputPath)throw Error('SMOKE_DIRECTORY_INVALID');
const proof=runtimeManifestPin();
assert.equal(proof.sha256,input.manifestSha256);
runtimeManifest();
const admissionPin=runtimeComponent('commandAdmission');
assert.equal(admissionPin.sha256,input.admissionSha256);
const admission=JSON.parse(nativeRead(admissionPin.path,admissionPin.bytes).toString('utf8'));
if(admission.schema!=='aaw.command.runtime-admission.v1'||admission.status!=='BUILT_ONLY'||!isCommandEnvironment(admission.environment)||admission.environment.platform!=='windows'||admission.environment.availability!=='ready')throw Error('COMMAND_CANDIDATE_INVALID');
const driver=createWindowsCommandDriver({environment:admission.environment,native:runtimeComponent('commandRunner'),node:runtimeComponent('node'),license:runtimeComponent('nodeLicense'),bootstrap:runtimeComponent('commandBootstrap'),proof:admissionPin});
const runId=randomUUID(),workspaceId=randomUUID();
const baseline:WorkCycleBaseline=Object.freeze({runId,workspaceId,version:digest(JSON.stringify({kind:'runtime-smoke-empty-baseline',runId,workspaceId})),files:[]});
const repository=createCommandRepository({directory:path.join(input.directory,'agent-command','runs',runId),runId,readOnly:false});
const diagnosticDirectory=path.join(paths.dataRoot,'diagnostics',path.basename(input.directory));
const diagnostics=createCommandDiagnosticJournal({directory:diagnosticDirectory,appVersion:'0.1.0-alpha.0'});
const controller=createCommandController({runId,workspaceId,repository,drivers:[driver],exportBaseline:async()=>baseline,diagnostics,
  workspace:{publishCommandArtifacts:async()=>{throw Error('UNEXPECTED_ARTIFACT_PUBLICATION');},confirmCommandArtifacts:async()=>{throw Error('UNEXPECTED_ARTIFACT_CONFIRMATION');}}});
const executions:unknown[]=[];
let failure:Readonly<{name:string;message:string}>|null=null;
let closure:Awaited<ReturnType<typeof controller.close>>|null=null;
async function finished(start:CommandExecution):Promise<CommandExecution>{
  let current=start;
  const deadline=Date.now()+90000;
  while(!['terminal','reconciliation_required'].includes(current.phase)){
    if(Date.now()>deadline)throw Error('SMOKE_COMMAND_TIMEOUT');
    current=await controller.status({executionId:current.executionId,afterRevision:current.revision,waitMs:25000});
  }
  return current;
}
function log(execution:CommandExecution,stream:CommandStream,marker:string):Readonly<{text:string;bytes:number;sha256:string}>{
  const page=controller.log({executionId:execution.executionId,stream,offset:0,maxBytes:16384,expectedPrefixVersion:null});
  const bytes=Buffer.from(page.data,page.format==='base64'?'base64':'utf8');
  assert.equal(page.offset,0);assert.equal(page.endOffset,bytes.length);assert.equal(page.nextCursor,null);
  assert.equal(page.streamClosed,true);assert.equal(page.coverage,'complete');
  assert.equal(page.snapshotBytes,bytes.length);assert.equal(page.availableBytes,bytes.length);
  assert.equal(page.bytesSha256,digest(bytes));assert.equal(execution.logs[stream].sha256,digest(bytes));
  assert.equal(execution.logs[stream].closed,true);assert.equal(execution.logs[stream].coverage,'complete');
  assert.equal(execution.logs[stream].observedBytes,bytes.length);assert.equal(execution.logs[stream].persistedBytes,bytes.length);
  const text=bytes.toString('utf8');assert.equal(text.replaceAll('\r\n','\n'),marker+'\n');
  const native=nativeRead(path.join(commandExecutions(),execution.executionId,'control',stream+'.bin'),65536);
  assert(bytes.equals(native),'Saved controller log must equal native persisted bytes');
  return {text,bytes:bytes.length,sha256:digest(bytes)};
}
try{
  const inspected=await controller.inspect();
  assert.equal(inspected.environments.length,1);assert.equal(inspected.workspace?.files,0);assert.equal(inspected.workspace?.baselineVersion,baseline.version);
  for(const exitCode of [0,7]){
    const stdoutMarker=`AAW_RUNTIME_EXIT${exitCode}_STDOUT`,stderrMarker=`AAW_RUNTIME_EXIT${exitCode}_STDERR`;
    const commandText=`Write-Output '${stdoutMarker}'; [Console]::Error.WriteLine('${stderrMarker}'); exit ${exitCode}`;
    const started=await controller.start({requestId:randomUUID(),environmentId:driver.environment.environmentId,environmentRevision:driver.environment.revision,workspaceId,baselineVersion:baseline.version,cwdRelativePath:'',commandText,timeoutMs:60000});
    const execution=await finished(started);
    assert.equal(execution.phase,'terminal');assert.equal(execution.error,null);
    assert.equal(typeof execution.startedAt,'string');
    assert.equal(execution.exit?.termination,'exited');assert.equal(execution.exit?.shellExited,true);assert.equal(execution.exit?.shellExitCode,exitCode);
    assert.equal(execution.cleanup.state,'confirmed');assert.equal(execution.job.activeProcesses,0);assert.equal(execution.job.emptyConfirmed,true);
    assert.equal(execution.changes.state,'verified');assert.equal(execution.changes.count,0);
    assert.equal(execution.environment.revision,admission.environment.revision);
    const driverProofBytes=nativeRead(path.join(commandExecutions(),execution.executionId,'control','driver-result.json'),512*1024);
    const driverProof=JSON.parse(driverProofBytes.toString('utf8'));
    assert.equal(digest(driverProofBytes),execution.cleanup.proofSha256);
    assert.equal(driverProof.executionId,execution.executionId);assert.equal(driverProof.environmentRevision,execution.environment.revision);
    assert.equal(driverProof.nativeExited,true);assert.equal(driverProof.nativeExitCode,0);assert.equal(driverProof.cleanupConfirmed,true);assert.equal(driverProof.runtimeDisposed,true);assert.equal(driverProof.error,null);
    const nativeBytes=nativeRead(path.join(commandExecutions(),execution.executionId,'control','result.json'),512*1024);
    const native=JSON.parse(nativeBytes.toString('utf8'));
    assert.equal(digest(nativeBytes),driverProof.nativeResultSha256);
    assert.equal(native.schema,'aaw.command.native.result.v1');assert.equal(native.executionId,execution.executionId);
    assert.equal(native.jobClosed,true);assert.equal(native.profileDeleted,true);assert.equal(native.aclRestored,true);
    assert.equal(native.cleanup.state,'confirmed');assert.equal(native.job.activeProcesses,0);assert.equal(native.job.emptyConfirmed,true);
    executions.push({execution,stdout:log(execution,'stdout',stdoutMarker),stderr:log(execution,'stderr',stderrMarker),driverProofSha256:digest(driverProofBytes),nativeResultSha256:digest(nativeBytes),jobClosed:native.jobClosed,profileDeleted:native.profileDeleted,aclRestored:native.aclRestored});
    assert.equal(controller.idle(),true);
  }
}catch(error){failure={name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:'Unknown failure'};}
finally{try{closure=await controller.close('shutdown');}catch(error){failure??={name:'CloseError',message:error instanceof Error?error.message:'Close failed'};}}
const success=failure===null&&executions.length===2&&closure?.hadOutstanding===false&&closure.cleanupConfirmed;
const result={schema:'aaw.desktop-command-smoke/v1',status:success?'PASS':'FAIL',createdAt:new Date().toISOString(),installationRoot:paths.installationRoot,storageRoot:paths.storageRoot,diagnosticDirectory,runId,workspaceId,environmentRevision:admission.environment.revision,manifestSha256:proof.sha256,admissionSha256:admissionPin.sha256,executions,closure,failure,scope:'Two fixed synthetic Windows PowerShell commands, exit0 and expected exit7, each once; no model, project files, WSL, OA or EDA.'};
fs.writeFileSync(path.join(input.directory,'smoke-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,evidence:path.join(input.directory,'smoke-result.json'),executions:executions.length,failure}));
if(!success)process.exitCode=1;
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
