import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECT_READ_LIMITS as L, type ProjectReadBudget, type ProjectReadAccounting, type ProjectReadEvent, type ProjectReadEventData, type ProjectReadRef, type ProjectReadToolArguments, type ProjectReadToolCall, type ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { parseProjectReadEvent } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { createProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { createProjectReadStore, parseProjectReadDisk, recoverProjectReadDisk, type ProjectReadDisk, type ProjectReadStoredRun } from '../apps/desktop/src/main/agent-project-read/store';
import { captureFolderRoot, type FolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadIoBudget, ProjectReadFsError } from '../apps/desktop/src/main/cloud/project-read-files';
import { createProjectReadIndex, ProjectReadIndexError, type ProjectReadListingPage } from '../apps/desktop/src/main/cloud/project-read-index';
import { createProjectReadBroker, type ProjectReadSharedQuota } from '../apps/desktop/src/main/cloud/project-read-broker';

const productRoot=path.resolve('C:/work/analog_ai_workbench');
const testRoot=path.join(productRoot,'.local/prd-native-execution-20261019/caps-tests');
const time='2026-10-19T08:00:00.000Z',model={provider:'deepseek',model:'deepseek-v4-flash'} as const;
const origin={chatSessionId:'00000000-0000-4000-8000-000000000001',turnId:'00000000-0000-4000-8000-000000000002',executionId:'unbounded-execution',inputDigest:'a'.repeat(64)};
const root:FolderRoot={projectId:'project_1',bindingId:'binding_1',root:'Q:\\Synthetic\\Source',chain:[{dev:'1',ino:'10'},{dev:'1',ino:'11'},{dev:'1',ino:'12'}]};
const project:ProjectReadRef={projectId:root.projectId,bindingId:root.bindingId,name:'Synthetic',directoryName:'Source',directorySegments:['Q','Synthetic','Source'],identity:'root_1'};
const bounded:ProjectReadBudget={providerAttempts:L.requests,httpDispatches:L.requests,toolAttempts:L.toolCalls,physicalReadBytes:L.runReadBytes,visitedCandidates:L.runCandidates,contextBytes:L.contextBytes,outputBytes:L.outputBytes,maxOutputTokens:L.maxOutputTokens,deadlineMs:L.deadlineMs,waitMs:L.waitMs};
const zero:ProjectReadAccounting={providerAttempts:0,httpDispatches:0,toolAttempts:0,physicalReadBytes:0,visitedCandidates:0,contextBytes:null};
function fixture(options:{unbounded?:boolean;requests?:number;tools?:number;entries?:number;running?:boolean;chat?:boolean}={}):ProjectReadStoredRun{
  const chat=options.chat!==false,unbounded=options.unbounded!==false,events:ProjectReadEvent[]=[];
  const budget=unbounded?{...bounded,providerAttempts:null,httpDispatches:null,toolAttempts:null}:bounded;
  const add=(type:keyof ProjectReadEventData,data:unknown)=>{
    const e=parseProjectReadEvent({runId:'run_unbounded',sequence:events.length+1,time,type,data});assert.ok(e,`invalid ${type}`);events.push(e);
  };
  add('run.accepted',{project,model,continuedFrom:null,budget,...(chat?{origin}:{})});
  add('run.started',{sessionId:'native_unbounded',engine:'opencode',version:'1.18.17'});
  const requests=options.requests??27,tools=options.tools??70;
  for(let step=1;step<=requests;step++){add('model.step',{step});add('model.response',{request:step,responseModel:model.model,usage:null});}
  const entries=Array.from({length:options.entries??8},(_,i)=>({fileId:`file_${i}`,directoryId:null,parentId:null,name:`document-${i}.txt`,relativePath:`document-${i}.txt`,kind:'file',bytes:8,readability:'readable',version:null}));
  for(let i=0;i<tools;i++){
    const call:ProjectReadToolCall={sessionId:'native_unbounded',messageId:`message_${i}`,callId:`call_${i}`,toolName:'project_list',arguments:{directoryId:null,cursor:null,refresh:false}};
    add('tool.started',call);
    add('tool.completed',{...call,result:{ok:true,value:{kind:'list',phase:'data',snapshotId:'snapshot_1',entries,rules:[],resume:null,coverage:{scope:{projectId:project.projectId,bindingId:project.bindingId,identity:project.identity,directoryId:null,relativeDirectory:''},complete:true,scannedCandidates:entries.length,scannedFiles:0,scannedBytes:0,returned:entries.length,skipped:{policy:0,unsupported:0,fileLimit:0,unavailable:0},remaining:{directories:0,files:0,position:null},nextCursor:null,limitReason:null}}}});
  }
  const accounting={...zero,providerAttempts:requests+2,httpDispatches:requests,toolAttempts:tools,contextBytes:2048};
  add('budget.updated',accounting);
  if(!options.running){add('cleanup.started',{reason:'completed'});add('cleanup.completed',{outcome:'confirmed'});add('run.completed',{citations:[]});}
  return {root,citations:[],run:{runId:'run_unbounded',clientRequestId:'client_unbounded',project,model,goal:'Synthetic long chat',constraint:'',continuedFrom:null,status:options.running?'running':'completed',cleanupState:'idle',createdAt:time,updatedAt:time,accounting,eventCount:events.length,continuation:null,events,...(chat?{origin}:{})}};
}
const disk=(run:ProjectReadStoredRun):ProjectReadDisk=>({version:1,runs:[run]});
function directory(parent=testRoot){const base=path.join(parent,randomUUID());assert.ok(path.resolve(base).startsWith(productRoot+path.sep));fs.mkdirSync(base,{recursive:true});return {base,cleanup(){const resolved=fs.realpathSync.native(base);assert.equal(resolved,base);assert.ok(resolved.startsWith(parent+path.sep));fs.rmSync(resolved,{recursive:true});}};}

test('only accepted chat may explicitly remove total count caps; legacy snapshots remain finite',()=>{
  const snapshots=createProjectReadModelSnapshots({key:()=> 'sk-synthetic_unbounded_1234',defaultModel:()=>model.model,read:()=>({ok:true,value:{storage:'ready',encryptionAvailable:true,providers:[{provider:'deepseek',address:'https://api.deepseek.com',model:model.model,configured:true,maxOutputTokens:8192,timeoutMs:600000,source:'file'}]}})});
  snapshots.select(model);snapshots.freeze('legacy',model);snapshots.freezeChat('chat',model,{maxOutputTokens:8192,timeoutMs:600000});
  assert.equal(snapshots.get('legacy').maxRequests,24);assert.equal(snapshots.get('chat').maxRequests,null);
  const accepted=fixture().run.events[0]!;assert.equal(accepted.type,'run.accepted');
  if(accepted.type!=='run.accepted')return;
  const {origin:_origin,...data}=accepted.data;
  assert.equal(parseProjectReadEvent({...accepted,data}),null);
  assert.equal(parseProjectReadEvent({...accepted,data:{...accepted.data,budget:{...accepted.data.budget,toolAttempts:64}}}),null);
  snapshots.close();
});

test('chat retains actual >24 requests, >25 steps, >64 tools and >96KiB tool history across save/reopen',()=>{
  const value=disk(fixture()),run=value.runs[0]!.run;
  const toolBytes=run.events.reduce((n,e)=>n+(e.type==='tool.completed'?Buffer.byteLength(JSON.stringify(e.data.result)):0),0);
  assert.ok(toolBytes>L.toolContextBytes);assert.ok(Buffer.byteLength(JSON.stringify(value))<L.runBytes);
  assert.ok(parseProjectReadDisk(value));
  const f=directory(path.join(productRoot,'.local/agent-project-read-tests')),location=path.join(f.base,'agent-project-read');
  try{
    const writer=createProjectReadStore(productRoot,location);writer.load();writer.save(value);writer.close();
    const reader=createProjectReadStore(productRoot,location),cold=reader.load();reader.close();
    assert.deepEqual(cold,value);assert.equal(cold.runs[0]!.run.accounting.providerAttempts,29);
    assert.deepEqual(recoverProjectReadDisk(cold,'2026-10-19T08:01:00.000Z'),cold);
    assert.equal(cold.runs[0]!.run.events.filter(e=>e.type==='tool.started').length,70);
  }finally{f.cleanup();}
});

test('legacy and previously bounded chat history keep their original caps; bytes and counter validity stay enforced',()=>{
  assert.ok(parseProjectReadDisk(disk(fixture({unbounded:false,chat:false,requests:2,tools:2}))));
  assert.equal(parseProjectReadDisk(disk(fixture({unbounded:false,requests:27,tools:70}))),null);
  assert.equal(parseProjectReadDisk(disk(fixture({unbounded:false,chat:false,requests:27,tools:70}))),null);
  const value=disk(fixture()),original=value.runs[0]!;
  const bad=disk({...original,run:{...original.run,accounting:{...original.run.accounting,providerAttempts:Number.MAX_SAFE_INTEGER+1}}});
  assert.equal(parseProjectReadDisk(bad),null);
  const large=disk(fixture({requests:1,tools:230,entries:50}));assert.ok(Buffer.byteLength(JSON.stringify(large))>L.runBytes);assert.equal(parseProjectReadDisk(large),null);
});

test('interrupted unbounded history recovers once without tool replay or count loss',()=>{
  const value=disk(fixture({running:true})),cold=recoverProjectReadDisk(value,'2026-10-19T08:01:00.000Z');
  assert.equal(cold.runs[0]!.run.status,'interrupted');
  assert.deepEqual(cold.runs[0]!.run.accounting,value.runs[0]!.run.accounting);
  assert.deepEqual(cold.runs[0]!.run.events.slice(0,value.runs[0]!.run.events.length),value.runs[0]!.run.events);
  assert.equal(cold.runs[0]!.run.events.filter(e=>e.type==='tool.started').length,70);
  assert.deepEqual(recoverProjectReadDisk(cold,'2026-10-19T08:02:00.000Z'),cold);
});

test('ordinary chat broker and directory pagination pass 64 calls, retain idempotency, and preserve legacy denial',async()=>{
  for(const unbounded of [true,false]){
    const f=directory(),source=path.join(f.base,'source');fs.mkdirSync(source);
    const captured=captureFolderRoot(randomUUID(),randomUUID(),source),signal=new AbortController().signal;
    const p={...project,projectId:captured.projectId,bindingId:captured.bindingId,identity:createHash('sha256').update(JSON.stringify(captured)).digest('hex')};
    const index=createProjectReadIndex({root:captured,identity:p.identity,owner:{kind:'run',id:'run_broker'},signal,...(unbounded?{maxRunPages:null}:{})});
    const quota:ProjectReadSharedQuota={toolAttempts:0,toolBytes:0,citations:0,...(unbounded?{maxToolAttempts:null}:{})};let published=0;
    const broker=createProjectReadBroker({root:captured,project:p,runId:'run_broker',signal,index,quota,budget:createProjectReadIoBudget(),authorize:()=>true,publishRule:async()=>{},installRootRule:async()=>{},canDeliver:()=>true,publish:async()=>{published++;}});
    try{
      await broker.prepare();let last:ProjectReadToolCall|undefined,lastResult:ProjectReadToolResult|undefined;
      for(let i=0;i<(unbounded?70:64);i++){last={sessionId:'session',messageId:'message',callId:`call_${i}`,toolName:'project_list',arguments:{directoryId:null,cursor:null,refresh:false}};lastResult=await broker.execute(last);assert.equal(lastResult.ok,true);}
      assert.deepEqual(await broker.execute(last!),lastResult);assert.equal(published,unbounded?70:64);assert.equal(quota.toolAttempts,published);
      if(!unbounded)await assert.rejects(broker.execute({...last!,callId:'call_over'}),e=>e instanceof ProjectReadFsError&&e.code==='BUDGET_EXCEEDED');
      else {for(let i=0;i<70;i++){const result=await broker.execute({sessionId:'session',messageId:'message_sum',callId:`sum_${i}`,toolName:'pilot_sum',arguments:{values:[i,1]}});assert.equal(result.ok,true);}assert.equal(quota.toolAttempts,140);}
    }finally{await broker.close();f.cleanup();}
  }
});

test('conversation listing and finding retain more than 96KiB of paged history while legacy retains its context cap',async()=>{
  const f=directory(),source=path.join(f.base,'source');fs.mkdirSync(source);
  const expected=new Set(Array.from({length:400},(_,i)=>`document-${i}-${'x'.repeat(80)}.txt`));
  for(const name of expected)fs.writeFileSync(path.join(source,name),'synthetic');
  try{
    for(const policy of ['chat','legacy','inspection'] as const)for(const operation of ['list','find'] as const){
      const captured=captureFolderRoot(randomUUID(),randomUUID(),source),signal=new AbortController().signal;
      const index=createProjectReadIndex({root:captured,identity:'history-bytes',owner:{kind:policy==='inspection'?'inspection':'run',id:`index_${policy}_${operation}`},signal,...(policy==='chat'?{maxRunPages:null}:{})});
      const found=new Set<string>();let cursor:string|null=null,reachedBudget=false;
      try{
        do{
          try{
            const args:ProjectReadToolArguments['project_list']={directoryId:null,cursor,refresh:false};
            const result:ProjectReadListingPage=operation==='list'?await index.list(args):await index.find({...args,query:'document-'});
            assert.ok(Buffer.byteLength(JSON.stringify({ok:true,value:result}))<=L.toolResultBytes);
            for(const entry of result.entries){assert.equal(found.has(entry.name),false);found.add(entry.name);}
            cursor=result.coverage.nextCursor;
            if(cursor===null)assert.equal(result.coverage.complete,true);
          }catch(error){
            assert.ok(error instanceof ProjectReadIndexError);assert.equal(error.code,'BUDGET_EXCEEDED');
            assert.equal(error.coverage?.complete,false);assert.equal(error.coverage?.limitReason,'context');reachedBudget=true;break;
          }
        }while(cursor!==null);
        const accounting=index.accounting();
        if(policy==='legacy'){
          assert.equal(reachedBudget,true);assert.ok(found.size>0&&found.size<expected.size);
          assert.ok(accounting.returnedBytes<=L.toolContextBytes);assert.ok(accounting.pages<L.toolCalls);
        }else{
          assert.equal(reachedBudget,false);assert.deepEqual(found,expected);
          assert.ok(accounting.returnedBytes>L.toolContextBytes);assert.ok(accounting.returnedBytes<L.runBytes);
        }
      }finally{await index.dispose();}
    }
  }finally{f.cleanup();}
});
