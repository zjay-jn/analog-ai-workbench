import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {PROJECT_FOLDER_LIMITS,folderName,type ProjectFolderCode,type ProjectFolderEntry} from '../../shared/agent/project-folders';
import {fileNameAllowed,validFileText,type FileContext} from '../../shared/agent/file-context';
export type FolderIdentity={dev:string;ino:string};
export type FolderRoot={projectId:string;bindingId:string;root:string;chain:FolderIdentity[]};
export type FolderNode={path:string;chain:FolderIdentity[];dev:string;ino:string;size:string;mtime:string;name:string};
export type FolderScanLimits={nodes:number;candidates:number;directories:number;depth:number;treeBytes:number;scanMs:number};
export class ProjectFolderFsError extends Error{constructor(readonly code:ProjectFolderCode){super(code);}}
const fail=(code:ProjectFolderCode):never=>{throw new ProjectFolderFsError(code);};
const denied=new Set(['.git','.hg','.svn','.codex','.agents','.ssh','.aws','node_modules','windows','program files','program files (x86)','programdata','chat-history','chat-drafts','project-workspace','project-folders','display-paths','model-settings','cloud-user-data','agent-engine-live','agent-engine-pilot','agent-project-read','agent-engine-candidate-v1.18.17','analog_gpt','toolchains','npm-cache','pdk','pdks','oa','psf','netlist','netlists','license','licenses','model','models','weights']);
const sensitive=/(?:^|[._-])(?:api|secrets?|credentials?|tokens?|private|passwords?|keys?)(?:[._-]|$)/iu;
const reserved=/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu;
export function folderReadPartAllowed(name:string):boolean{try{folderName(name);return !denied.has(name.toLowerCase())&&!sensitive.test(name)&&!reserved.test(name);}catch{return false;}}
/** Work-copy writes and executable snapshots retain their previous relative-name policy. */
export function folderPartAllowed(name:string):boolean{return typeof name==='string'&&name.toLowerCase()!=='analog_ai_lab'&&folderReadPartAllowed(name);}
export function checkedFolderPath(value:string):string{
 if(process.platform!=='win32'||typeof value!=='string'||value.length>8192||! /^[a-z]:\\/iu.test(value)||value.startsWith('\\\\')||value.slice(2).includes(':'))fail('UNSUPPORTED_FILE');
 const resolved=path.resolve(value);if(resolved.toLowerCase()===path.parse(resolved).root.toLowerCase()||value.replace(/\\$/u,'').toLowerCase()!==resolved.toLowerCase())fail('UNSUPPORTED_FILE');
 if(resolved.slice(path.parse(resolved).root.length).split(path.sep).some(part=>!folderReadPartAllowed(part)))fail('UNSUPPORTED_FILE');return resolved;
}
const identity=(stat:fs.BigIntStats):FolderIdentity=>({dev:String(stat.dev),ino:String(stat.ino)});
const sameIdentity=(a:FolderIdentity,b:FolderIdentity)=>a.dev===b.dev&&a.ino===b.ino;
function inspect(target:string,directory:boolean):{chain:FolderIdentity[];stat:fs.BigIntStats}{
 const resolved=checkedFolderPath(target),base=path.parse(resolved).root;let cursor=base;const names=resolved.slice(base.length).split(path.sep),chain:FolderIdentity[]=[];
 let stat=fs.lstatSync(base,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSUPPORTED_FILE');chain.push(identity(stat));
 for(let i=0;i<names.length;i++){cursor=path.join(cursor,names[i]!);stat=fs.lstatSync(cursor,{bigint:true});if(stat.isSymbolicLink()||((i<names.length-1||directory)&&!stat.isDirectory()))fail('UNSUPPORTED_FILE');const real=fs.realpathSync.native(cursor);checkedFolderPath(real);if(real.toLowerCase()!==cursor.toLowerCase())fail('UNSUPPORTED_FILE');chain.push(identity(stat));}
 if(!directory&&(!stat.isFile()||stat.nlink!==1n))fail('UNSUPPORTED_FILE');return {chain,stat};
}
const sameChain=(a:FolderIdentity[],b:FolderIdentity[])=>a.length===b.length&&a.every((item,i)=>sameIdentity(item,b[i]!));
/** Main-only checked metadata seam; this does not expose a renderer path API. */
export const inspectProjectFolderPath=inspect;
export const sameProjectFolderChain=sameChain;
export function captureFolderRoot(projectId:string,bindingId:string,target:string):FolderRoot{const root=checkedFolderPath(target),value=inspect(root,true);return {projectId,bindingId,root,chain:value.chain};}
export function verifyFolderRoot(root:FolderRoot):void{try{if(!sameChain(root.chain,inspect(root.root,true).chain))fail('ROOT_CHANGED');}catch{fail('ROOT_CHANGED');}}
export const folderDisplaySegments=(target:string)=>[path.parse(target).root.slice(0,1),...target.slice(path.parse(target).root.length).split(path.sep)];
function underRoot(root:string,target:string){const relative=path.relative(root,target);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))fail('UNSUPPORTED_FILE');}
export function scanProjectFolder(root:FolderRoot,limits:FolderScanLimits=PROJECT_FOLDER_LIMITS,now:()=>number=Date.now):{entries:ProjectFolderEntry[];nodes:Map<string,FolderNode>;truncated:boolean}{
 verifyFolderRoot(root);const started=now(),entries:ProjectFolderEntry[]=[],nodes=new Map<string,FolderNode>(),queue=[{path:root.root,parentId:null as string|null,depth:0,chain:root.chain}];let candidates=0,directories=0,bytes=512,truncated=false;
 const expired=()=>now()-started>=limits.scanMs;
 scan:while(queue.length){if(expired()||directories>=limits.directories){truncated=true;break;}const directory=queue.shift()!;let handle:fs.Dir|undefined;
  try{if(!sameChain(directory.chain,inspect(directory.path,true).chain))fail('ROOT_CHANGED');handle=fs.opendirSync(directory.path);directories++;
   while(true){if(expired()||candidates>=limits.candidates||entries.length>=limits.nodes){truncated=true;break scan;}const entry=handle.readSync();if(!entry)break;candidates++;if(!folderReadPartAllowed(entry.name)||entry.name.startsWith('.'))continue;
    const target=path.join(directory.path,entry.name);underRoot(root.root,target);let value:ReturnType<typeof inspect>;try{value=inspect(target,entry.isDirectory());}catch{continue;}if(!sameChain(value.chain.slice(0,root.chain.length),root.chain))fail('ROOT_CHANGED');
    if(expired()){truncated=true;break scan;}const kind=value.stat.isDirectory()?'directory':value.stat.isFile()?'file':null;if(!kind||(kind==='file'&&(!fileNameAllowed(entry.name)||value.stat.size>BigInt(PROJECT_FOLDER_LIMITS.fileBytes))))continue;
    const nodeId=randomUUID(),item:ProjectFolderEntry={nodeId,parentId:directory.parentId,name:entry.name,kind,size:kind==='file'?Number(value.stat.size):0},cost=Buffer.byteLength(JSON.stringify(item))+1;if(bytes+cost>limits.treeBytes){truncated=true;break scan;}bytes+=cost;entries.push(item);
    if(kind==='directory'){if(directory.depth+1>=limits.depth){truncated=true;}else queue.push({path:target,parentId:nodeId,depth:directory.depth+1,chain:value.chain});}
    else nodes.set(nodeId,{path:target,chain:value.chain,...identity(value.stat),size:String(value.stat.size),mtime:String(value.stat.mtimeNs),name:entry.name});
   }
   if(!sameChain(directory.chain,inspect(directory.path,true).chain))fail('ROOT_CHANGED');
  }catch(error){if(error instanceof ProjectFolderFsError)throw error;truncated=true;}finally{handle?.closeSync();}
 }
 verifyFolderRoot(root);return {entries,nodes,truncated};
}
export function openProjectFolderNode(root:FolderRoot,nodeId:string,node:FolderNode):{file:FileContext;segments:string[]}{
 verifyFolderRoot(root);underRoot(root.root,node.path);const check=()=>{const value=inspect(node.path,false);if(!sameChain(node.chain,value.chain)||!sameIdentity(node,identity(value.stat))||String(value.stat.size)!==node.size||String(value.stat.mtimeNs)!==node.mtime||value.stat.size>BigInt(PROJECT_FOLDER_LIMITS.fileBytes))fail('STALE_BINDING');return value.stat;};check();
 const fd=fs.openSync(node.path,'r');try{
  const checkFd=()=>{const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n||!sameIdentity(node,identity(stat))||String(stat.size)!==node.size||String(stat.mtimeNs)!==node.mtime)fail('STALE_BINDING');};
  const read=()=>{checkFd();const bytes=Buffer.alloc(Number(node.size)+1);let count=0;while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,count);if(!n)break;count+=n;}if(count!==Number(node.size))fail('STALE_BINDING');checkFd();return bytes.subarray(0,count);};
  const first=read();check();const second=read();if(createHash('sha256').update(first).digest('hex')!==createHash('sha256').update(second).digest('hex'))fail('STALE_BINDING');check();verifyFolderRoot(root);
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(second).replace(/\r\n?/gu,'\n');}catch{fail('UNSUPPORTED_FILE');}if(!validFileText(text!))fail('UNSUPPORTED_FILE');const totalLines=text!.split('\n').length;if(totalLines>PROJECT_FOLDER_LIMITS.lines)fail('LIMIT');return {file:{id:nodeId,name:node.name,text:text!,startLine:1,endLine:totalLines,totalLines},segments:folderDisplaySegments(node.path)};
 }finally{fs.closeSync(fd);}
}
