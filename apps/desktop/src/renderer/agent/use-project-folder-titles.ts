import {useEffect,useMemo,useState} from 'react';
import {PROJECT_FOLDERS_VERSION,parseProjectFolderBindingResult,type ProjectFolderBinding,type WorkbenchProjectFoldersApi} from '../../shared/agent/project-folders';
export type FolderTitleState={status:'loading'|'ready'|'error';binding:ProjectFolderBinding|null};
export function windowsFolderPath(segments:readonly string[]):string{return /^[a-z]$/iu.test(segments[0]??'')?segments[0]+':\\'+segments.slice(1).join('\\'):segments.join('\\');}
export function projectFolderTooltip(name:string,state?:FolderTitleState):string{return name+'\n'+(!state||state.status==='loading'?'正在读取文件夹关联…':state.status==='error'?'文件夹关联读取失败，请重新打开软件核对。':state.binding?windowsFolderPath(state.binding.segments):'未关联文件夹');}
export function createProjectFolderTitleReader(api:Pick<WorkbenchProjectFoldersApi,'readBinding'>|undefined){
 let epoch=0;return {cancel(){epoch++;},async read(ids:readonly string[],publish:(states:Record<string,FolderTitleState>)=>void){
  const token=++epoch,states:Record<string,FolderTitleState>=Object.fromEntries(ids.map(id=>[id,{status:api?'loading':'error',binding:null}]));publish({...states});if(!api)return;
  await Promise.all(ids.map(async projectId=>{let value:FolderTitleState={status:'error',binding:null};try{const result=parseProjectFolderBindingResult(await api.readBinding({contractVersion:PROJECT_FOLDERS_VERSION,projectId}));if(result.ok&&result.projectId===projectId)value={status:'ready',binding:result.binding};}catch{/* Never describe unreadable metadata as an unbound project. */}if(token!==epoch)return;states[projectId]=value;publish({...states});}));
 }};
}
export function useProjectFolderBindings(api:WorkbenchProjectFoldersApi|undefined,projects:readonly {id:string}[],revision:number){
 const reader=useMemo(()=>createProjectFolderTitleReader(api),[api]),ids=JSON.stringify(projects.map(p=>p.id)),key=JSON.stringify([ids,revision]);
 const [snapshot,setSnapshot]=useState<{key:string;states:Record<string,FolderTitleState>}>({key:'',states:{}});
 useEffect(()=>{void reader.read(JSON.parse(ids) as string[],states=>setSnapshot({key,states}));return()=>reader.cancel();},[reader,ids,key]);
 return snapshot.key===key?snapshot.states:{};
}
export function useProjectFolderTitles(api:WorkbenchProjectFoldersApi|undefined,projects:readonly {id:string;name:string}[],revision:number){
 const states=useProjectFolderBindings(api,projects,revision);
 return Object.fromEntries(projects.map(project=>[project.id,projectFolderTooltip(project.name,states[project.id])]));
}
