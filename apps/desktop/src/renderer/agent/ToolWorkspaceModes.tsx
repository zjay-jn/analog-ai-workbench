import {useEffect,useState,type ReactNode} from 'react';

type Mode='chat'|'tools';
export function workspaceIsVisible(element:Pick<Element,'closest'>|null):boolean{
  return !!element&&!element.closest('[data-workspace-view][hidden]');
}

export function ToolWorkspaceModesView({mode,toolsVisited,onSelect,chat,tools}:{mode:Mode;toolsVisited:boolean;onSelect:(mode:Mode)=>void;chat:ReactNode;tools:ReactNode}){
  return <section className="tool-workspace-modes" aria-label="工作区模式">
    <nav className="tool-workspace-switch" aria-label="切换工作区">
      <button type="button" aria-pressed={mode==='chat'} aria-controls="workspace-chat" onClick={()=>onSelect('chat')}>聊天与文件</button>
      <button type="button" aria-pressed={mode==='tools'} aria-controls="workspace-tools" onClick={()=>onSelect('tools')}>工具任务</button>
    </nav>
    <div id="workspace-chat" className="tool-workspace-view tool-workspace-chat" data-workspace-view="chat" hidden={mode!=='chat'} inert={mode!=='chat'}>{chat}</div>
    <div id="workspace-tools" className="tool-workspace-view tool-workspace-tools" data-workspace-view="tools" hidden={mode!=='tools'} inert={mode!=='tools'}>{toolsVisited?tools:null}</div>
  </section>;
}

/** Mount tools on first explicit visit and retain both trees across subsequent visits. */
export function ToolWorkspaceModes({chat,tools,returnToChatRequest=0}:{chat:ReactNode;tools:ReactNode;returnToChatRequest?:number}){
  const [mode,setMode]=useState<Mode>('chat'),[toolsVisited,setToolsVisited]=useState(false);
  useEffect(()=>{if(returnToChatRequest)setMode('chat');},[returnToChatRequest]);
  return <ToolWorkspaceModesView mode={mode} toolsVisited={toolsVisited} chat={chat} tools={tools}
    onSelect={next=>{if(next==='tools')setToolsVisited(true);setMode(next);}}/>;
}
