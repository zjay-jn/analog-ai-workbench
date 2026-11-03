import {CloudChatErrorV1,cloudProviderProfileV1} from '../../../../../packages/agent-adapters/src/cloud-chat-contract';

/** Main-only parser. The returned credential must never be serialized or logged. */
export function parseCloudCredentialCatalogV1(bytes:Uint8Array,provider:unknown):string {
  const selected=cloudProviderProfileV1(provider).provider;
  const unavailable=():never=>{throw new CloudChatErrorV1('NOT_CONFIGURED');};
  if(bytes.byteLength>65536)unavailable();
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return unavailable();}
  const lines=text.replace(/^\uFEFF/u,'').split(/\r?\n/u);
  const indexes:number[]=[];
  for(let i=0;i<lines.length;i++){
    const header=/^\s*(deepseek|kimi)\s*[:：]\s*$/iu.exec(lines[i]!);
    if(header?.[1]?.toLowerCase()===selected)indexes.push(i);
  }
  if(indexes.length!==1)unavailable();
  let next=indexes[0]!+1;while(next<lines.length&&!lines[next]!.trim())next++;
  const match=/^\s*(?:api[_ -]?key\s*[:=：]\s*)?(sk-[A-Za-z0-9_-]{8,512})\s*$/iu.exec(lines[next]??'');
  if(!match?.[1])unavailable();
  return match![1]!;
}
