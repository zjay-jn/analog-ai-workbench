import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {captureFolderRoot,scanProjectFolder,openProjectFolderNode,verifyFolderRoot,checkedFolderPath} from '../apps/desktop/src/main/cloud/project-folder-files';
import {PROJECT_FOLDERS_VERSION,PROJECT_FOLDER_LIMITS,parseProjectFolderRequest,parseProjectFolderBindingResult,parseProjectFolderListResult,parseProjectFolderOpenResult,folderName} from '../apps/desktop/src/shared/agent/project-folders';
import {parseFileContext,filePrompt} from '../apps/desktop/src/shared/agent/file-context';
const projectId=randomUUID(),bindingId=randomUUID(),treeId=randomUUID(),nodeId=randomUUID();
const base={contractVersion:PROJECT_FOLDERS_VERSION,projectId};
const request=(_method:'open')=>({...base,bindingId,treeId,nodeId});
const entry=()=>({nodeId,parentId:null,name:'synthetic.txt',kind:'file' as const,size:8});
const listing=()=>({ok:true,projectId,bindingId,treeId,entries:[entry()],truncated:false});
const opened=(text='synthetic')=>({ok:true,projectId,bindingId,treeId,nodeId,file:{id:nodeId,name:'synthetic.txt',text,startLine:1,endLine:1,totalLines:1},segments:['C','synthetic-private-root','synthetic.txt']});
function fixture(){const product=path.resolve(process.cwd());assert.equal(product.toLowerCase(),'c:\\work\\analog_ai_workbench');const home=fs.mkdtempSync(path.join(product,'.local','folder-safety-'));assert.ok(home.startsWith(product+path.sep));const rootPath=path.join(home,'root');fs.mkdirSync(rootPath);return {home,rootPath,root:()=>captureFolderRoot(projectId,bindingId,rootPath)};}

test('folder independent schema rejects getters and exotic objects without evaluating them',()=>{
 let getters=0;const raw=request('open');
 for(const bad of [Object.assign(Object.create({}),raw),Object.assign(Object.create(null),raw),Object.defineProperty({...raw},'nodeId',{get(){getters++;return nodeId;}})])assert.throws(()=>parseProjectFolderRequest('open',bad));
 const rows=[entry()];Object.defineProperty(rows,'0',{get(){getters++;return entry();}});assert.throws(()=>parseProjectFolderListResult({...listing(),entries:rows}));
 for(const entries of [new Array(1),Object.assign([entry()],{extra:true}),Object.assign(Object.create(null),{0:entry(),length:1})])assert.throws(()=>parseProjectFolderListResult({...listing(),entries}));
 assert.throws(()=>parseProjectFolderOpenResult(Object.defineProperty(opened(),'ok',{get(){getters++;return true;}})));assert.equal(getters,0);
});

test('folder independent names reject separators, Windows ambiguities and all bidi controls',()=>{
 for(const value of ['', '.', '..', 'a/b','a\\b','C:','file:stream','file.','file ','a?b','x\u0000','x\u0085','a'.repeat(256)])assert.throws(()=>folderName(value));
 for(const code of [0x061c,0x200e,0x200f,0x202a,0x202b,0x202c,0x202d,0x202e,0x2066,0x2067,0x2068,0x2069])assert.throws(()=>folderName('x'+String.fromCodePoint(code)+'y'));
 for(const name of ['api.txt','credentials.json','secret.md','file.exe'])assert.throws(()=>parseProjectFolderListResult({...listing(),entries:[{...entry(),name}]}));
});

test('folder independent tree parser checks ordered parents, unique tokens and case-folded siblings',()=>{
 const parent={nodeId:randomUUID(),parentId:null,name:'folder',kind:'directory',size:0};
 assert.equal(parseProjectFolderListResult({...listing(),entries:[parent,{...entry(),parentId:parent.nodeId}]}).ok,true);
 for(const entries of [[entry(),entry()],[{...entry(),parentId:randomUUID()}],[{...entry(),parentId:nodeId}],[entry(),{...entry(),nodeId:randomUUID(),name:'SYNTHETIC.TXT'}],[{...parent,size:1}],[{...entry(),size:262145}],[{...entry(),size:NaN}]])assert.throws(()=>parseProjectFolderListResult({...listing(),entries}));
 assert.throws(()=>parseProjectFolderListResult({...listing(),entries:Array.from({length:2001},(_,i)=>({...entry(),nodeId:randomUUID(),name:'f'+i+'.txt'}))}));
});

test('folder independent full-document response uses 256KiB limit while excerpts retain 12KiB',()=>{
 const full=opened('x'.repeat(16*1024));assert.equal(parseProjectFolderOpenResult(full).ok,true);assert.throws(()=>parseFileContext(full.file));
 assert.equal(parseProjectFolderOpenResult(opened('x'.repeat(256*1024))).ok,true);assert.throws(()=>parseProjectFolderOpenResult(opened('x'.repeat(256*1024+1))));
 const many=opened();many.file.text=Array<string>(10000).fill('x').join('\n');many.file.endLine=many.file.totalLines=10000;assert.equal(parseProjectFolderOpenResult(many).ok,true);
 assert.throws(()=>parseProjectFolderOpenResult({...many,file:{...many.file,text:many.file.text+'\nx',endLine:10001,totalLines:10001}}));
 for(const file of [{...full.file,id:randomUUID()},{...full.file,startLine:2},{...full.file,endLine:2},{...full.file,text:'bad\u0000'}])assert.throws(()=>parseProjectFolderOpenResult({...full,file}));
});

test('folder independent response ownership and display data cannot extend context authority',()=>{
 const binding={projectId,bindingId,name:'synthetic-private-root',segments:['C','synthetic-private-root']};assert.equal(parseProjectFolderBindingResult({ok:true,projectId,binding}).ok,true);
 assert.throws(()=>parseProjectFolderBindingResult({ok:true,projectId,binding:{...binding,projectId:randomUUID()}}));
 assert.throws(()=>parseProjectFolderBindingResult({ok:true,projectId,binding:{...binding,root:'C:/synthetic-private-root'}}));
 assert.throws(()=>parseProjectFolderOpenResult({...opened(),segments:['C','wrong.txt']}));
 const context=opened().file;assert.throws(()=>parseFileContext({...context,segments:opened().segments}));assert.throws(()=>filePrompt('question',[{...context,path:'C:/synthetic-private-root/synthetic.txt'} as typeof context]));assert.ok(!filePrompt('question',[context]).includes('synthetic-private-root'));
});

test('folder independent scan reads zero body bytes and filters hardlinks, junctions, sensitive and oversized files',()=>{
 const f=fixture();fs.writeFileSync(path.join(f.rootPath,'allowed.txt'),'alpha\nbeta');fs.writeFileSync(path.join(f.rootPath,'api.txt'),'synthetic');fs.writeFileSync(path.join(f.rootPath,'binary.exe'),'synthetic');fs.writeFileSync(path.join(f.rootPath,'large.txt'),'x'.repeat(262145));
 const linked=path.join(f.home,'linked-original.txt');fs.writeFileSync(linked,'synthetic');fs.linkSync(linked,path.join(f.rootPath,'hardlink.txt'));const external=path.join(f.home,'junction-target');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'outside.txt'),'synthetic');fs.symlinkSync(external,path.join(f.rootPath,'junction'),'junction');
 for(const name of ['.hidden','model','project-folders']){fs.mkdirSync(path.join(f.rootPath,name));fs.writeFileSync(path.join(f.rootPath,name,'hidden.txt'),'synthetic');}
 const root=f.root(),names=['openSync','readSync','readFileSync'] as const,originals=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(fs,name)!]));let reads=0;
 try{for(const name of names)Object.defineProperty(fs,name,{...originals.get(name),value:()=>{reads++;throw Error('Body read forbidden during scan');}});const result=scanProjectFolder(root);assert.deepEqual(result.entries.map(e=>e.name),['allowed.txt']);assert.equal(result.truncated,false);assert.equal(reads,0);}finally{for(const name of names)Object.defineProperty(fs,name,originals.get(name)!);}
});

test('folder independent enumeration counts filtered candidates and explicitly truncates each budget',()=>{
 const f=fixture();for(let i=0;i<10;i++)fs.writeFileSync(path.join(f.rootPath,'api-'+i+'.txt'),'synthetic');const root=f.root();assert.equal(scanProjectFolder(root,{...PROJECT_FOLDER_LIMITS,candidates:3}).truncated,true);
 assert.equal(scanProjectFolder(root,{...PROJECT_FOLDER_LIMITS,directories:0}).truncated,true);assert.equal(scanProjectFolder(root,{...PROJECT_FOLDER_LIMITS,scanMs:0}).truncated,true);
 fs.writeFileSync(path.join(f.rootPath,'visible.txt'),'synthetic');assert.equal(scanProjectFolder(root,{...PROJECT_FOLDER_LIMITS,nodes:0}).truncated,true);assert.equal(scanProjectFolder(root,{...PROJECT_FOLDER_LIMITS,treeBytes:512}).truncated,true);
 fs.mkdirSync(path.join(f.rootPath,'deep'));fs.writeFileSync(path.join(f.rootPath,'deep','child.txt'),'synthetic');const result=scanProjectFolder(root,{...PROJECT_FOLDER_LIMITS,depth:1});assert.equal(result.truncated,true);assert.ok(!result.entries.some(e=>e.name==='child.txt'));
});

test('folder independent root and ancestor replacement, modified node and hardlink creation invalidate authority',()=>{
 const f=fixture(),file=path.join(f.rootPath,'allowed.txt');fs.writeFileSync(file,'original');const root=f.root(),scan=scanProjectFolder(root),[id,node]=[...scan.nodes][0]!;assert.equal(openProjectFolderNode(root,id,node).file.text,'original');
 fs.writeFileSync(file,'changed');assert.throws(()=>openProjectFolderNode(root,id,node));const newer=scanProjectFolder(root),[newId,newNode]=[...newer.nodes][0]!;fs.linkSync(file,path.join(f.home,'copy.txt'));assert.throws(()=>openProjectFolderNode(root,newId,newNode));
 const moved=path.join(f.home,'old-root');fs.renameSync(f.rootPath,moved);fs.mkdirSync(f.rootPath);assert.throws(()=>verifyFolderRoot(root));assert.throws(()=>scanProjectFolder(root));
 const ancestor=path.join(f.home,'parent'),nested=path.join(ancestor,'nested');fs.mkdirSync(nested,{recursive:true});const old=captureFolderRoot(projectId,bindingId,nested);fs.renameSync(ancestor,path.join(f.home,'old-parent'));fs.mkdirSync(nested,{recursive:true});assert.throws(()=>verifyFolderRoot(old));
});

test('folder independent open rejects invalid UTF8, control bytes, excess lines and digest disagreement',()=>{
 const f=fixture(),file=path.join(f.rootPath,'allowed.txt');const read=()=>{const root=f.root(),[id,node]=[...scanProjectFolder(root).nodes][0]!;return openProjectFolderNode(root,id,node);};
 for(const bytes of [Buffer.from([0xc3,0x28]),Buffer.from('bad\u0000'),Buffer.from('x\n'.repeat(10000))]){fs.writeFileSync(file,bytes);assert.throws(read);}
 fs.writeFileSync(file,'alpha\r\nbeta\r');assert.equal(read().file.text,'alpha\nbeta\n');const root=f.root(),[id,node]=[...scanProjectFolder(root).nodes][0]!,descriptor=Object.getOwnPropertyDescriptor(fs,'readSync')!;let starts=0;
 try{Object.defineProperty(fs,'readSync',{...descriptor,value:(...args:unknown[])=>{const count=Reflect.apply(descriptor.value,fs,args);if(args[4]===0&&++starts===2){const buffer=args[1] as Buffer;buffer[0]=buffer[0]!^1;}return count;}});assert.throws(()=>openProjectFolderNode(root,id,node));assert.equal(starts,2);}finally{Object.defineProperty(fs,'readSync',descriptor);}
});

test('folder independent lexical fence rejects device, UNC, ADS, traversal and restricted ancestors',()=>{
 for(const value of ['C:\\','C:relative','\\\\server\\share','\\\\?\\C:\\synthetic','C:\\safe\\a:stream','C:\\safe\\..\\other','C:\\safe\\a.','C:\\safe\\NUL.txt','C:\\Windows\\safe','C:\\safe\\project-folders','C:\\safe\\credentials\\nested'])assert.throws(()=>checkedFolderPath(value));
 assert.equal(checkedFolderPath('C:\\safe\\analog_ai_lab'),'C:\\safe\\analog_ai_lab');
});
