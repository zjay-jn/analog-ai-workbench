import {windowsFolderPath,type FolderTitleState} from './use-project-folder-titles';

export function chatProjectHasBinding(projectId:string,states:Record<string,FolderTitleState>):boolean{
 const state=states[projectId];return state?.status==='ready'&&state.binding?.projectId===projectId;
}
export function ChatProjectConfiguration({projectId,projects,states,disabled,onSelect,onBind,onRefresh,bindingNotice=''}:{projectId:string;projects:readonly {id:string;name:string}[];states:Record<string,FolderTitleState>;disabled:boolean;onSelect:(id:string)=>void;onBind?:()=>void;onRefresh:()=>void;bindingNotice?:string}){
 const current=projects.find(project=>project.id===projectId),state=states[projectId],bound=chatProjectHasBinding(projectId,states);
 const status=!state||state.status==='loading'?'正在读取目录关联…':state.status==='error'?'目录关联读取失败，请重新核对。':bound?windowsFolderPath(state.binding!.segments):'未关联目录';
 return <div className="chat-project-configuration">
  <p>当前项目：{current?.name??'未选择项目'}</p>
  <p className="chat-project-directory">项目目录：{status}</p>
  <div className="chat-project-configuration-actions">
   {state?.status==='ready'&&!state.binding&&onBind&&<button type="button" disabled={disabled} onClick={onBind}>为当前项目选择目录</button>}
   <label>切换到已关联项目<select aria-label="配置所需的聊天项目" value={projectId} disabled={disabled} onChange={event=>{if(event.target.value!==projectId&&chatProjectHasBinding(event.target.value,states))onSelect(event.target.value);}}>
    {!bound&&<option value={projectId} disabled>{current?.name??'当前项目'} · {state?.status==='ready'?'未关联目录':state?.status==='error'?'读取失败':'正在核对'}</option>}
    {projects.filter(project=>chatProjectHasBinding(project.id,states)).map(project=><option key={project.id} value={project.id} title={windowsFolderPath(states[project.id]!.binding!.segments)}>{project.name}</option>)}
   </select></label>
   <button type="button" disabled={disabled} onClick={onRefresh}>重新核对目录</button>
  </div>
  {bindingNotice&&<p role="status">{bindingNotice}</p>}
 </div>;
}
