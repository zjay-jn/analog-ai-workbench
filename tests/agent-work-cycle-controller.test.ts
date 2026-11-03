import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {WorkCycleFile,WorkCycleFileContent,WorkCycleChange,WorkCycleToolValue} from '../apps/desktop/src/shared/agent/agent-work-cycle';
import {createWorkCycleInspectionController,workCycleInspectionPorts,type WorkCycleInspectionPorts,type WorkCycleInspectionResult} from '../apps/desktop/src/renderer/agent/work-cycle-controller';
import {AGENT_PROJECT_READ_VERSION as V,type WorkbenchAgentProjectReadApi} from '../apps/desktop/src/shared/agent/agent-project-read';

const scope={runId:'run-a',workspaceId:'workspace-a'};
const file:WorkCycleFile={fileId:'file-a',relativePath:'report.md',version:'a'.repeat(64),bytes:20,confirmation:'confirmed',origin:{kind:'write',changeId:'change-a'}};
const value:WorkCycleToolValue={kind:'work_write',file,changeId:'change-a',changed:true,previousVersion:null};
const content:WorkCycleFileContent={file,text:'analysis output text',verified:true};
const change:WorkCycleChange={file,changeId:'change-a',changed:true,previousVersion:null,before:null,after:content.text};
function fixture(overrides:Partial<WorkCycleInspectionPorts>={}){
 const calls:string[]=[];
 const ports:WorkCycleInspectionPorts={list:async run=>{calls.push(`list:${run}`);return{ok:true,value:[file]};},file:async(run,id,version)=>{calls.push(`read:${run}:${id}:${version}`);return{ok:true,value:content};},change:async(run,id)=>{calls.push(`diff:${run}:${id}`);return{ok:true,value:change};},...overrides};
 const controller=createWorkCycleInspectionController(ports);controller.setScope(scope);controller.register(scope,[value],2);return{controller,calls};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('C1C inherited files open with child identities and validate every parent provenance field',async()=>{
 const inherited:WorkCycleFile={...file,fileId:'child-file',relativePath:'artifacts/execution-parent/report.md',origin:{kind:'continuation',source:{runId:'parent',workspaceId:'workspace-parent',fileId:'parent-file',version:file.version,baselineVersion:'b'.repeat(64)}}};
 let returned=inherited;const requests:string[]=[];
 const f=fixture({file:async(run,id)=>{requests.push(`${run}:${id}`);return{ok:true,value:{...content,file:returned}};}});
 try{f.controller.register(scope,[{kind:'work_list',files:[inherited]}],3);assert(await f.controller.openFile(inherited));assert.deepEqual(requests,['run-a:child-file']);const preview=f.controller.snapshot().preview;
  assert(inherited.origin.kind==='continuation');for(const key of ['runId','workspaceId','fileId','version','baselineVersion'] as const){returned={...inherited,origin:{kind:'continuation',source:{...inherited.origin.source,[key]:'changed'}}};assert.equal(await f.controller.openFile(inherited),false);assert.equal(f.controller.snapshot().preview,preview);}
  f.controller.setScope({runId:'parent',workspaceId:'workspace-parent'});assert.equal(await f.controller.openFile(inherited),false);assert.equal(f.controller.snapshot().preview,null);
 }finally{f.controller.dispose();}
});

test('work inspection only opens registered identities and never derives a path from model text',async()=>{
 const f=fixture();try{
  assert.equal(await f.controller.openFile({...file,fileId:'invented'}),false);assert.equal(await f.controller.openFile({...file,relativePath:'../private'}),false);assert.equal(await f.controller.openChange('invented'),false);assert.deepEqual(f.calls,[]);
  assert.equal(await f.controller.openFile(file),true);assert.equal(await f.controller.openChange('change-a'),true);assert.deepEqual(f.calls,[`read:run-a:file-a:${file.version}`,'diff:run-a:change-a']);
 }finally{f.controller.dispose();}
});

test('late work reads and lists cannot cross run selection or new event revisions',async()=>{
 const pending=deferred<WorkCycleInspectionResult<WorkCycleFileContent>>(),listing=deferred<WorkCycleInspectionResult<readonly WorkCycleFile[]>>();
 const f=fixture({file:()=>pending.promise,list:()=>listing.promise});try{
  const read=f.controller.openFile(file),list=f.controller.refresh();f.controller.setScope({runId:'run-b',workspaceId:'workspace-b'});
  pending.resolve({ok:true,value:content});listing.resolve({ok:true,value:[file]});assert.equal(await read,false);await list;assert.equal(f.controller.snapshot().preview,null);assert.deepEqual(f.controller.snapshot().files,[]);
 }finally{f.controller.dispose();}
 const pending2=deferred<WorkCycleInspectionResult<readonly WorkCycleFile[]>>(),g=fixture({list:()=>pending2.promise});try{
  const list=g.controller.refresh();g.controller.register(scope,[value],3);pending2.resolve({ok:true,value:[file]});await list;assert.equal(g.controller.snapshot().revision,3);assert.deepEqual(g.controller.snapshot().files,[]);
 }finally{g.controller.dispose();}
});

test('latest workspace downgrade and failed read clear confirmation while retaining prior preview',async()=>{
 let confirmed=true,fail=false;
 const f=fixture({list:async()=>({ok:true,value:[{...file,confirmation:confirmed?'confirmed':'unconfirmed'}]}),file:async()=>fail?{ok:false,message:'核对失败'}:{ok:true,value:content}});
 try{await f.controller.refresh();assert.equal(f.controller.snapshot().files[0]?.confirmation,'confirmed');assert(await f.controller.openFile(file));
  confirmed=false;await f.controller.refresh();assert.equal(f.controller.snapshot().files[0]?.confirmation,'unconfirmed');
  // Registering the immutable old event does not restore its old confirmation.
  f.controller.register(scope,[value],2);assert.equal(f.controller.snapshot().files[0]?.confirmation,'unconfirmed');
  fail=true;assert.equal(await f.controller.openFile(file),false);assert.deepEqual(f.controller.snapshot().files,[]);assert.equal(f.controller.snapshot().preview?.kind,'file');assert.equal(f.controller.snapshot().previewError,'核对失败');
 }finally{f.controller.dispose();}
});

test('file and diff identity mismatch retain the previous snapshot and report uncertainty',async()=>{
 let mismatch=false;
 const f=fixture({file:async()=>({ok:true,value:{...content,file:mismatch?{...file,version:'b'.repeat(64)}:file}}),change:async()=>({ok:true,value:{...change,previousVersion:'c'.repeat(64)}})});
 try{assert(await f.controller.openFile(file));mismatch=true;assert.equal(await f.controller.openFile(file),false);assert.match(f.controller.snapshot().previewError??'',/身份或版本/);assert.equal(await f.controller.openChange('change-a'),false);assert.equal(f.controller.snapshot().preview?.kind,'file');}
 finally{f.controller.dispose();}
});

test('import preview preserves exact source identity instead of accepting a different source',async()=>{
 const imported:WorkCycleFile={...file,origin:{kind:'import',changeId:'import-a',source:{projectId:'project-a',bindingId:'binding-a',identity:'identity-a',fileId:'source-a',relativePath:'input.csv',version:'c'.repeat(64),bytes:20}}};
 const f=fixture({file:async()=>({ok:true,value:{...content,file:{...imported,origin:imported.origin.kind==='import'?{...imported.origin,source:{...imported.origin.source,fileId:'source-b'}}:imported.origin}}})});
 try{f.controller.register(scope,[{kind:'work_import',file:imported,previousVersion:null,changeId:'import-a',changed:true}],3);assert.equal(await f.controller.openFile(imported),false);assert.equal(f.controller.snapshot().preview,null);}
 finally{f.controller.dispose();}
});

test('a newer workspace downgrade supersedes an older pending successful file read',async()=>{
 const pending=deferred<WorkCycleInspectionResult<WorkCycleFileContent>>();
 const f=fixture({file:()=>pending.promise,list:async()=>({ok:true,value:[{...file,confirmation:'unconfirmed'}]})});
 try{const read=f.controller.openFile(file);await f.controller.refresh();pending.resolve({ok:true,value:content});assert.equal(await read,false);assert.equal(f.controller.snapshot().files[0]?.confirmation,'unconfirmed');assert.equal(f.controller.snapshot().preview,null);}
 finally{f.controller.dispose();}
});

test('work bridge inspection applies the actual shared parser before exposing content',async()=>{
 const calls:unknown[]=[];let malformed=false;
 const api={listWorkFiles:async(input:unknown)=>{calls.push(input);return{ok:true,value:{files:[file]}};},readWorkFile:async(input:unknown)=>{calls.push(input);return{ok:true,value:malformed?{...content,verified:false}:content};},readWorkChange:async()=>({ok:true,value:change})} as unknown as WorkbenchAgentProjectReadApi;
 const ports=workCycleInspectionPorts(api);assert.equal((await ports.list('run-a')).ok,true);assert.equal((await ports.file('run-a',file.fileId,file.version)).ok,true);assert.equal((await ports.change('run-a','change-a')).ok,true);
 assert.deepEqual(calls[1],{contractVersion:V,runId:'run-a',fileId:file.fileId,version:file.version});
 malformed=true;await assert.rejects(ports.file('run-a',file.fileId,file.version),/Invalid inspection result/);
});

test('C1E incremental edit registers full versioned changes and rejects mismatched previous versions',async()=>{
 const before='\ufeff'+('const untouched = "中文";\r\n'.repeat(420))+'const amount = 1;\r\n';
 const after=before.replace('const amount = 1;','const amount = 2;');
 const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
 const edited:WorkCycleFile={...file,relativePath:'large.js',bytes:Buffer.byteLength(after),version:digest(after),origin:{kind:'write',changeId:'edit-a'}};
 const edit:WorkCycleToolValue={kind:'work_edit',file:edited,changeId:'edit-a',previousVersion:digest(before),changed:true};
 const exactChange:WorkCycleChange={changeId:'edit-a',file:edited,previousVersion:digest(before),before,after,changed:true};
 assert(edited.bytes>8192);let mismatch=false;const requests:unknown[]=[];
 const api={readWorkChange:async(input:unknown)=>{requests.push(input);return{ok:true,value:{...exactChange,previousVersion:mismatch?'c'.repeat(64):exactChange.previousVersion}};}} as unknown as WorkbenchAgentProjectReadApi;
 const controller=createWorkCycleInspectionController(workCycleInspectionPorts(api));controller.setScope(scope);controller.register(scope,[edit],2);
 try{assert.equal(await controller.openChange('unissued'),false);assert.equal(requests.length,0);assert(await controller.openChange('edit-a'));
  const preview=controller.snapshot().preview;assert.equal(preview?.kind,'change');if(preview?.kind==='change'){assert.equal(preview.change.before,before);assert.equal(preview.change.after,after);assert.equal(preview.change.file.origin.kind,'write');}
  assert.deepEqual(requests,[{contractVersion:V,runId:'run-a',changeId:'edit-a'}]);
  mismatch=true;assert.equal(await controller.openChange('edit-a'),false);assert.match(controller.snapshot().previewError??'',/身份或版本/);assert.equal(controller.snapshot().preview,preview);
 }finally{controller.dispose();}
});
