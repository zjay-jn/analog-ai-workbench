import {CLOUD_SCHEMATIC_VERSION,CLOUD_SCHEMATIC_FIXTURE_ID,CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT,parseCloudSchematicResult,type CloudSchematicValue,type WorkbenchSchematicApi} from '../../shared/schematic/cloud-schematic';
import {createInitialViewerViewStateV1,type ViewerViewStateV1} from '../../../../../packages/schematic-workbench/src/viewer/view-state';
import type {SchematicViewerActionV1} from '../SchematicViewer';
import {applySchematicViewerAction} from './viewer-actions';

type Base={projectId:string;key:string;active:boolean;used:number;generation:number};
export type CloudSchematicTab=Base&({status:'loading'}|{status:'error';message:string}|{status:'ready';delivery:CloudSchematicValue;viewState:ViewerViewStateV1;measured:boolean});
const errors={INVALID_REQUEST:'原理图打开请求无效，请重试。',CAPABILITY_DENIED:'当前项目无法打开原理图，请切换项目后重试。',REVISION_UNAVAILABLE:'此合成原理图版本暂不可用。',INTERNAL:'原理图未能加载，请重试。'};
export function cloudSchematicKey(value:CloudSchematicValue){return JSON.stringify([value.projectId,value.documentRef.documentId,value.documentRef.revisionId,value.artifactRef.artifactId,value.artifactRef.revisionId]);}
export function createCloudSchematicTabs(api:WorkbenchSchematicApi|undefined){
 const entries=new Map<string,CloudSchematicTab>(),listeners=new Set<()=>void>();let projectId='',generation=0,clock=0,disposed=false;
 const publish=()=>{for(const listener of listeners)listener();};
 const cancelPending=()=>{for(const [id,entry]of entries)if(entry.status==='loading')entries.set(id,{...entry,generation:++generation,status:'error',message:'上次加载已取消，请重试。'});};
 const touch=(entry:CloudSchematicTab)=>({...entry,used:++clock});
 return {
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  snapshot(){return [...entries.values()];},
  setProject(id:string){if(disposed||projectId===id)return;cancelPending();projectId=id;const entry=entries.get(id);if(entry)entries.set(id,touch(entry));publish();},
  selectText(){if(disposed)return;const entry=entries.get(projectId);if(entry){entries.set(projectId,{...entry,active:false});publish();}},
  select(){if(disposed)return;const entry=entries.get(projectId);if(entry){entries.set(projectId,touch({...entry,active:true}));publish();}},
  close(){if(disposed)return;++generation;entries.delete(projectId);publish();},
  async open(retry=false){
   if(disposed||!projectId)return;const id=projectId,existing=entries.get(id);
   if(existing&&!retry){entries.set(id,touch({...existing,active:true}));publish();return;}
   const token=++generation;
   if(!entries.has(id)&&entries.size>=CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT){const oldest=[...entries.values()].filter(e=>e.projectId!==id).sort((a,b)=>a.used-b.used)[0];if(oldest)entries.delete(oldest.projectId);}
   entries.set(id,{projectId:id,key:JSON.stringify([id,CLOUD_SCHEMATIC_FIXTURE_ID]),active:true,used:++clock,generation:token,status:'loading'});publish();
   try{
    if(!api)throw Error('Unavailable');
    const result=parseCloudSchematicResult(await api.openSynthetic({contractVersion:CLOUD_SCHEMATIC_VERSION,projectId:id,fixtureId:CLOUD_SCHEMATIC_FIXTURE_ID}),id);
    const current=entries.get(id);if(disposed||projectId!==id||current?.generation!==token)return;
    if(!result.ok){entries.set(id,{...current,status:'error',message:errors[result.error.code]});publish();return;}
    const delivery=result.value,viewState=createInitialViewerViewStateV1(delivery.reviewedCircuitIr,{width:720,height:520},delivery.artifactRef);
    entries.set(id,{...current,key:cloudSchematicKey(delivery),status:'ready',delivery,viewState,measured:false});publish();
   }catch{const current=entries.get(id);if(disposed||projectId!==id||current?.generation!==token)return;entries.set(id,{...current,status:'error',message:errors.INTERNAL});publish();}
  },
  action(key:string,action:SchematicViewerActionV1){
   if(disposed)return;const entry=entries.get(projectId);if(entry?.status!=='ready'||!entry.active||entry.key!==key)return;
   entries.set(projectId,{...entry,viewState:applySchematicViewerAction(entry.delivery,entry.viewState,action),measured:entry.measured||action.type==='resize-css'});publish();
  },
  dispose(){disposed=true;++generation;entries.clear();listeners.clear();},
 };
}
