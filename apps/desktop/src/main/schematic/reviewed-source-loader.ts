import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {FOLDED_SOURCE_FILES,sha256,type FoldedSourceFiles} from '../../../../../packages/schematic-workbench/src/folded-source-profile';
import {adaptFoldedReviewedSources} from '../../../../../packages/schematic-workbench/src/folded-adapter';
import {validateReviewedSchematicEnvelope} from '../../../../../packages/schematic-workbench/src/reviewed-display-validation';
import type {ReviewedSchematicEnvelope} from '../../../../../packages/schematic-workbench/src/reviewed-display';

function fail():never{throw new Error('Reviewed asset unavailable');}
const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function directories(directory:string):void{
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory()||!equalPath(fs.realpathSync.native(current),current))fail();
  }
}
function sameFile(a:fs.Stats,b:fs.Stats):boolean{return a.nlink===1&&b.nlink===1&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&b.isFile()&&!b.isSymbolicLink();}
/** Internal fixed application asset reader. No IPC/path/env/manifest path is accepted. Pins limit content even under local races; this is not a general hostile same-user filesystem guarantee. */
export function createReviewedSourceLoader(applicationRoot:string):()=>ReviewedSchematicEnvelope{
  const root=path.resolve(applicationRoot),directory=path.join(root,'.local','reviewed-schematic','folded-v1');let cached:ReviewedSchematicEnvelope|undefined;
  return ()=>{
    directories(directory);const rows:Partial<Record<keyof FoldedSourceFiles,string>>={};
    for(const name of Object.keys(FOLDED_SOURCE_FILES) as (keyof FoldedSourceFiles)[]){
      const file=path.join(directory,name),before=fs.lstatSync(file),limit=name==='review.json'?16384:1048576;
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>limit||!equalPath(fs.realpathSync.native(file),file))fail();
      const fd=fs.openSync(file,fs.constants.O_RDONLY);
      try{
        const initial=fs.fstatSync(fd);if(!sameFile(before,initial))fail();
        const buffer=Buffer.alloc(limit+1);let used=0,count=0;do{count=fs.readSync(fd,buffer,used,buffer.length-used,null);used+=count;}while(count&&used<buffer.length);
        if(used>limit||used!==initial.size||!sameFile(initial,fs.fstatSync(fd)))fail();
        const bytes=buffer.subarray(0,used);if(createHash('sha256').update(bytes).digest('hex')!==FOLDED_SOURCE_FILES[name])fail();
        const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        if(sha256(raw)!==FOLDED_SOURCE_FILES[name]||!sameFile(initial,fs.lstatSync(file))||!equalPath(fs.realpathSync.native(file),file))fail();rows[name]=raw;
      }finally{fs.closeSync(fd);}
    }
    directories(directory);
    if(!cached)cached=validateReviewedSchematicEnvelope(adaptFoldedReviewedSources(rows as FoldedSourceFiles));return cached;
  };
}
