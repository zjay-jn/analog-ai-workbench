import type {FileContext} from '../../shared/agent/file-context';

export const SEARCH_QUERY_LIMIT=120,SEARCH_RESULT_LIMIT=100;
export type FileSearchHit={documentId:string;name:string;line:number;before:string;match:string;after:string};
export type FileSearchResult={hits:FileSearchHit[];hasMore:boolean};

/** Literal, local snapshot search. Results keep source line numbers, including excerpts. */
export function searchFileSnapshots(documents:readonly FileContext[],query:string,caseSensitive=false):FileSearchResult{
 const result:FileSearchResult={hits:[],hasMore:false};
 if(!query.trim()||query.length>SEARCH_QUERY_LIMIT||/[\r\n]/u.test(query))return result;
 const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),caseSensitive?'u':'iu');
 for(const document of documents){
  const lines=document.text.split('\n');
  for(let offset=0;offset<lines.length;offset++){
   const line=lines[offset]!,match=pattern.exec(line);if(!match)continue;
   if(result.hits.length===SEARCH_RESULT_LIMIT){result.hasMore=true;return result;}
   const before=Array.from(line.slice(0,match.index)),after=Array.from(line.slice(match.index+match[0].length));
   result.hits.push({documentId:document.id,name:document.name,line:document.startLine+offset,before:(before.length>48?'…':'')+before.slice(-48).join(''),match:match[0],after:after.slice(0,100).join('')+(after.length>100?'…':'')});
  }
 }
 return result;
}
