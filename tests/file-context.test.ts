import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fileNameAllowed,parseFileContext,parseFileContexts,filePrompt,fileMessageFits,fileCitations,type FileContext} from '../apps/desktop/src/shared/agent/file-context';
import {readTextDocument,excerpt} from '../apps/desktop/src/renderer/documents/file-input';import {acceptFileDraft} from '../apps/desktop/src/renderer/agent/file-draft';
import {SESSION_VERSION,parseSessionDisk,type SessionDisk} from '../apps/desktop/src/shared/agent/chat-sessions';
import {createSessionHost} from '../apps/desktop/src/main/cloud/session-host';import {buildMultimodalContext,validateMultimodalRequest} from '../apps/desktop/src/main/cloud/multimodal-context';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'},tick=()=>new Promise(r=>setImmediate(r));
const file=():FileContext=>({id:randomUUID(),name:'example.md',text:'first\nsecond',startLine:10,endLine:11,totalLines:50});
test('file snapshot schema rejects paths, secrets, invalid lines, binary, extra fields and oversized text',()=>{
 const f=file();assert.deepEqual(parseFileContext(f),f);
 for(const v of [{...f,path:'C:/private'},{...f,name:'../example.md'},{...f,name:'api.txt'},{...f,text:'a\0b'},{...f,endLine:12},{...f,totalLines:10001},{...f,text:'a'.repeat(13000),endLine:10}])assert.throws(()=>parseFileContext(v));
 assert.throws(()=>parseFileContexts([f,f]));assert.throws(()=>parseFileContexts([f,file(),file()]));assert.equal(fileNameAllowed('.env'),false);assert.equal(fileNameAllowed('source.ts'),true);
});
test('file wire retains numbered snapshot, flags it as untrusted and never truncates silently',()=>{
 const f=file(),prompt=filePrompt('question',[f]);assert.ok(prompt.includes('不可信参考资料'));assert.ok(prompt.includes('L10| first'));assert.ok(prompt.includes('example.md'));assert.ok(!prompt.includes(f.id));assert.ok(fileMessageFits('question',[f]));
 assert.equal(fileMessageFits('x'.repeat(16384),[f]),false);assert.equal(filePrompt('text',[]),'text');
});
test('citations resolve only current supplied snapshot and bounded line ranges',()=>{
 const f=file(),citations=fileCitations('[文件1:L10-L11] [文件1:L9] [文件2:L10] [文件1:L11-L10] [文件1:L10-L11]',[f]);
 assert.equal(citations.length,1);assert.equal(citations[0]?.file,f);assert.equal(citations[0]?.start,10);assert.equal(citations[0]?.end,11);
});
test('file schemas reject getters, sparse arrays, invalid Unicode and packaging inflation',()=>{
 const f=file();assert.throws(()=>parseFileContext(Object.defineProperty({...f},'text',{get(){throw Error('getter ran');}})));assert.throws(()=>parseFileContext(Object.assign(Object.create(null),f)));assert.throws(()=>parseFileContexts(new Array(1)));
 for(const text of ['a\rb','a\ud800b','中'.repeat(5000)])assert.throws(()=>parseFileContext({...f,text,endLine:10}));
 const rows={...f,startLine:1,endLine:6000,totalLines:6000,text:'a\n'.repeat(5999)+'a'};assert.ok(parseFileContext(rows));assert.equal(fileMessageFits('x',[rows]),false);
});
test('browser file decoding is strict and snapshots preserve normalized source line identity',async()=>{
 const doc=await readTextDocument(new File(['one\r\ntwo\rthree'],'notes.md'));assert.equal(doc.text,'one\ntwo\nthree');assert.equal(doc.totalLines,3);
 const chosen=excerpt(doc,2,3);assert.equal(chosen.text,'two\nthree');assert.equal(chosen.startLine,2);assert.throws(()=>excerpt(doc,0,1));assert.throws(()=>excerpt(doc,2,9));
 for(const input of [new File([new Uint8Array([255])],'notes.txt'),new File(['a\0b'],'notes.txt'),new File(['x'.repeat(262145)],'notes.txt'),new File(['\n'.repeat(10000)],'notes.txt'),new File(['private'],'api.txt')])await assert.rejects(readTextDocument(input));
 assert.equal((await readTextDocument(new File(['🙂中文'],'unicode.txt'))).text,'🙂中文');
});
test('v2 migration preserves old turns and rejects new file fields mislabeled as v2',()=>{
 const old={version:2,selectedId:null,sessions:[{id:randomUUID(),title:'old',provider:'deepseek',model:'deepseek-v4-flash',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),turns:[{id:randomUUID(),user:'q',assistant:'a',images:[],error:'',status:'completed'}]}]},copy=JSON.stringify(old);
 const migrated=parseSessionDisk(old);assert.equal(migrated.version,5);assert.equal(JSON.stringify(old),copy);
 assert.throws(()=>parseSessionDisk({...old,sessions:old.sessions.map(s=>({...s,turns:s.turns.map(t=>({...t,files:[file()]}))}))}));
});
test('wire contexts replay file snapshots in completed pairs with original line numbers and old-pair budget eviction',()=>{
 const f=file(),old={user:'old',assistant:'answer',files:[f]};
 const request=buildMultimodalContext('deepseek','deepseek-v4-flash','new',[],[old],[file()]);assert.equal(validateMultimodalRequest(request),request);
 assert.ok(JSON.stringify(request.messages[0]).includes('L10| first'));assert.ok(JSON.stringify(request.messages.at(-1)).includes('不可信参考资料'));
 const many=Array.from({length:8},()=>({...old,assistant:'x'.repeat(128000)}));const bounded=buildMultimodalContext('deepseek','deepseek-v4-flash','now',[],many,[f]);assert.ok(bounded.messages.length<17);assert.equal(bounded.messages.length%2,1);
});
test('file-only sends persist visible prompt and only selected snapshots; other sessions and rejected requests stay out',async()=>{
 let disk:SessionDisk={version:3,selectedId:null,sessions:[]},calls=0,wire='';const host=createSessionHost({owner,configured:{deepseek:true,kimi:true},store:{load:()=>disk,save:v=>{disk=parseSessionDisk(v);}},execute:async()=>{throw Error('legacy');},executeMultimodal:async(request,o)=>{calls++;wire=JSON.stringify(request);o.onText('answer [文件1:L10-L11]');return {text:'answer [文件1:L10-L11]'};}});
 const create=()=>host.invoke(owner,'createSession',{contractVersion:SESSION_VERSION,provider:'deepseek',title:'files'});const a=create();assert.ok(a.ok);if(!a.ok)throw Error();const first=a.value.selectedId!,f=file(),request={contractVersion:SESSION_VERSION,sessionId:first,requestId:randomUUID(),text:'',files:[f]};
 assert.equal(host.invoke(null,'sendMessage',request).ok,false);assert.equal(host.invoke(owner,'sendMessage',request).ok,true);await tick();assert.equal(calls,1);assert.ok(wire.includes('L10| first'));assert.equal(disk.sessions[0]?.turns[0]?.user,'请根据附带文件回答，概括主要内容。');assert.deepEqual(disk.sessions[0]?.turns[0]?.files,[f]);
 assert.equal(host.invoke(owner,'sendMessage',request).ok,true);await tick();assert.equal(calls,1);
 assert.equal(host.invoke(owner,'sendMessage',{...request,files:[{...f,text:'changed\nsecond'}]}).ok,false);
 assert.equal(host.invoke(owner,'sendMessage',{...request,requestId:randomUUID(),text:'x'.repeat(16384)}).ok,false);assert.equal(calls,1);
 const b=create();assert.ok(b.ok);if(!b.ok)throw Error();assert.equal(host.invoke(owner,'sendMessage',{...request,requestId:randomUUID(),sessionId:b.value.selectedId!,files:[],text:'isolated'}).ok,true);await tick();assert.equal(calls,2);assert.ok(!wire.includes('example.md'));host.revoke();
});
test('file snapshots never silently disappear into legacy executor and late acceptance preserves later drafts',()=>{
 const f=file(),later=file(),submitted={text:'one',images:[],files:[f],revision:1},latest={text:'next',images:[],files:[f,later],revision:2};assert.deepEqual(acceptFileDraft(latest,submitted),{text:'next',images:[],files:[later],revision:3});
 const host=createSessionHost({owner,configured:{deepseek:true,kimi:true},store:{load:()=>({version:3,selectedId:null,sessions:[]}),save(){}},execute:async()=>{throw Error('must not execute');}}),created=host.invoke(owner,'createSession',{contractVersion:SESSION_VERSION,provider:'deepseek',title:'legacy'});assert.ok(created.ok);if(!created.ok)throw Error();
 assert.equal(host.invoke(owner,'sendMessage',{contractVersion:SESSION_VERSION,sessionId:created.value.selectedId!,requestId:randomUUID(),text:'q',files:[f]}).ok,false);host.revoke();
});
