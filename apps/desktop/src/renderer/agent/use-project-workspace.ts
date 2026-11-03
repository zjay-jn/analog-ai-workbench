import {useEffect,useState,useSyncExternalStore,useCallback} from 'react';
import {createWorkspaceController} from './workspace-controller';
import type {Project,WorkbenchWorkspaceApi} from '../../shared/agent/project-workspace';
export function useProjectWorkspace(api?:WorkbenchWorkspaceApi,requireInitialExternal=false){
 const [controller]=useState(()=>createWorkspaceController(api,{requireInitialExternal})),snapshot=useSyncExternalStore(controller.subscribe,controller.snapshot);
 useEffect(()=>{void controller.start();},[controller]);
 const changeProject=useCallback((id:string,update:(project:Project)=>Project,confirmed=false)=>controller.change(state=>{
  const old=state.projects.find(p=>p.id===id);if(!old)return state;const next=update(old);return next===old?state:{...state,projects:state.projects.map(p=>p.id===id?next:p)};
 },confirmed),[controller]);
 return {...snapshot,change:controller.change,changeProject,flush:controller.flush,current:controller.snapshot,runExternal:controller.runExternal};
}
