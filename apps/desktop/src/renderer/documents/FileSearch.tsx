import {useEffect,useMemo,useRef,useState} from 'react';
import type {FileContext} from '../../shared/agent/file-context';
import {SEARCH_QUERY_LIMIT,searchFileSnapshots,type FileSearchHit} from './file-search';

export function FileSearch({documents,onChoose,onClose}:{documents:readonly FileContext[];onChoose:(hit:FileSearchHit)=>void;onClose:()=>void}){
 const [query,setQuery]=useState(''),[matchCase,setMatchCase]=useState(false),input=useRef<HTMLInputElement>(null);
 const result=useMemo(()=>searchFileSnapshots(documents,query,matchCase),[documents,query,matchCase]);
 useEffect(()=>{input.current?.focus();},[]);
 return <section className="file-search" aria-label="当前文件查找" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}}}>
  <div className="file-search-controls"><input ref={input} type="search" aria-label="查找文件内容" placeholder="查找当前文件" maxLength={SEARCH_QUERY_LIMIT} value={query} onChange={e=>setQuery(e.target.value)}/><button type="button" className="icon-button" aria-label="区分大小写" aria-pressed={matchCase} title="区分大小写" onClick={()=>setMatchCase(value=>!value)}>Aa</button><button type="button" className="icon-button" aria-label="关闭文件查找" title="关闭查找（Esc）" onClick={onClose}>×</button></div>
  <p className="file-search-summary" role="status">{!documents.length?'先打开文本文件，即可查找。':!query.trim()?'查找当前文件。':result.hasMore?'显示前100个匹配行，请缩短查找范围或补充关键词。':result.hits.length?result.hits.length+' 个匹配行 · 点击定位原文':'没有找到匹配内容。'}</p>
  {result.hits.length>0&&<ul className="file-search-results" aria-label="文件查找结果">{result.hits.map(hit=><li key={hit.documentId+':'+hit.line}><button type="button" aria-label={'定位 '+hit.name+' 第'+hit.line+'行'} onClick={()=>onChoose(hit)}><span className="file-search-location">{hit.name}<small>L{hit.line}</small></span><span className="file-search-preview">{hit.before}<mark>{hit.match}</mark>{hit.after}</span></button></li>)}</ul>}
 </section>;
}
