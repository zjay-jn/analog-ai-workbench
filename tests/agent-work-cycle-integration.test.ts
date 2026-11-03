import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AGENT_PROJECT_READ_VERSION as V, PROJECT_READ_LIMITS as P, type ProjectReadToolCall, type ProjectReadToolName, type ProjectReadToolResult } from '../apps/desktop/src/shared/agent/agent-project-read';
import { createProjectReadHost } from '../apps/desktop/src/main/agent-project-read/host';
import { createProjectReadStore } from '../apps/desktop/src/main/agent-project-read/store';
import { createAgentRuntimeArbiter } from '../apps/desktop/src/main/agent-project-read/runtime-arbiter';
import { createWorkCycleWorkspace } from '../apps/desktop/src/main/agent-work-cycle/workspace';
import { WorkCycleError, type WorkCycleRunner, type WorkCycleWorkspaceFactory } from '../apps/desktop/src/main/agent-work-cycle/types';
import type { ProjectReadEngine, ProjectReadEngineInput } from '../apps/desktop/src/main/agent-project-read/engine';
import type { ProjectReadModelSnapshots } from '../apps/desktop/src/main/agent-project-read/runtime';
import { captureFolderRoot } from '../apps/desktop/src/main/cloud/project-folder-files';
import { createProjectReadProviderServices } from '../apps/desktop/src/main/agent-project-read/provider-gateway';
import { projectReadTools, validateProjectReadNativeTools, parseProjectReadSse } from '../apps/desktop/src/main/agent-project-read/protocol';
import { parseProjectReadToolArguments, parseProjectReadEvent, parseProjectReadResult, projectReadFitsJsonBudget } from '../apps/desktop/src/shared/agent/agent-project-read-validation';
import { WORK_CYCLE_LIMITS as W } from '../apps/desktop/src/shared/agent/agent-work-cycle';
import { createOpenCodePilotClient } from '../apps/desktop/src/main/engine-pilot/opencode-client';

const product = 'C:/work/analog_ai_workbench', parent = path.resolve(product,'.local/agent-project-read-tests');
const model = {provider:'deepseek',model:'deepseek-v4-flash'} as const;
// Frozen capabilities: original six + three skill, two WSL text and three waveform tools.
const readToolNames = ['skill_discover','skill_load','skill_read_reference','project_list','project_find','project_search','project_read','pilot_sum','question','wsl_results_list','wsl_results_read','wsl_waveform_list','wsl_waveform_read','wsl_waveform_metrics'] as const;
const workOnlyToolNames = ['work_list','work_read','work_write','work_edit','work_import','work_run','command_environment','command_start','command_status','command_log','command_stop'] as const;
const workToolNames = [...readToolNames,...workOnlyToolNames];
const nativeReadPermissions = ['pilot_sum','question','project_list','project_find','project_search','project_read','wsl_results_list','wsl_results_read','wsl_waveform_list','wsl_waveform_read','wsl_waveform_metrics','skill_discover','skill_load','skill_read_reference'] as const;
const toolNames = (tools:readonly unknown[])=>tools.map(t=>(t as {function:{name:string}}).function.name);
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const ok = <T>(value: {ok:true;value:T}|{ok:false;error:unknown}): T => value.ok ? value.value : assert.fail(JSON.stringify(value));
function fixture() {
  const base = path.join(parent,randomUUID()), source = path.join(base,'source'); fs.mkdirSync(source,{recursive:true});
  const root = captureFolderRoot(randomUUID(),randomUUID(),source);
  return {base,source,root,remove(){const resolved=fs.realpathSync.native(base);assert.equal(resolved,base);assert.match(path.relative(parent,resolved),/^[0-9a-f-]{36}$/u);fs.rmSync(resolved,{recursive:true});}};
}
function harness(f: ReturnType<typeof fixture>, action: (input:ProjectReadEngineInput)=>Promise<void>, factory:WorkCycleWorkspaceFactory=createWorkCycleWorkspace) {
  const arbiter=createAgentRuntimeArbiter(), store=createProjectReadStore(product,path.join(f.base,'agent-project-read'));
  let starts=0, executions=0;
  const models:ProjectReadModelSnapshots={status:()=>({model,canStart:true,reason:null}),freeze:()=>model,get:()=>({apiKey:'synthetic-only',model,maxRequests:24,maxOutputTokens:16384,requestTimeoutMs:600000}),forget(){},close(){}};
  const runner:WorkCycleRunner={available:()=>({available:true,language:'javascript',isolation:'windows-appcontainer'}),async run(){executions++;throw Error('This integration test must not execute a program');},async close(){}};
  const engine:ProjectReadEngine={status:()=>({model,canStart:true,processState:'ready',reason:null}),health:async()=>true,accept:()=>model,canDeliver:()=>true,accounting:()=>({providerAttempts:0,httpDispatches:0,contextBytes:0}),
    async start(input){starts++;input.callbacks.notice({type:'started',sessionId:'integration-session'});input.callbacks.notice({type:'step',step:1,usage:null});await action(input);if(!input.signal.aborted)input.callbacks.notice({type:'completed'});},answer:async()=>{},stop:async()=>{},dispose(){},shutdown:async()=>{}};
  const host=createProjectReadHost({store,arbiter,models,bindings:{snapshotBinding:()=>({ok:true,value:{folder:f.root,name:'Synthetic integration'}})},createEngine:()=>engine,
    workCycle:{directory:path.join(f.base,'agent-work-cycle','workspaces'),createWorkspace:factory,createRunner:()=>runner}});
  const request={contractVersion:V,projectId:f.root.projectId,bindingId:f.root.bindingId,clientRequestId:randomUUID(),model,goal:'Synthetic integration',constraint:'',continuedFrom:null};
  return {host,store,request,counts:()=>({starts,executions}),async wait(){const deadline=performance.now()+5000;while(performance.now()<deadline){const run=store.load().runs.at(-1)?.run;if(run&&['completed','failed'].includes(run.status)&&run.cleanupState==='idle')return run;await new Promise(r=>setTimeout(r,5));}return assert.fail('bounded host completion timeout');},async close(){host.revoke();await host.shutdown();await arbiter.close();store.close();}};
}
function call(input:ProjectReadEngineInput,name:ProjectReadToolName,args:unknown,callId=randomUUID()):Promise<ProjectReadToolResult>{return input.callbacks.tool({sessionId:'integration-session',messageId:'message',callId,toolName:name,arguments:args} as ProjectReadToolCall);}

test('work confirm failure stops host; actual workspace inspection and cold reopen retain unconfirmed, without replay',async()=>{
  const f=fixture();let thrown=false;
  const factory:WorkCycleWorkspaceFactory=async options=>{const workspace=await createWorkCycleWorkspace(options);return {...workspace,async confirm(){throw new WorkCycleError('STORAGE_FAILED');}};};
  const h=harness(f,async input=>{await assert.rejects(call(input,'work_write',{relativePath:'report.md',expectedVersion:null,text:'Saved bytes need ledger confirmation.'}));thrown=true;await assert.rejects(call(input,'work_write',{relativePath:'must-not-exist.md',expectedVersion:null,text:'no'}));},factory);
  let runId='';
  try{
    runId=ok(await h.host.invoke('startWorkRun',h.request,()=>true)).runId;const run=await h.wait();assert.equal(run.status,'failed');assert.ok(thrown,JSON.stringify(run.events));assert.deepEqual(h.counts(),{starts:1,executions:0});
    const files=ok(await h.host.invoke('listWorkFiles',{contractVersion:V,runId},()=>true)).files;assert.equal(files.length,1);assert.equal(files[0]!.confirmation,'unconfirmed');
    const text=ok(await h.host.invoke('readWorkFile',{contractVersion:V,runId,fileId:files[0]!.fileId,version:files[0]!.version},()=>true));assert.equal(text.file.confirmation,'unconfirmed');assert.equal(text.text,'Saved bytes need ledger confirmation.');
    const completed=run.events.find(e=>e.type==='tool.completed');assert.ok(completed,'historical commit can precede failed confirmation; inspector must not infer success from it');
  }finally{await h.close();}
  const reopened=harness(f,async()=>assert.fail('history must not restart the engine'));
  try{const before=fs.readFileSync(path.join(f.base,'agent-project-read','runs.json'));const files=ok(await reopened.host.invoke('listWorkFiles',{contractVersion:V,runId},()=>true)).files;assert.equal(files[0]!.confirmation,'unconfirmed');assert.deepEqual(reopened.counts(),{starts:0,executions:0});assert.deepEqual(fs.readFileSync(path.join(f.base,'agent-project-read','runs.json')),before);}finally{await reopened.close();f.remove();}
});

test('host imports the exact signed UTF-8 source bytes and rejects a changed source version',async()=>{
  const f=fixture(), raw=Buffer.from('\ufeffname,value\r\na,2\r\nb,3\r\n','utf8');fs.writeFileSync(path.join(f.source,'data.csv'),raw);let importedId='',version='';
  const h=harness(f,async input=>{
    const found=ok(await call(input,'project_find',{directoryId:null,query:'data.csv',cursor:null,refresh:false}));assert.equal(found.kind,'find');if(found.kind!=='find')return;
    const fileId=found.entries[0]!.fileId!;const read=ok(await call(input,'project_read',{fileId,version:null,start:{line:1,column:1},cursor:null}));assert.equal(read.kind,'read');if(read.kind!=='read'||!read.citation)return assert.fail('verified input version required');
    version=read.citation.version;assert.equal(version,sha(raw));
    const imported=ok(await call(input,'work_import',{fileId,version,relativePath:'input.csv',expectedVersion:null}));assert.equal(imported.kind,'work_import');if(imported.kind!=='work_import')return;
    importedId=imported.file.fileId;assert.equal(imported.file.origin.kind,'import');assert.equal(imported.file.version,version);
    const fragment=ok(await call(input,'work_read',{fileId:importedId,version,offset:0}));assert.equal(fragment.kind,'work_read');if(fragment.kind!=='work_read')return;assert.deepEqual(Buffer.from(fragment.text,'utf8'),raw);
    fs.writeFileSync(path.join(f.source,'data.csv'),'name,value\r\na,99\r\n');const changed=await call(input,'work_import',{fileId,version,relativePath:'changed.csv',expectedVersion:null});assert.equal(changed.ok,false);if(!changed.ok)assert.equal(changed.error.code,'SOURCE_CHANGED');
  });
  try{const {runId}=ok(await h.host.invoke('startWorkRun',h.request,()=>true));assert.equal((await h.wait()).status,'completed');const read=ok(await h.host.invoke('readWorkFile',{contractVersion:V,runId,fileId:importedId,version},()=>true));assert.deepEqual(Buffer.from(read.text,'utf8'),raw);assert.equal(read.file.confirmation,'confirmed');assert.equal(ok(await h.host.invoke('listWorkFiles',{contractVersion:V,runId},()=>true)).files.length,1);assert.equal(h.counts().executions,0);}finally{await h.close();f.remove();}
});

test('read-only gateway keeps the exact fourteen-tool registry and rejects a work call before host delivery',async()=>{
  assert.equal(projectReadTools().length,14);assert.deepEqual(toolNames(projectReadTools()),readToolNames);
  assert.equal(projectReadTools(true).length,25);assert.deepEqual(toolNames(projectReadTools(true)),workToolNames);
  assert.throws(()=>validateProjectReadNativeTools(projectReadTools(true)));validateProjectReadNativeTools(projectReadTools(true),true);
  let tools=0;const wire='data: '+JSON.stringify({id:'denied',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'w',type:'function',function:{name:'work_edit',arguments:JSON.stringify({fileId:'issued-file',expectedVersion:sha('1'),oldText:'1',newText:'2'})}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n';
  const service=await createProjectReadProviderServices({getRunCredentials:()=>({apiKey:'synthetic-only',model,maxRequests:1,maxOutputTokens:100,requestTimeoutMs:1000}),onResponse(){},fetchImpl:async()=>new Response(wire,{headers:{'Content-Type':'text/event-stream'}})});
  try{service.begin({runId:'readonly',goal:'read',constraint:'',systemText:'Read only.',initialUserText:'read',onTool:async()=>{tools++;return {ok:false,error:{code:'CAPABILITY_DENIED'},coverage:null};},onFailure(){}}).bindSession('s');const response=await fetch(`http://127.0.0.1:${service.port}/v1/chat/completions`,{method:'POST',headers:{Authorization:'Bearer '+service.providerToken,'Content-Type':'application/json'},body:JSON.stringify({model:model.model,stream:true,tools:projectReadTools(),messages:[{role:'user',content:'read'}]})});assert.notEqual(response.status,200);assert.equal(tools,0);}finally{await service.close();}
});

test('native session capability recipe matches the chosen read or work profile before prompt submission',async()=>{
  for(const profile of ['project-read','work-cycle'] as const){
    let permission: {permission:string;pattern:string;action:string}[]=[];
    const client=createOpenCodePilotClient({profile,port:12345,password:'a'.repeat(64),directory:path.join(product,'.local','agent-engine-pilot','synthetic','cwd'),
      async fetchImpl(url,init){
        if(url.endsWith('/session')){permission=JSON.parse(String(init.body)).permission;return new Response(JSON.stringify({id:'session-one'}),{headers:{'Content-Type':'application/json'}});}
        assert.ok(url.endsWith('/session/session-one/prompt_async'));return new Response(null,{status:204});
      }});
    try{const id=await client.createSession();assert.equal(permission[0]!.permission,'*');assert.equal(permission[0]!.action,'deny');assert.equal(permission.length,profile==='work-cycle'?26:15);
      const allowed=[...nativeReadPermissions,...(profile==='work-cycle'?workOnlyToolNames:[])];
      assert.deepEqual(permission,[{permission:'*',pattern:'*',action:'deny'},...allowed.map(name=>({permission:name,pattern:'*',action:'allow'}))]);
      assert.equal(permission.some(p=>p.permission==='work_run'),profile==='work-cycle');assert.equal(permission.some(p=>p.permission==='work_edit'),profile==='work-cycle');assert.equal(permission.some(p=>['bash','shell','write','edit'].includes(p.permission)),false);await client.prompt(id,{rules:'main owns scope',goal:'test',constraint:'',initialUserText:'test'});}finally{client.dispose();}
  }
});

test('work_edit admission binds UTF-8 pair budget and completed result identity without widening work_write',()=>{
  const args={fileId:'file-edit',expectedVersion:sha('before'),oldText:'旧\r\n',newText:'新\r\n'};
  assert.deepEqual(parseProjectReadToolArguments('work_edit',args),args);
  assert.ok(parseProjectReadToolArguments('work_edit',{...args,oldText:' ',newText:''}));
  assert.ok(parseProjectReadToolArguments('work_edit',{...args,oldText:'x'.repeat(W.editBytes),newText:''}));
  for(const invalid of [
    {...args,oldText:''},{...args,expectedVersion:null},{...args,oldText:'\ud800'},
    {...args,oldText:'中'.repeat(1366),newText:'中'.repeat(1365)},
    {...args,relativePath:'script.js'},{...args,replaceAll:true},
  ])assert.equal(parseProjectReadToolArguments('work_edit',invalid),null);
  assert.equal(parseProjectReadToolArguments('work_write',{relativePath:'script.js',expectedVersion:args.expectedVersion,text:'x'.repeat(W.writeBytes+1)}),null);
  const file={fileId:args.fileId,relativePath:'script.js',version:sha('after'),bytes:5,confirmation:'confirmed',origin:{kind:'write',changeId:'change-edit'}};
  const event={runId:'run-edit',sequence:2,time:'2026-09-13T12:00:00.000Z',type:'tool.completed',
    data:{sessionId:'session-edit',messageId:'message-edit',callId:'call-edit',toolName:'work_edit',arguments:args,
      result:{ok:true,value:{kind:'work_edit',file,previousVersion:args.expectedVersion,changeId:'change-edit',changed:true}}}};
  assert.ok(parseProjectReadEvent(event));
  for(const patch of [{previousVersion:null},{previousVersion:sha('foreign')},{changed:false},
    {file:{...file,fileId:'other-file'}},{file:{...file,version:args.expectedVersion}},{file:{...file,origin:{kind:'write',changeId:'other-change'}}}])
    assert.equal(parseProjectReadEvent({...event,data:{...event.data,result:{ok:true,value:{...event.data.result.value,...patch}}}}),null);
});

test('work_edit exposes complete maximum-size escaped before/after only through its bounded inspector envelope',()=>{
  const before='\\\n"\t'.repeat(W.fileBytes/4),after=before.slice(0,-1)+'\r';
  assert.equal(Buffer.byteLength(before),W.fileBytes);assert.equal(Buffer.byteLength(after),W.fileBytes);
  const file={fileId:'f'.repeat(P.idBytes),relativePath:'a'.repeat(W.relativePathBytes-3)+'.js',version:sha(after),bytes:W.fileBytes,confirmation:'confirmed',origin:{kind:'write',changeId:'c'.repeat(P.idBytes)}};
  const value={changeId:file.origin.changeId,file,previousVersion:sha(before),before,after,changed:true},envelope={ok:true,value};
  assert.ok(Buffer.byteLength(JSON.stringify(envelope))>P.eventPageBytes);
  assert.equal(projectReadFitsJsonBudget(envelope,P.eventPageBytes),false);
  assert.ok(projectReadFitsJsonBudget(envelope,W.inspectorBytes));
  assert.deepEqual(parseProjectReadResult('readWorkChange',envelope),envelope);
  assert.equal(parseProjectReadResult('readWorkChange',{ok:true,value:{...value,after:after+'x'}}),null);
  assert.equal(parseProjectReadResult('readWorkChange',{...envelope,extra:'x'.repeat(W.inspectorBytes)}),null);
  assert.equal(W.writeBytes,8192);assert.equal(W.fileBytes,65536);assert.equal(W.eventBytes,49152);
});

test('work_edit host imports a large raw script, preserves other bytes, returns exact diff and cold history without replay',async()=>{
  const f=fixture(),oldText='const target = 17;\r\n',newText='const target = 29;\r\n';
  const raw=Buffer.from('\ufeff'+('// padding 中文 \r\n'.repeat(650))+oldText+'// end\r\n');
  assert.ok(raw.length>W.writeBytes&&raw.length<W.fileBytes);
  fs.writeFileSync(path.join(f.source,'large.js'),raw);
  const expected=Buffer.concat([raw.subarray(0,raw.indexOf(Buffer.from(oldText))),Buffer.from(newText),raw.subarray(raw.indexOf(Buffer.from(oldText))+Buffer.byteLength(oldText))]);
  let fileId='',changeId='',runId='';
  const h=harness(f,async input=>{
    const found=ok(await call(input,'project_find',{directoryId:null,query:'large.js',cursor:null,refresh:false}));
    assert.equal(found.kind,'find');if(found.kind!=='find')return;
    const sourceId=found.entries[0]!.fileId!,read=ok(await call(input,'project_read',{fileId:sourceId,version:null,start:{line:1,column:1},cursor:null}));
    assert.equal(read.kind,'read');if(read.kind!=='read'||!read.citation)return assert.fail('source verification required');
    const imported=ok(await call(input,'work_import',{fileId:sourceId,version:read.citation.version,relativePath:'large.js',expectedVersion:null}));
    assert.equal(imported.kind,'work_import');if(imported.kind!=='work_import')return;fileId=imported.file.fileId;
    const args={fileId,expectedVersion:imported.file.version,oldText,newText},callId=randomUUID(),result=await call(input,'work_edit',args,callId),edited=ok(result);
    assert.equal(edited.kind,'work_edit');if(edited.kind!=='work_edit')return;
    changeId=edited.changeId;assert.equal(edited.file.version,sha(expected));assert.equal(edited.previousVersion,sha(raw));
    assert.equal(edited.file.confirmation,'confirmed');assert.equal(edited.file.origin.kind,'write');
    assert.deepEqual(await call(input,'work_edit',args,callId),result);
    const stale=await call(input,'work_edit',args);assert.equal(stale.ok,false);if(!stale.ok)assert.equal(stale.error.code,'CONFLICT');
    const current=ok(await call(input,'work_read',{fileId,version:edited.file.version,offset:raw.indexOf(Buffer.from(oldText))}));
    assert.equal(current.kind,'work_read');if(current.kind==='work_read')assert.ok(current.text.startsWith(newText));
  });
  try{
    runId=ok(await h.host.invoke('startWorkRun',h.request,()=>true)).runId;const run=await h.wait();assert.equal(run.status,'completed');
    const diff=ok(await h.host.invoke('readWorkChange',{contractVersion:V,runId,changeId},()=>true));
    assert.deepEqual(Buffer.from(diff.before!,'utf8'),raw);assert.deepEqual(Buffer.from(diff.after,'utf8'),expected);
    assert.deepEqual(fs.readFileSync(path.join(f.source,'large.js')),raw);
    assert.equal(run.events.filter(e=>e.type==='tool.completed'&&e.data.toolName==='work_edit'&&e.data.result.ok).length,1);
    assert.deepEqual(h.counts(),{starts:1,executions:0});
  }finally{await h.close();}
  const reopened=harness(f,async()=>assert.fail('history must not restart engine'));
  try{
    const ledger=fs.readFileSync(path.join(f.base,'agent-project-read','runs.json'));
    const diff=ok(await reopened.host.invoke('readWorkChange',{contractVersion:V,runId,changeId},()=>true));
    assert.equal(diff.file.confirmation,'confirmed');assert.deepEqual(Buffer.from(diff.after),expected);
    assert.deepEqual(reopened.counts(),{starts:0,executions:0});assert.deepEqual(fs.readFileSync(path.join(f.base,'agent-project-read','runs.json')),ledger);
  }finally{await reopened.close();f.remove();}
});

test('work_edit confirmation failure halts further calls and cold inspection preserves the actual unconfirmed edit',async()=>{
  const f=fixture();let editedId='',editedVersion='',runId='',failedCall='';
  const factory:WorkCycleWorkspaceFactory=async options=>{
    const workspace=await createWorkCycleWorkspace(options);
    return {...workspace,async edit(callId,args){failedCall=callId;return workspace.edit(callId,args);},
      async confirm(callId){if(callId===failedCall)throw new WorkCycleError('STORAGE_FAILED');return workspace.confirm(callId);}};
  };
  const h=harness(f,async input=>{
    const created=ok(await call(input,'work_write',{relativePath:'script.js',expectedVersion:null,text:'const result = 17;\r\n'}));
    assert.equal(created.kind,'work_write');if(created.kind!=='work_write')return;
    editedId=created.file.fileId;editedVersion=sha('const result = 29;\r\n');
    await assert.rejects(call(input,'work_edit',{fileId:editedId,expectedVersion:created.file.version,oldText:'17',newText:'29'}));
    await assert.rejects(call(input,'work_edit',{fileId:editedId,expectedVersion:editedVersion,oldText:'29',newText:'31'}));
  },factory);
  try{runId=ok(await h.host.invoke('startWorkRun',h.request,()=>true)).runId;assert.equal((await h.wait()).status,'failed');assert.equal(h.counts().executions,0);}
  finally{await h.close();}
  const reopened=harness(f,async()=>assert.fail('unconfirmed edit must not replay'));
  try{
    const read=ok(await reopened.host.invoke('readWorkFile',{contractVersion:V,runId,fileId:editedId,version:editedVersion},()=>true));
    assert.equal(read.text,'const result = 29;\r\n');assert.equal(read.file.confirmation,'unconfirmed');
    assert.deepEqual(reopened.counts(),{starts:0,executions:0});
  }finally{await reopened.close();f.remove();}
});

test('work_edit gateway delivers the exact confirmed result into the next mocked model request once',async()=>{
  const args={fileId:'edited-file',expectedVersion:sha('before'),oldText:'before',newText:'after'};
  const result:ProjectReadToolResult={ok:true,value:{kind:'work_edit',file:{fileId:args.fileId,relativePath:'script.js',version:sha('after'),bytes:5,confirmation:'confirmed',origin:{kind:'write',changeId:'changed-file'}},previousVersion:args.expectedVersion,changeId:'changed-file',changed:true}};
  const sent:Record<string,unknown>[]=[];let calls=0;
  const frame=(delta:unknown,finish:string)=>'data: '+JSON.stringify({id:'completion-edit',choices:[{index:0,delta,finish_reason:finish}]})+'\n\ndata: [DONE]\n\n';
  const service=await createProjectReadProviderServices({getRunCredentials:()=>({apiKey:'synthetic-only',model,maxRequests:2,maxOutputTokens:100,requestTimeoutMs:1000}),onResponse(){},
    fetchImpl:async(_url,init)=>{sent.push(JSON.parse(String(init.body)));return new Response(sent.length===1?frame({role:'assistant',tool_calls:[{index:0,id:'edit-call',type:'function',function:{name:'work_edit',arguments:JSON.stringify(args)}}]},'tool_calls'):frame({role:'assistant',content:'Verified edit received.'},'stop'),{headers:{'Content-Type':'text/event-stream'}});}});
  const messages:unknown[]=[{role:'system',content:'untrusted native system'},{role:'user',content:'Make the small edit.'}];
  const post=(body:unknown,tool=false)=>fetch('http://127.0.0.1:'+service.port+(tool?'/tool':'/v1/chat/completions'),{method:'POST',headers:{Authorization:'Bearer '+(tool?service.toolToken:service.providerToken),'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const owner=service.begin({runId:'edit-run',goal:'small edit',constraint:'',workCycle:true,systemText:'Main work edit authority.',initialUserText:'Make the small edit.',onFailure(){},onTool:async call=>{assert.equal(call.toolName,'work_edit');assert.deepEqual(call.arguments,args);calls++;return result;}});
    owner.bindSession('edit-session');
    const first=await post({model:model.model,stream:true,tools:projectReadTools(true),messages});assert.equal(first.status,200);
    const completion=parseProjectReadSse(await first.text()),c=completion.calls[0]!;
    const input={sessionID:'edit-session',messageID:'edit-message',callID:c.id,toolName:c.name,arguments:c.arguments};
    const response=await post(input,true);assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
    const replay=await post(input,true);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);assert.equal(calls,1);
    messages.push({role:'assistant',content:null,tool_calls:[{id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}]},{role:'tool',tool_call_id:c.id,content:JSON.stringify(result)});
    const second=await post({model:model.model,stream:true,tools:projectReadTools(true),messages});assert.equal(second.status,200);await second.text();
    assert.deepEqual((sent[1]!.messages as unknown[]).at(-1),messages.at(-1));assert.equal(owner.evidence().complete,true);
    assert.equal((sent[1]!.tools as unknown[]).length,25);assert.deepEqual(toolNames(sent[1]!.tools as unknown[]),workToolNames);assert.equal(JSON.stringify(sent).includes('synthetic-only'),false);
  }finally{await service.close();}
});
