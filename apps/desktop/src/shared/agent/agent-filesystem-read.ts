import type {ProjectReadPosition} from './agent-project-read';
export const FILESYSTEM_TOOL_NAMES=['fs_list','fs_find','fs_search','fs_read'] as const;
export type FileSystemToolName=typeof FILESYSTEM_TOOL_NAMES[number];
export const FILESYSTEM_OS_CODES=['ENOENT','EACCES','EPERM','ENOTDIR','EISDIR','EBUSY','EIO'] as const;
export type FileSystemOsCode=typeof FILESYSTEM_OS_CODES[number];
export type FileSystemSourceRef=Readonly<{kind:'windows_filesystem';sourceId:string;rootPath:string;rootIdentity:string}>;
export type FileSystemLocation=FileSystemSourceRef&Readonly<{absolutePath:string}>;
export type FileSystemReadScope=Readonly<{kind:'windows_filesystem';projectId:string;bindingId:null;sourceId:string;identity:string;directoryId:string|null;absoluteDirectory:string;relativeDirectory:string}>;
type Listing=Readonly<{path:string|null;directoryId:string|null;cursor:string|null;refresh:boolean}>;
export type FileSystemToolArguments={
 fs_list:Listing;
 fs_find:Listing&Readonly<{query:string}>;
 fs_search:Listing&Readonly<{fileId:string|null;query:string}>;
 fs_read:Readonly<{path:string|null;fileId:string|null;version:string|null;start:ProjectReadPosition;cursor:string|null}>;
};
export type FileSystemNextArguments={ [K in FileSystemToolName]:Readonly<{toolName:K;arguments:FileSystemToolArguments[K]}> }[FileSystemToolName];
export const isFileSystemToolName=(v:unknown):v is FileSystemToolName=>typeof v==='string'&&(FILESYSTEM_TOOL_NAMES as readonly string[]).includes(v);
const byteLength=(v:string)=>new TextEncoder().encode(v).length;
export function fileSystemPathText(value:unknown):string{
 if(typeof value!=='string'||!value.trim()||byteLength(value)>8192||/[\u0000-\u001f\u007f-\u009f\p{Surrogate}\p{Bidi_Control}]/u.test(value))throw new TypeError('Invalid filesystem path');return value;
}
const id=(v:unknown)=>typeof v==='string'&&byteLength(v)<=256&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(v);
export function parseFileSystemToolArguments<K extends FileSystemToolName>(name:K,input:unknown):FileSystemToolArguments[K]|null{
 try{
  if(!isFileSystemToolName(name)||!input||typeof input!=='object'||Object.getPrototypeOf(input)!==Object.prototype)return null;
  const keys=name==='fs_read'?['path','fileId','version','start','cursor']:['path','directoryId','cursor','refresh',...(name==='fs_search'?['fileId']:[]),...(name==='fs_find'||name==='fs_search'?['query']:[])];
  if(Reflect.ownKeys(input).length!==keys.length)return null;const v:Record<string,unknown>={};
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(input,k);if(!d||!d.enumerable||!('value'in d))return null;v[k]=d.value;}
  if(v.path!==null)fileSystemPathText(v.path);
  for(const k of ['directoryId','fileId','cursor'])if(keys.includes(k)&&v[k]!==null&&!id(v[k]))return null;
  if([v.path,keys.includes('directoryId')?v.directoryId:null,keys.includes('fileId')?v.fileId:null].filter(x=>x!==null).length>1)return null;
  if(name==='fs_read'){
   if(v.path===null&&v.fileId===null)return null;if(v.version!==null&&(typeof v.version!=='string'||!/^([a-f0-9]{64})$/u.test(v.version)))return null;
   const p=v.start;if(!p||typeof p!=='object'||Object.getPrototypeOf(p)!==Object.prototype||Reflect.ownKeys(p).length!==2)return null;
   for(const [k,max] of [['line',500000],['column',16777217]] as const){const d=Object.getOwnPropertyDescriptor(p,k);if(!d||!d.enumerable||!('value'in d)||!Number.isSafeInteger(d.value)||d.value<1||d.value>max)return null;}
  }else{
   if(typeof v.refresh!=='boolean'||v.refresh&&v.cursor!==null)return null;
   if(name!=='fs_list'&&(typeof v.query!=='string'||!v.query||byteLength(v.query)>256||/[\r\n\u0000\p{Surrogate}]/u.test(v.query)))return null;
  }
  if(v.cursor!==null&&v.path!==null)return null;
  return structuredClone(v) as FileSystemToolArguments[K];
 }catch{return null;}
}
