import {useEffect,useRef,useState} from 'react';import {ChatMarkdown} from './ChatMarkdown';import {advanceStreamingText} from './streaming-text';
type Status='running'|'completed'|'failed'|'cancelled'|'interrupted';
export function StreamingReply({text,status,onAdvance}:{text:string;status:Status;onAdvance:()=>void}){
 // Mounted history/current snapshots are immediate; only newly received text animates.
 const [shown,setShown]=useState(text),[reduceMotion,setReduceMotion]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 const current=useRef(text),target=useRef(text),frame=useRef<number|null>(null),lastTime=useRef(0);
 useEffect(()=>{const query=window.matchMedia('(prefers-reduced-motion: reduce)'),change=()=>setReduceMotion(query.matches);query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
 useEffect(()=>{
  const flush=()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;current.current=target.current;setShown(target.current);};
  const visibility=()=>{if(document.hidden)flush();};document.addEventListener('visibilitychange',visibility);
  return()=>{document.removeEventListener('visibilitychange',visibility);if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;};
 },[]);
 useEffect(()=>{
  target.current=text;
  if(reduceMotion||document.hidden||!['running','completed'].includes(status)||!text.startsWith(current.current)){
   if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;current.current=text;setShown(text);return;
  }
  if(current.current===text||frame.current!==null)return;
  lastTime.current=performance.now();
  const step=(now:number)=>{frame.current=null;const next=advanceStreamingText(current.current,target.current,now-lastTime.current);lastTime.current=now;current.current=next;setShown(next);if(next!==target.current)frame.current=requestAnimationFrame(step);};
  frame.current=requestAnimationFrame(step);
 },[text,status,reduceMotion]);
 useEffect(()=>{onAdvance();},[shown,onAdvance]);
 return <div className="streaming-reply" data-revealing={shown!==text?'true':'false'} aria-busy={status==='running'||shown!==text}>{shown?<ChatMarkdown text={shown}/>:<p>{status==='running'?'等待模型回复…':'尚未收到回复。'}</p>}</div>;
}
