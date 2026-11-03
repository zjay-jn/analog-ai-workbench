import type {ReactNode} from 'react';

export type ToolProjectChoices=Readonly<{activeId:string;projects:readonly Readonly<{id:string;name:string}>[]}>;
/** Only display metadata leaves the existing workspace owner, never its file/chat snapshots. */
export function projectChoiceSnapshot(activeId:string,projects:readonly {id:string;name:string}[]):ToolProjectChoices{
  return {activeId,projects:projects.map(({id,name})=>({id,name}))};
}

export function ProjectTaskScope({choices,selectedId,disabled=false,onSelect,onCreate,createLabel='新建项目',children}:{choices:ToolProjectChoices;selectedId:string;disabled?:boolean;onSelect:(id:string)=>void;onCreate?:()=>void;createLabel?:string;children:ReactNode}){
  return <div className="project-task-scope">
    <div className="project-task-scope-choice"><label>下次任务项目<select aria-label="下次任务项目" value={selectedId} disabled={disabled||!choices.projects.length} onChange={event=>onSelect(event.target.value)}>
      <option value="">{choices.projects.length?'选择项目':'暂无项目'}</option>{choices.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
    </select></label>{onCreate&&<button type="button" onClick={onCreate} disabled={disabled}>{createLabel}</button>}</div>
    <div className="project-task-scope-detail">{children}</div>
  </div>;
}
