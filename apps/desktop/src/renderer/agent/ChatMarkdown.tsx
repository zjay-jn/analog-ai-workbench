import {MAX_REPLY_BYTES} from '../../shared/agent/reply-limits';
import {memo,useEffect,useMemo,useRef,useState} from 'react';
import type {ReactNode} from 'react';

/** Deliberately small Markdown subset. All model content remains React text. */
export type ChatBlock =
  | {kind:'paragraph'|'quote';text:string}
  | {kind:'heading';level:number;text:string}
  | {kind:'rule'}
  | {kind:'code';language:string;text:string}
  | {kind:'list';ordered:boolean;start:number;items:string[]}
  | {kind:'table';header:string[];rows:string[][]};
const fence=/^ {0,3}(`{3,}|~{3,})(.*)$/u;
const list=/^\s{0,3}([-+*]|\d{1,6}[.)])\s+(.+)$/u;
const heading=/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u;
const rule=/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const cells=(line:string)=>line.trim().replace(/^\|/u,'').replace(/\|$/u,'').split(/(?<!\\)\|/u).map(cell=>cell.trim().replace(/\\\|/gu,'|'));
const tableRule=(line:string)=>line.includes('|')&&cells(line).every(cell=>/^:?-{3,}:?$/u.test(cell));
export function parseChatMarkdown(text:string):readonly ChatBlock[] {
  if(new TextEncoder().encode(text).length>MAX_REPLY_BYTES)return [{kind:'paragraph',text}];
  const lines=text.replace(/\r\n?/gu,'\n').split('\n'),blocks:ChatBlock[]=[];
  let index=0,nodes=0;
  const startsBlock=(line:string)=>!line.trim()||fence.test(line)||heading.test(line)||rule.test(line)||list.test(line)||/^ {0,3}>/u.test(line);
  while(index<lines.length){
    if(++nodes>1024)return [{kind:'paragraph',text}];
    const line=lines[index]!;if(!line.trim()){index++;continue;}
    const code=fence.exec(line);
    if(code){
      const body:string[]=[],marker=code[1]!,closing=new RegExp('^ {0,3}'+marker[0]+'{'+marker.length+',}\\s*$','u');index++;
      while(index<lines.length&&!closing.test(lines[index]!))body.push(lines[index++]!);
      const closed=index<lines.length;if(closed)index++;
      blocks.push({kind:'code',language:code[2]!.trim().slice(0,48),text:body.join('\n')+(closed&&body.length?'\n':'')});continue;
    }
    const title=heading.exec(line);if(title){blocks.push({kind:'heading',level:title[1]!.length,text:title[2]!});index++;continue;}
    if(rule.test(line)){blocks.push({kind:'rule'});index++;continue;}
    if(index+1<lines.length&&line.includes('|')&&tableRule(lines[index+1]!)){
      const header=cells(line),rows:string[][]=[];index+=2;
      while(index<lines.length&&lines[index]!.trim()&&lines[index]!.includes('|')){rows.push(cells(lines[index++]!));nodes++;}
      if(header.length>32||rows.some(row=>row.length>32)||nodes>1024)return [{kind:'paragraph',text}];
      blocks.push({kind:'table',header,rows});continue;
    }
    const item=list.exec(line);
    if(item){
      const ordered=/^\d/u.test(item[1]!),items:string[]=[];const start=ordered?Number.parseInt(item[1]!,10):1;
      while(index<lines.length){const next=list.exec(lines[index]!);if(!next||/^\d/u.test(next[1]!)!==ordered)break;items.push(next[2]!);index++;nodes++;}
      blocks.push({kind:'list',ordered,start,items});continue;
    }
    if(/^ {0,3}>/u.test(line)){
      const quoted:string[]=[];while(index<lines.length&&/^ {0,3}>/u.test(lines[index]!))quoted.push(lines[index++]!.replace(/^ {0,3}> ?/u,''));blocks.push({kind:'quote',text:quoted.join('\n')});continue;
    }
    const paragraph=[line];index++;
    while(index<lines.length&&!startsBlock(lines[index]!)){
      if(index+1<lines.length&&lines[index]!.includes('|')&&tableRule(lines[index+1]!))break;
      paragraph.push(lines[index++]!);
    }
    blocks.push({kind:'paragraph',text:paragraph.join('\n')});
  }
  return nodes>1024?[{kind:'paragraph',text}]:blocks;
}

function inline(text:string,depth=0,budget={left:4096}):ReactNode {
  if(depth>=4)return text;const output:ReactNode[]=[];let plain='',index=0;
  const flush=()=>{if(plain){output.push(plain);plain='';}};
  while(index<text.length){
    if(budget.left--<=0){plain+=text.slice(index);break;}
    if(text[index]==='\\'&&/[\\`*_[\]#]/u.test(text[index+1]??'')){plain+=text[index+1];index+=2;continue;}
    const image=text.startsWith('![',index),link=text[index]==='[';
    if(image||link){
      const offset=image?2:1,labelMatch=text.slice(index+offset,index+1026).indexOf(']('),labelEnd=labelMatch<0?-1:index+offset+labelMatch;
      const urlMatch=labelEnd<0?-1:text.slice(labelEnd+2,labelEnd+2050).indexOf(')'),urlEnd=urlMatch<0?-1:labelEnd+2+urlMatch;
      if(labelEnd>=0&&urlEnd>=0&&labelEnd-index<=1024&&urlEnd-labelEnd<=2048){
        flush();output.push(<span className="chat-inert-link" key={index}>{image?'[图片] ':''}{text.slice(index+offset,labelEnd)}{' ('}{text.slice(labelEnd+2,urlEnd)}{')'}</span>);index=urlEnd+1;continue;
      }
    }
    const marker=text.startsWith('**',index)?'**':text.startsWith('__',index)?'__':text[index]==='`'?'`':text[index]==='*'?'*':null;
    if(marker){
      const end=text.indexOf(marker,index+marker.length);
      if(end>index+marker.length){
        flush();const content=text.slice(index+marker.length,end);
        output.push(marker==='`'?<code key={index}>{content}</code>:marker.length===2?<strong key={index}>{inline(content,depth+1,budget)}</strong>:<em key={index}>{inline(content,depth+1,budget)}</em>);index=end+marker.length;continue;
      }
    }
    plain+=text[index++];
  }
  flush();return output;
}

export async function copyChatText(text:string):Promise<void> {
  try{if(navigator.clipboard){await navigator.clipboard.writeText(text);return;}}catch{/* Fall back to the existing browser copy gesture. */}
  const selection=document.getSelection(),ranges=selection?Array.from({length:selection.rangeCount},(_,index)=>selection.getRangeAt(index).cloneRange()):[];
  const active=document.activeElement as HTMLElement|null,field=document.createElement('textarea');field.value=text;field.className='chat-copy-buffer';field.setAttribute('readonly','');document.body.append(field);
  try{field.select();if(!document.execCommand('copy'))throw Error('Copy unavailable');}
  finally{field.remove();active?.focus({preventScroll:true});selection?.removeAllRanges();for(const range of ranges)selection?.addRange(range);}
}
export function ChatCopyButton({text,label='复制回复'}:{readonly text:string;readonly label?:string}):React.JSX.Element {
  const [result,setResult]=useState('');const busy=useRef(false);
  useEffect(()=>{if(!result)return;const timer=setTimeout(()=>setResult(''),2000);return()=>clearTimeout(timer);},[result]);
  return <button className="chat-copy-button chat-copy-icon" type="button" aria-label={label} title={result||label} onClick={()=>{
    if(busy.current)return;busy.current=true;setResult('');void copyChatText(text).then(()=>setResult('已复制'),()=>setResult('复制失败，请选择文字复制')).finally(()=>{busy.current=false;});
  }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{result==='已复制'?<path d="m5 12 4 4 10-10"/>:result?<><path d="m7 7 10 10M17 7 7 17"/></>:<><rect x="8" y="8" width="12" height="13" rx="1.5"/><path d="M16 8V3H3v13h5"/></>}</svg><span className="chat-copy-feedback" role="status">{result}</span></button>;
}
export const ChatMarkdown=memo(function ChatMarkdown({text}:{readonly text:string}):React.JSX.Element {
  const blocks=useMemo(()=>parseChatMarkdown(text),[text]);
  return <div className="chat-markdown">{blocks.map((block,index)=>{
    switch(block.kind){
      case 'rule':return <hr key={index}/>;
      case 'heading':{const Tag=`h${block.level}` as 'h1'|'h2'|'h3'|'h4'|'h5'|'h6';return <Tag key={index}>{inline(block.text)}</Tag>;}
      case 'paragraph':return <p key={index}>{inline(block.text)}</p>;
      case 'quote':return <blockquote key={index}>{inline(block.text)}</blockquote>;
      case 'code':return <div className="chat-code-block" key={index}><div className="chat-code-heading"><span>{block.language||'代码'}</span><ChatCopyButton text={block.text} label="复制代码"/></div><pre><code>{block.text}</code></pre></div>;
      case 'list':{const items=block.items.map((item,i)=><li key={i}>{inline(item)}</li>);return block.ordered?<ol key={index} start={block.start}>{items}</ol>:<ul key={index}>{items}</ul>;}
      case 'table':return <div className="chat-table-wrap" key={index} tabIndex={0} role="region" aria-label="回复表格"><table><thead><tr>{block.header.map((cell,i)=><th key={i} scope="col">{inline(cell)}</th>)}</tr></thead><tbody>{block.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
    }
  })}</div>;
});
