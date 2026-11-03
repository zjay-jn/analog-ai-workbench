import {useEffect,useRef,useSyncExternalStore} from 'react';
import type {createProjectCreationController} from './project-creation-controller';
import {windowsFolderPath} from './use-project-folder-titles';
export function ProjectCreationDialog({controller}:{controller:ReturnType<typeof createProjectCreationController>}){
 const state=useSyncExternalStore(controller.subscribe,controller.snapshot),dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(state.open)dialog.current?.showModal();else dialog.current?.close();return()=>dialog.current?.close();},[state.open]);
 const binding=state.selection?.binding??state.creation?.binding,path=binding?windowsFolderPath(binding.segments):'',pending=state.creation?.status==='pending';
 return <>{!state.open&&(pending||state.uncertain)&&<button type="button" className="project-creation-resume" onClick={()=>{void controller.inspect();}} disabled={state.busy}>核对未完成项目</button>}
 {state.open&&<dialog ref={dialog} className="session-dialog" aria-label="新建项目" onCancel={event=>{event.preventDefault();void controller.cancel();}}>
  <form onSubmit={event=>{event.preventDefault();if(state.uncertain)void controller.inspect();else void controller.save();}}>
   <h2>{pending?'继续完成项目':'新建项目'}</h2>
   <label>项目名称<input aria-label="项目名称" autoFocus required maxLength={60} value={state.name} readOnly={pending||state.uncertain} disabled={state.busy} onChange={event=>controller.setName(event.target.value)}/></label>
   <label>项目文件夹<div className="project-folder-choice"><input aria-label="项目文件夹路径" value={path} title={path} placeholder="请选择本地文件夹" readOnly/><button type="button" disabled={state.busy||state.uncertain} onClick={()=>{void controller.browse();}}>浏览…</button></div></label>
   <p>选择文件夹后保存项目。项目建立后保留此位置。</p>
   {state.error&&<p role="alert">{state.error}</p>}
   <div className="session-dialog-actions"><button type="button" disabled={state.busy||state.uncertain} onClick={()=>{void controller.cancel();}}>{pending?'稍后继续':'取消'}</button><button type="submit" disabled={state.busy||(!state.uncertain&&(!state.name.trim()||(!binding)))}>{state.busy?'正在处理…':state.uncertain?'核对结果':pending?'继续完成':'保存项目'}</button></div>
  </form>
 </dialog>}</>;
}

