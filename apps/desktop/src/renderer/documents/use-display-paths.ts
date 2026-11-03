import {useEffect,useRef,useState} from 'react';
import {DISPLAY_PATH_VERSION,parseDisplayPathRecord,parseDisplayPathResult,type DisplayPathCode} from '../../shared/agent/display-paths';
const messages:Record<DisplayPathCode,string>={INVALID_REQUEST:'此路径格式无法保存，当前仍可查看文件。',CAPABILITY_DENIED:'路径保存连接已失效，请重新打开软件。',STORAGE_ERROR:'路径信息未能保存或恢复，当前仍可查看文件。',LIMIT:'已达到本地路径记录上限，此路径仅在本次打开时显示。',CONFLICT:'该快照已有不同路径记录，请重新打开原文件。'};
export function useDisplayPaths(documents:readonly {id:string;name:string}[]){
 const [paths,setPaths]=useState(new Map<string,readonly string[]>()),[error,setError]=useState(''),alive=useRef(true);
 const api=window.workbenchDisplayPaths,key=JSON.stringify(documents.map(d=>({id:d.id,name:d.name})));
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  let current=true;if(!api||!documents.length)return;
  void api.read({contractVersion:DISPLAY_PATH_VERSION,ids:documents.map(d=>d.id)}).then(raw=>{
   if(!current)return;const result=parseDisplayPathResult(raw);
   if(!result.ok){setError(messages[result.error.code]);return;}
   setPaths(previous=>{const next=new Map(previous);for(const record of result.records)if(documents.some(d=>d.id===record.id&&d.name===record.name)&&!next.has(record.id))next.set(record.id,record.segments);return next;});
  }).catch(()=>{if(current)setError(messages.STORAGE_ERROR);});
  return()=>{current=false;};
 },[api,key]);
 const remember=async(id:string,name:string,segments:readonly string[])=>{
  if(!segments.length)return;
  let record;try{record=parseDisplayPathRecord({id,name,segments:[...segments]});}catch{if(alive.current)setError(messages.INVALID_REQUEST);return;}
  if(alive.current)setPaths(previous=>new Map(previous).set(id,record.segments));
  if(!api){if(alive.current)setError('路径仅在本次打开时显示，请更新后重新打开文件。');return;}
  try{
   const result=parseDisplayPathResult(await api.remember({contractVersion:DISPLAY_PATH_VERSION,record}));
   if(alive.current){if(!result.ok)setError(messages[result.error.code]);else if(result.records.length!==1||JSON.stringify(result.records[0])!==JSON.stringify(record))setError(messages.STORAGE_ERROR);else setError('');}
  }catch{if(alive.current)setError(messages.STORAGE_ERROR);}
 };
 return {paths,error,remember};
}
