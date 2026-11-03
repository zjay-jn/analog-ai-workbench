import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {WorkspaceDisk} from '../../shared/agent/project-workspace';
import {SidebarContextMenu,sidebarMenuAnchor,type SidebarMenuAnchor} from './SidebarContextMenu';
export function ProjectPicker({state,disabled,onSwitch,onName,onCreate,onCreateSession,renderSessions,visibleProjectIds,forceExpanded=false,folderTitles={}}:{state:WorkspaceDisk;disabled:boolean;onSwitch:(id:string)=>void;onName:(name:string,create:boolean,id?:string)=>Promise<boolean>;onCreate?:()=>void;onCreateSession:(id:string)=>void;renderSessions:(id:string)=>ReactNode;visibleProjectIds?:Set<string>;forceExpanded?:boolean;folderTitles?:Readonly<Record<string,string>>}){
 const [mode,setMode]=useState<'rename'|null>(null),[name,setName]=useState(''),[target,setTarget]=useState(''),[busy,setBusy]=useState(false),[collapsed,setCollapsed]=useState<Record<string,boolean>>({}),dialog=useRef<HTMLDialogElement>(null);
 const [menu,setMenu]=useState<{id:string;anchor:SidebarMenuAnchor}|null>(null),menuProject=state.projects.find(p=>p.id===menu?.id);
 useEffect(()=>{setCollapsed(current=>({...current,[state.activeId]:false}));},[state.activeId]);
 useEffect(()=>{if(mode)dialog.current?.showModal();return()=>dialog.current?.close();},[mode]);
 return <><div className="project-list-heading"><span>项目</span><button className="icon-button" title="新建项目" aria-label="新建项目" disabled={disabled||!onCreate||state.projects.length>=12} onClick={onCreate}>＋</button></div>
 <nav className="project-list" aria-label="项目与会话">{state.projects.filter(p=>!visibleProjectIds||visibleProjectIds.has(p.id)).map(p=><section className="project-group" key={p.id} data-project-id={p.id} aria-label={p.name}>
  <div className="project-row" title={folderTitles[p.id]??p.name} onContextMenu={event=>setMenu({id:p.id,anchor:sidebarMenuAnchor(event)})}>
   <button type="button" className="project-toggle" title={folderTitles[p.id]??p.name} disabled={forceExpanded} aria-label={`${!forceExpanded&&collapsed[p.id]?'展开':'收起'}项目 ${p.name}`} aria-expanded={forceExpanded||!collapsed[p.id]} aria-controls={`project-sessions-${p.id}`} onClick={()=>setCollapsed(current=>({...current,[p.id]:!current[p.id]}))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{forceExpanded||!collapsed[p.id]?<path d="m6 14 1.5-3a2 2 0 0 1 1.8-1H20a2 2 0 0 1 1.9 2.6l-1.5 5A2 2 0 0 1 18.4 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1"/>:<path d="M20 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2Z"/>}</svg></button>
   <button type="button" className="project-select" title={folderTitles[p.id]??p.name} aria-current={p.id===state.activeId?'true':undefined} disabled={disabled} onClick={()=>{setCollapsed(current=>({...current,[p.id]:false}));onSwitch(p.id);}}>{p.name}</button>
  </div>
  <div id={`project-sessions-${p.id}`} hidden={!forceExpanded&&!!collapsed[p.id]}><div className="project-sessions">{renderSessions(p.id)}</div></div>
 </section>)}</nav>
 {menu&&menuProject&&<SidebarContextMenu anchor={menu.anchor} onClose={()=>setMenu(null)} items={[
  {label:'新建聊天',disabled,action:()=>{setCollapsed(current=>({...current,[menuProject.id]:false}));onCreateSession(menuProject.id);}},
  {label:'重命名项目',disabled,action:()=>{setTarget(menuProject.id);setName(menuProject.name);setMode('rename');}},
  {label:!forceExpanded&&collapsed[menuProject.id]?'展开项目':'收起项目',disabled:forceExpanded,action:()=>setCollapsed(current=>({...current,[menuProject.id]:!current[menuProject.id]}))},
 ]}/>}
 {mode&&<dialog className="session-dialog" ref={dialog} aria-label={'重命名项目'} onCancel={e=>{e.preventDefault();if(!busy)setMode(null);}}><form onSubmit={e=>{e.preventDefault();if(busy||!name.trim())return;setBusy(true);void onName(name,false,target).then(ok=>{if(ok)setMode(null);}).finally(()=>setBusy(false));}}><h2>{'重命名项目'}</h2><label>项目名称<input aria-label="项目名称" autoFocus required maxLength={60} value={name} onChange={e=>setName(e.target.value)}/></label><p>按项目整理会话、文件快照和修改提案，自动保存在本地。</p><div className="session-dialog-actions"><button type="button" disabled={busy} onClick={()=>setMode(null)}>取消</button><button type="submit" disabled={busy||!name.trim()}>保存项目</button></div></form></dialog>}</>;
}
