import { randomUUID } from 'node:crypto';
import type { ReviewedSchematicEnvelope } from '../../../../../packages/schematic-workbench/src/reviewed-display';
import type { OaReadQuery, OaReadToolResult, OaReadCode } from '../../shared/agent/oa-read';
import { createOaReadAdapter, OaCaptureError, type OaReadAdapter } from './adapter';
import { createOaSnapshotStore } from './snapshot';
import { createOaQuerySession } from './query';
import { OaReadError, type OaCaptureBinding } from './types';
import { attachOaDisplayReferences, mapOaToReviewed } from './reviewed-mapping';

export const FOLDED_COPY_DESIGN_ID = 'folded-cascode-copy';
export const FOLDED_COPY_CAPTURE_PINS = Object.freeze({captureSha256:'6f429b2ad12d4d3be56864958b55b0ce13de1f2f3a220751d1d37d51006c8a3e',readerSha256:'9a2ad01594e08dee4fb13756ca0c880031fe689741711e9dbfafa1dfc1e66b7b'});
export function foldedCopyCaptureBinding(requestId:string):OaCaptureBinding {
  return {requestId,designId:FOLDED_COPY_DESIGN_ID,environmentBindingId:'rocky9-llm-lab:folded-copy:v1',
    libraryMappingIdentity:'sha256:6882b79cd9cda475af420c7aa5d026bc10e3295763d0eda0de6cf573da1403fe',
    lcv:{library:'FOLDED_CASCODE',cell:'FOLDED_CASCODE',view:'schematic'},adapterVersion:'aaw.oa-saved-read.capture.copy.v2',allowedFiles:['master.tag','sch.oa']};
}
type Options = Readonly<{runId:string;projectId:string;loadReviewed:()=>ReviewedSchematicEnvelope}>;
type Generation = {session:ReturnType<typeof createOaQuerySession>;release():void;mapping:ReturnType<typeof mapOaToReviewed>};
const failure = (code:OaReadCode):OaReadToolResult => ({ok:false,error:{code},coverage:null});
function runtime(options:Options, adapter:OaReadAdapter) {
  let closed=false, opening=false, current:Generation|null=null;
  const generations=new Map<string,Generation>();
  return Object.freeze({
    async execute(query:OaReadQuery,signal:AbortSignal):Promise<OaReadToolResult>{
      if(closed||signal.aborted)return failure('CANCELLED');
      try{
        if(query.toolName==='oa_open_design'){
          if(query.arguments.designId!==FOLDED_COPY_DESIGN_ID||typeof query.arguments.refresh!=='boolean')return failure('NOT_BOUND');
          if(opening)return failure('BUSY');
          if(!current||query.arguments.refresh){
            opening=true;
            try{
              const requestId=randomUUID(),binding=foldedCopyCaptureBinding(requestId);
              const captured=await adapter.capture({requestId,binding,signal});
              if(closed||signal.aborted)return failure('CANCELLED');
              const store=createOaSnapshotStore(),snapshot=store.admit(captured.envelopeJson,binding);
              const session=createOaQuerySession(snapshot,{runId:options.runId,projectId:options.projectId,bindingId:'folded-copy-local-v1',projectIdentity:options.projectId,
                designId:FOLDED_COPY_DESIGN_ID,designHandle:`oa-design-${randomUUID()}`});
              let mapping:ReturnType<typeof mapOaToReviewed>=null;
              try{mapping=mapOaToReviewed(snapshot,options.loadReviewed());}catch{/* Reading facts does not depend on the historical drawing being available. */}
              const generation:Generation={session,mapping,release(){session.close();store.remove(snapshot.snapshotId);}};
              generations.set(session.source.designHandle,generation);current=generation;
            }finally{opening=false;}
          }
          const result=current.session.query('oa_inspect_design',{designHandle:current.session.source.designHandle,savedRevision:current.session.source.savedRevision});
          return result.ok?{ok:true,value:attachOaDisplayReferences(result.value,current.mapping)}:result;
        }
        const generation=generations.get(query.arguments.designHandle);
        if(!generation)return failure('NOT_BOUND');
        const result=generation.session.query(query.toolName,query.arguments);
        return result.ok?{ok:true,value:attachOaDisplayReferences(result.value,generation.mapping)}:result;
      }catch(error){
        if(error instanceof OaReadError)return failure(error.code);
        if(error instanceof OaCaptureError){if(error.code==='CLEANUP_FAILED')throw error;return failure(error.code);}
        throw error;
      }
    },
    async close(){closed=true;try{await adapter.close();}finally{for(const g of generations.values())g.release();generations.clear();current=null;}}
  });
}
/** Lazy construction: no capture, file read, process or model request until open. */
export function createOaReadRuntime(options:Options){return runtime(options,createOaReadAdapter({expectedPins:FOLDED_COPY_CAPTURE_PINS}));}
/** Main-only test seam. Production tool arguments cannot choose paths or adapters. */
export function createOaReadRuntimeForTests(options:Options&{adapter:OaReadAdapter}){return runtime(options,options.adapter);}
