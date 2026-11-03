import type {ReactNode} from 'react';
import type {SessionTurn} from '../../shared/agent/chat-sessions';
import type {FileContext} from '../../shared/agent/file-context';
import type {SchematicContext} from '../../shared/schematic/reviewed-schematic';
import {ChatCopyButton} from './ChatMarkdown';
import {ImagePreview} from './image-input';

/** One user message and its assistant content; tool parts use the same assistant slot. */
export function ChatAgentTurn({turn,onOpenFile,onPreviewSchematic,children}:{
 turn:Pick<SessionTurn,'id'|'status'|'user'|'images'|'files'|'schematics'>;
 onOpenFile:(file:FileContext)=>void;onPreviewSchematic:(context:SchematicContext)=>void;children:ReactNode;
}){
 return <div className="cloud-turn" data-turn-state={turn.status} data-turn-id={turn.id}>
  <div className="agent-message agent-user-message">
   <div className="image-preview-list">{turn.images?.map(image=><ImagePreview image={image} key={image.id}/>)}</div>
   <div className="file-context-list">{turn.files?.map((file,index)=><button type="button" className="chat-copy-button" key={file.id} onClick={()=>onOpenFile(file)}>文件{index+1} · {file.name} · L{file.startLine}–{file.endLine}</button>)}</div>
   <div className="file-context-list">{turn.schematics?.map((context,index)=><button type="button" className="chat-copy-button" key={context.previewDigest} onClick={()=>onPreviewSchematic(context)}>原理图{index+1} · {context.excerpt.title}</button>)}</div>
   <p>{turn.user}</p><div className="user-copy-actions"><ChatCopyButton text={turn.user} label="复制提问"/></div>
  </div>
  <div className="agent-message cloud-assistant-message">{children}</div>
 </div>;
}

export type ChatToolIcon='file'|'folder'|'search'|'command'|'edit'|'skill'|'waveform'|'activity';
const toolIconPaths:Record<ChatToolIcon,string>={
 file:'M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8l-5-5M14 3v5h7M7 13h10M7 17h7',
 folder:'M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18',
 search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
 command:'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M7 8l3 3-3 3M13 15h4',
 edit:'M14 5l5 5M4 20l5-1L21 7a2.8 2.8 0 0 0-4-4L5 15l-1 5',
 skill:'M12 2l2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7L12 2',
 waveform:'M2 12h4l3-8 6 16 3-8h4',
 activity:'M5 5h14v14H5V5M9 9h6v6H9V9',
};
export function ChatToolDisclosure({label,state,subject='',summarySubject=subject,durationMs,icon='activity',tone='neutral',children}:{label:string;state:string;subject?:string;summarySubject?:string;durationMs?:number;icon?:ChatToolIcon;tone?:'neutral'|'running'|'attention'|'error';children:ReactNode}){
 const showState=tone==='attention'||tone==='error';
 const title=Array.from([label,subject,showState?state:''].filter(Boolean).join(' · '));
 const duration=durationMs!==undefined&&Number.isFinite(durationMs)&&durationMs>=0
  ?durationMs<1000?`${Math.round(durationMs)} 毫秒`:`${Number((durationMs/1000).toFixed(1))} 秒`:null;
 return <details className="chat-tool-disclosure" data-tone={tone}>
  <summary title={title.length>200?title.slice(0,200).join('')+'…':title.join('')}>
   {tone==='running'?<span className="chat-tool-progress" aria-hidden="true"/>:<svg className="chat-tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={toolIconPaths[icon]}/></svg>}
   <span className="chat-tool-label">{label}</span>
   {summarySubject&&<span className="chat-tool-subject">{summarySubject}</span>}
   {duration&&<small className="chat-tool-duration" title="工具调用耗时">{duration}</small>}
   {showState&&<small className="chat-tool-state">{state}</small>}
   <svg className="chat-tool-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4"/></svg>
  </summary>
  <div className="chat-tool-details">{subject&&<p className="chat-tool-target">{subject}</p>}{children}</div>
 </details>;
}
