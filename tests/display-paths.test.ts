import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {DISPLAY_PATH_VERSION,DISPLAY_PATH_COUNT,emptyDisplayPaths,parseDisplayPathDisk,parseDisplayPathRecord,parseDisplayPathRead,parseDisplayPathRemember,parseDisplayPathResult,displayPathChannel,type DisplayPathDisk} from '../apps/desktop/src/shared/agent/display-paths';
import {createDisplayPathHost,createDisplayPathStore} from '../apps/desktop/src/main/cloud/display-path-host';
import {displayPathExtension} from '../apps/desktop/src/main/cloud/register-display-paths';
import {parseFileContext} from '../apps/desktop/src/shared/agent/file-context';
import {parseWorkspaceFile} from '../apps/desktop/src/shared/agent/project-workspace';
const version={contractVersion:DISPLAY_PATH_VERSION},record=()=>({id:randomUUID(),name:'README.md',segments:['C','合成目录','README.md']}),read=(ids:string[])=>({...version,ids}),remember=(r=record())=>({...version,record:r});
const root=path.resolve('.local/quality-evidence/20260908-display-paths-01/unit');fs.mkdirSync(root,{recursive:true});

test('strict metadata accepts only display records and detached values',()=>{
 const r=record(),parsed=parseDisplayPathRecord(r);r.segments[1]='changed';assert.equal(parsed.segments[1],'合成目录');
 for(const bad of [{...r,path:'C:/x'}, {...r,id:'not-uuid'}, {...r,name:'api.txt'}, {...r,segments:['C','other.txt']}, {...r,segments:['README.md']}, {...r,segments:[]}])assert.throws(()=>parseDisplayPathRecord(bad));
 const getter={...r};Object.defineProperty(getter,'name',{get(){throw Error('must not evaluate');},enumerable:true});assert.throws(()=>parseDisplayPathRecord(getter));
 const sparse=[,'README.md'];assert.throws(()=>parseDisplayPathRecord({...r,segments:sparse}));
 assert.throws(()=>parseDisplayPathRecord(Object.assign(Object.create({}),r)));
});
test('path fragments reject separators, traversal, controls, bidi and overflow',()=>{
 for(const segment of ['', '.', '..','C:','a/b','a\\b','a\u0000b','a\u007fb','a\u0085b','a\u202eb','a\u2066b','a?b','a*b','a|b','a<b','x'.repeat(256)])assert.throws(()=>parseDisplayPathRecord({...record(),segments:['C',segment,'README.md']}));
 assert.throws(()=>parseDisplayPathRecord({...record(),segments:['C',...Array(127).fill('x'),'README.md']}));
 assert.throws(()=>parseDisplayPathRecord({...record(),segments:['C',...Array(40).fill('x'.repeat(255)),'README.md']}));
 assert.equal(parseDisplayPathRecord({...record(),segments:['SERVER','share','README.md']}).segments[0],'SERVER');
});
test('requests/results reject extra authority and malformed versions/counts/duplicates',()=>{
 const r=record();assert.deepEqual(parseDisplayPathRead(read([r.id])).ids,[r.id]);
 for(const raw of [{...read([r.id]),path:'C:/'},read([r.id,r.id]),read(Array.from({length:9},randomUUID)),{...read([]),contractVersion:'v0'}])assert.throws(()=>parseDisplayPathRead(raw));
 assert.throws(()=>parseDisplayPathRemember({...remember(r),directory:'C:/other'}));assert.throws(()=>parseDisplayPathResult({ok:true,records:[r,r]}));assert.throws(()=>parseDisplayPathResult({ok:false,error:{code:'IO_ALLOWED'}}));
});
test('disk version, duplicate ids, count and byte budget are enforced',()=>{
 const r=record();assert.throws(()=>parseDisplayPathDisk({version:0,records:[]}));assert.throws(()=>parseDisplayPathDisk({version:1,records:[r,r]}));
 assert.throws(()=>parseDisplayPathDisk({version:1,records:Array.from({length:DISPLAY_PATH_COUNT+1},record)}));
 assert.throws(()=>parseDisplayPathDisk({version:1,records:Array.from({length:DISPLAY_PATH_COUNT},()=>({...record(),segments:['C',...Array(20).fill('中'.repeat(200)),'README.md']}))}));
});
test('host idempotence and UUID identity prevent overwrite or misattribution',()=>{
 let disk=emptyDisplayPaths(),writes=0;const host=createDisplayPathHost({load:()=>disk,save:v=>{disk=v;writes++;}}),a=record(),b=record();
 assert.equal(host.invoke('remember',remember(a),false).ok,false);assert.equal(writes,0);
 assert.equal(host.invoke('remember',remember(a),true).ok,true);assert.equal(host.invoke('remember',remember(a),true).ok,true);assert.equal(writes,1);
 assert.deepEqual(host.invoke('remember',remember({...a,segments:['C','different','README.md']}),true),{ok:false,error:{code:'CONFLICT'}});
 assert.equal(host.invoke('remember',remember(b),true).ok,true);
 const result=host.invoke('read',read([a.id]),true);assert.equal(result.ok,true);if(!result.ok)throw Error();assert.equal(result.records.length,1);result.records[0]!.segments[1]='forged';assert.equal(disk.records[0]!.segments[1],'合成目录');
});
test('lost acknowledgement is recoverable by read and identical retry',()=>{
 let disk=emptyDisplayPaths(),writes=0;const host=createDisplayPathHost({load:()=>disk,save:v=>{disk=v;writes++;}}),r=record();
 host.invoke('remember',remember(r),true);assert.deepEqual(host.invoke('read',read([r.id]),true),{ok:true,records:[r]});assert.equal(host.invoke('remember',remember(r),true).ok,true);assert.equal(writes,1);
});
test('full store returns LIMIT without evicting existing paths',()=>{
 const disk:DisplayPathDisk={version:1,records:Array.from({length:DISPLAY_PATH_COUNT},record)};let writes=0;const host=createDisplayPathHost({load:()=>disk,save:()=>{writes++;}});
 assert.deepEqual(host.invoke('remember',remember(),true),{ok:false,error:{code:'LIMIT'}});assert.equal(writes,0);assert.equal(host.invoke('read',read([disk.records[0]!.id]),true).ok,true);
});
test('load and write failure fail closed without reset/repeated writes',()=>{
 let writes=0;const broken=createDisplayPathHost({load:()=>{throw Error();},save:()=>{writes++;}});
 assert.deepEqual(broken.invoke('remember',remember(),true),{ok:false,error:{code:'STORAGE_ERROR'}});assert.equal(writes,0);
 const host=createDisplayPathHost({load:emptyDisplayPaths,save:()=>{writes++;throw Error();}});host.invoke('remember',remember(),true);host.invoke('remember',remember(),true);assert.equal(writes,1);assert.equal(host.invoke('read',read([]),true).ok,false);
});
test('missing old metadata is empty; fixed store survives restart without reading original paths',()=>{
 const folder=path.join(root,randomUUID()),r={...record(),segments:['C','not-an-existing-synthetic-directory', 'README.md']},host=createDisplayPathHost(createDisplayPathStore(root,folder));
 assert.deepEqual(host.invoke('read',read([r.id]),true),{ok:true,records:[]});assert.equal(host.invoke('remember',remember(r),true).ok,true);
 const reopened=createDisplayPathHost(createDisplayPathStore(root,folder));assert.deepEqual(reopened.invoke('read',read([r.id]),true),{ok:true,records:[r]});
 assert.deepEqual(fs.readdirSync(folder),['paths.json']);
});
test('external change/corruption is preserved rather than reset',()=>{
 const folder=path.join(root,randomUUID()),store=createDisplayPathStore(root,folder);store.load();store.save({version:1,records:[record()]});const target=path.join(folder,'paths.json');
 fs.writeFileSync(target,'external');assert.throws(()=>store.save(emptyDisplayPaths()));assert.equal(fs.readFileSync(target,'utf8'),'external');assert.throws(()=>createDisplayPathStore(root,folder).load());assert.equal(fs.readFileSync(target,'utf8'),'external');
});
test('fixed storage rejects escape directories and hard linked metadata',()=>{
 assert.throws(()=>createDisplayPathStore(root,path.dirname(root)));assert.throws(()=>createDisplayPathStore(root,root));
 const folder=path.join(root,randomUUID()),store=createDisplayPathStore(root,folder);store.load();store.save(emptyDisplayPaths());fs.linkSync(path.join(folder,'paths.json'),path.join(folder,'alias.json'));assert.throws(()=>createDisplayPathStore(root,folder).load());
});
test('caller fence covers both methods and revocation/disposal',()=>{
 const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'},handlers=new Map<string,(event:unknown,value:unknown)=>unknown>();let caller:unknown=owner,writes=0;
 const register=displayPathExtension({root,directory:path.join(root,randomUUID()),store:{load:emptyDisplayPaths,save:()=>{writes++;}}}),extension=register({owner,deriveCallerContext:()=>caller,ipcMain:{handle:(key:string,fn:(event:unknown,value:unknown)=>unknown)=>handlers.set(key,fn),removeHandler:(key:string)=>handlers.delete(key)}} as unknown as Parameters<typeof register>[0]);
 assert.deepEqual([...handlers.keys()],[displayPathChannel('read'),displayPathChannel('remember')]);
 for(const foreign of [null,{...owner,isTopFrame:false},{...owner,webContentsId:2},{...owner,navigationEpoch:2},{...owner,workspaceId:'elsewhere'}]){caller=foreign;for(const method of ['read','remember'] as const)assert.deepEqual(handlers.get(displayPathChannel(method))!({},method==='read'?read([]):remember()),{ok:false,error:{code:'CAPABILITY_DENIED'}});}
 assert.equal(writes,0);caller=owner;assert.equal((handlers.get(displayPathChannel('remember'))!({},remember()) as {ok:boolean}).ok,true);
 extension.revoke();assert.deepEqual(handlers.get(displayPathChannel('read'))!({},read([])),{ok:false,error:{code:'CAPABILITY_DENIED'}});extension.dispose();assert.equal(handlers.size,0);
});
test('paths cannot be admitted to FileContext or workspace snapshot fields',()=>{
 const file={id:randomUUID(),name:'README.md',text:'synthetic',startLine:1,endLine:1,totalLines:1};assert.ok(parseFileContext(file));assert.ok(parseWorkspaceFile(file));
 for(const extra of [{segments:['C','README.md']},{path:'C:/README.md'},{displayPath:record()}]){assert.throws(()=>parseFileContext({...file,...extra}));assert.throws(()=>parseWorkspaceFile({...file,...extra}));}
});
