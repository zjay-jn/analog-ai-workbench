import {useEffect,useRef,useState,type RefObject} from 'react';
import {workspaceIsVisible} from './ToolWorkspaceModes';

export const FIND_EVENT='workbench-find';
export function requestFind(target:'chat'|'file'|'result'){window.dispatchEvent(new CustomEvent(FIND_EVENT,{detail:target}));}

/** Match rendered message text, including words split across inline Markdown nodes. */
function findRanges(root:HTMLElement,query:string,matchCase:boolean,scope:string):Range[]{
 const ranges:Range[]=[];if(!query)return ranges;
 const blocks=root.querySelectorAll(scope==='result'?'p,h1,h2,h3,h4,h5,h6,li,pre,td,th,dt,dd':'.agent-user-message > p, .chat-question-record p, .chat-tool-failure, .streaming-reply p, .streaming-reply h1, .streaming-reply h2, .streaming-reply h3, .streaming-reply h4, .streaming-reply h5, .streaming-reply h6, .streaming-reply li, .streaming-reply blockquote, .streaming-reply pre, .streaming-reply td, .streaming-reply th');
 for(const block of blocks){
  if(block.closest('details:not([open])')&&!block.closest('summary'))continue;
  if(block.querySelector('p,li,pre,blockquote'))continue;
  const walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT),nodes:{node:Text;offset:number}[]=[];let text='',node:Node|null;
  while((node=walker.nextNode())){nodes.push({node:node as Text,offset:text.length});text+=node.textContent??'';}
  // Case mappings that change UTF-16 length need an offset-preserving match.
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase?'gu':'giu');
  for(const hit of text.matchAll(pattern)){
   const from=hit.index,to=from+hit[0].length,first=nodes.find(n=>n.offset+n.node.length>from),last=nodes.find(n=>n.offset+n.node.length>=to);
   if(!first||!last)continue;const range=document.createRange();range.setStart(first.node,from-first.offset);range.setEnd(last.node,to-last.offset);ranges.push(range);if(ranges.length>=1000)return ranges;
  }
 }
 return ranges;
}

export function ChatSearch({transcript,sessionId,onNavigate,scope='chat'}:{transcript:RefObject<HTMLDivElement|null>;sessionId:string;scope?:'chat'|'result';onNavigate:()=>void}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[matchCase,setMatchCase]=useState(false),[ranges,setRanges]=useState<Range[]>([]),[index,setIndex]=useState(0);
 const input=useRef<HTMLInputElement>(null),target=useRef<'chat'|'file'|'result'>('chat'),navigate=useRef(onNavigate);navigate.current=onNavigate;
 useEffect(()=>{target.current='chat';setQuery('');setRanges([]);setIndex(0);},[sessionId]);
 useEffect(()=>{
  const choose=(event:Event)=>{if(!workspaceIsVisible(transcript.current))return;const element=event.target;if(element instanceof Element)target.current=element.closest('.agent-result-document')?'result':element.closest('.file-source,.file-search')?'file':'chat';};
  const shortcut=(event:KeyboardEvent)=>{if(!workspaceIsVisible(transcript.current)||event.defaultPrevented||!event.ctrlKey||event.altKey||event.metaKey||event.isComposing||event.key.toLowerCase()!=='f'||document.querySelector('dialog[open]'))return;event.preventDefault();if(!event.shiftKey&&!event.repeat){const result=document.querySelector('.agent-result-document');requestFind(target.current==='result'&&(!result||result.closest('[hidden]'))?'chat':target.current);}};
  const find=(event:Event)=>{if(!workspaceIsVisible(transcript.current))return;const selectedScope=(event as CustomEvent).detail;setOpen(selectedScope===scope);if(selectedScope===scope)requestAnimationFrame(()=>{if(!workspaceIsVisible(transcript.current))return;input.current?.focus();input.current?.select();});};
  if(scope==='chat'){document.addEventListener('pointerdown',choose,true);document.addEventListener('focusin',choose,true);window.addEventListener('keydown',shortcut);}window.addEventListener(FIND_EVENT,find);
  return()=>{if(scope==='chat'){document.removeEventListener('pointerdown',choose,true);document.removeEventListener('focusin',choose,true);window.removeEventListener('keydown',shortcut);}window.removeEventListener(FIND_EVENT,find);};
 },[scope]);
 useEffect(()=>{
  const root=transcript.current;if(!open||!root){setRanges([]);return;}
  const scan=()=>setRanges(findRanges(root,query,matchCase,scope));scan();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const observer=new MutationObserver(()=>{if(timer===undefined)timer=setTimeout(()=>{timer=undefined;scan();},100);});
  observer.observe(root,{childList:true,characterData:true,subtree:true});
  return()=>{observer.disconnect();if(timer!==undefined)clearTimeout(timer);};
 },[open,query,matchCase,sessionId,transcript,scope]);
 useEffect(()=>{setIndex(0);},[query,matchCase,sessionId]);
 const current=ranges.length?Math.min(index,ranges.length-1):0;
 useEffect(()=>{
  CSS.highlights.set(scope+'-find',new Highlight(...ranges));
  const range=ranges[current];CSS.highlights.set(scope+'-find-current',new Highlight(...(range?[range]:[])));
  if(range&&transcript.current){navigate.current();const rect=range.getBoundingClientRect(),box=transcript.current.getBoundingClientRect();transcript.current.scrollTop+=rect.top-box.top-box.height/2;}
  return()=>{CSS.highlights.delete(scope+'-find');CSS.highlights.delete(scope+'-find-current');};
 },[ranges,current,transcript,scope]);
 const close=()=>{setOpen(false);transcript.current?.focus();};
 const step=(delta:number)=>setIndex(ranges.length?(current+delta+ranges.length)%ranges.length:0);
 if(!open)return null;
 return <div className="chat-find-bar" role="search" aria-label={scope==='chat'?'当前聊天查找':'当前结果查找'} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}else if(event.key==='Enter'){event.preventDefault();step(event.shiftKey?-1:1);}}}>
  <input ref={input} type="search" aria-label={scope==='chat'?'查找聊天内容':'查找结果内容'} placeholder={scope==='chat'?'查找当前聊天':'查找当前结果'} maxLength={120} value={query} onChange={event=>setQuery(event.target.value)}/>
  <span className="chat-find-count" role="status">{!query?'':ranges.length?`${current+1}/${ranges.length}${ranges.length===1000?'+':''}`:'无匹配'}</span>
  <button type="button" className="icon-button" aria-label="聊天查找区分大小写" aria-pressed={matchCase} title="区分大小写" onClick={()=>setMatchCase(value=>!value)}>Aa</button>
  <button type="button" className="icon-button" aria-label="上一个聊天匹配" title="上一个（Shift+Enter）" disabled={!ranges.length} onClick={()=>step(-1)}>↑</button>
  <button type="button" className="icon-button" aria-label="下一个聊天匹配" title="下一个（Enter）" disabled={!ranges.length} onClick={()=>step(1)}>↓</button>
  <button type="button" className="icon-button" aria-label="关闭聊天查找" title="关闭（Esc）" onClick={close}>×</button>
 </div>;
}
