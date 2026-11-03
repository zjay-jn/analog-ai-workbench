import fs from 'node:fs';
import path from 'node:path';
import {CloudChatErrorV1,cloudProviderProfileV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';
import {parseCloudCredentialCatalogV1} from './credential-catalog';

/** Both paths are main-owned configuration, never IPC/Renderer inputs. */
export function readCloudCredentialFileV1(input:Readonly<{provider:unknown;filePath:string;authorizedFilePath:string}>):string {
  const provider=cloudProviderProfileV1(input.provider).provider;
  let descriptor:number|undefined;const bytes=Buffer.alloc(65537);
  try{
    const file=path.resolve(input.filePath);const authorized=path.resolve(input.authorizedFilePath);
    const normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
    if(normalize(file)!==normalize(authorized))throw new CloudChatErrorV1('NOT_CONFIGURED');
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.size>65536||normalize(fs.realpathSync(file))!==normalize(authorized))throw new CloudChatErrorV1('NOT_CONFIGURED');
    descriptor=fs.openSync(file,fs.constants.O_RDONLY);
    const opened=fs.fstatSync(descriptor);const after=fs.lstatSync(file);
    if(!opened.isFile()||after.isSymbolicLink()||opened.dev!==before.dev||opened.ino!==before.ino||opened.dev!==after.dev||opened.ino!==after.ino||normalize(fs.realpathSync(file))!==normalize(authorized))throw new CloudChatErrorV1('NOT_CONFIGURED');
    let length=0;while(length<bytes.length){const count=fs.readSync(descriptor,bytes,length,bytes.length-length,length);if(count===0)break;length+=count;}
    return parseCloudCredentialCatalogV1(bytes.subarray(0,length),provider);
  }catch(error){throw error instanceof CloudChatErrorV1?error:new CloudChatErrorV1('NOT_CONFIGURED');}
  finally{bytes.fill(0);if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}}
}
