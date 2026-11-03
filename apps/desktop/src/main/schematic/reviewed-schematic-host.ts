import type {ReviewedSchematicEnvelope} from '../../../../../packages/schematic-workbench/src/reviewed-display';
import {validateReviewedSchematicEnvelope,FOLDED_ADAPTED_DIGEST,FOLDED_REVIEWED_SOURCE_DIGEST} from '../../../../../packages/schematic-workbench/src/reviewed-display-validation';
import {REVIEWED_SCHEMATIC_VERSION,REVIEWED_SCHEMATIC_DATASET,REVIEWED_DOCUMENT_REF,REVIEWED_ARTIFACT_REF,parseReviewedProjectRequest,parseOpenReviewedRequest,parsePreviewSelectionRequest,parseResolveSchematicReferenceRequest,parseOpenReviewedResult,parseSchematicContexts,buildSchematicContext,schematicCanonical,reviewedSchematicFailure,type OpenReviewedValue,type ReviewedSchematicDescriptor,type ReviewedSchematicResult,type SchematicContext,type SchematicReference} from '../../shared/schematic/reviewed-schematic';

export type ReviewedSchematicHostOptions=Readonly<{hasProject:(id:string)=>boolean;loadEnvelope:()=>ReviewedSchematicEnvelope}>;
export function createReviewedSchematicHost(options:ReviewedSchematicHostOptions){
  let revoked=false,generation=0;
  const allowed=(projectId:string,authorized:()=>boolean)=>{try{return !revoked&&authorized()&&options.hasProject(projectId);}catch{return false;}};
  const envelope=()=>validateReviewedSchematicEnvelope(options.loadEnvelope());
  const document=(projectId:string,e:ReviewedSchematicEnvelope):OpenReviewedValue=>({contractVersion:REVIEWED_SCHEMATIC_VERSION,projectId,datasetId:REVIEWED_SCHEMATIC_DATASET,documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:e.display.sourceDigest,adaptedDigest:e.display.adaptedDigest,freshness:'current',...e});
  return Object.freeze({
    async invoke(method:'list'|'openReviewed'|'previewSelection'|'resolveReference',value:unknown,authorized:()=>boolean):Promise<ReviewedSchematicResult<unknown>>{
      const epoch=generation;let request;
      try{if(revoked||!authorized())return reviewedSchematicFailure('CAPABILITY_DENIED');}catch{return reviewedSchematicFailure('CAPABILITY_DENIED');}
      try{request=method==='list'?parseReviewedProjectRequest(value):method==='openReviewed'?parseOpenReviewedRequest(value):method==='previewSelection'?parsePreviewSelectionRequest(value):parseResolveSchematicReferenceRequest(value);}catch{return reviewedSchematicFailure('INVALID_REQUEST');}
      const current=()=>epoch===generation&&allowed(request.projectId,authorized);
      if(!current())return reviewedSchematicFailure('CAPABILITY_DENIED');
      let e:ReviewedSchematicEnvelope;
      try{e=envelope();}catch{return reviewedSchematicFailure(current()?'DATA_UNAVAILABLE':'CAPABILITY_DENIED');}
      // Recheck after yielding, immediately before constructing/delivering a reply.
      await Promise.resolve();if(!current())return reviewedSchematicFailure('CAPABILITY_DENIED');
      try{
        let result:ReviewedSchematicResult<unknown>;
        if(method==='list'){
          const descriptor:ReviewedSchematicDescriptor={datasetId:REVIEWED_SCHEMATIC_DATASET,displayName:'FOLDED_CASCODE',kind:'reviewed',documentRef:REVIEWED_DOCUMENT_REF,artifactRef:REVIEWED_ARTIFACT_REF,sourceDigest:FOLDED_REVIEWED_SOURCE_DIGEST,adaptedDigest:FOLDED_ADAPTED_DIGEST,availability:'available'};result={ok:true,value:[descriptor]};
        }else if(method==='openReviewed')result=parseOpenReviewedResult({ok:true,value:document(request.projectId,e)},request.projectId);
        else if(method==='previewSelection'){
          const r=parsePreviewSelectionRequest(request);const {contractVersion:_,...fields}=r;result={ok:true,value:buildSchematicContext(e,{kind:'schematic_reference',...fields})};
        }else {const r=parseResolveSchematicReferenceRequest(request);buildSchematicContext(e,r.reference);result={ok:true,value:{document:document(request.projectId,e),reference:r.reference}};}
        return current()?result:reviewedSchematicFailure('CAPABILITY_DENIED');
      }catch{return reviewedSchematicFailure(current()?'LIMIT':'CAPABILITY_DENIED');}
    },
    /** Session host calls synchronously before commit and again immediately before transport. Full canonical snapshot is rebuilt from authoritative data. */
    validateContextsForProject(projectId:string,values:readonly SchematicContext[]):void{
      if(!values.length)return;
      if(!allowed(projectId,()=>true))throw new Error('Schematic reference unavailable');
      const contexts=parseSchematicContexts(values),e=envelope();
      for(const context of contexts){if(context.reference.projectId!==projectId||schematicCanonical(buildSchematicContext(e,context.reference))!==schematicCanonical(context))throw new Error('Schematic reference unavailable');}
      if(!allowed(projectId,()=>true))throw new Error('Schematic reference unavailable');
    },
    validateReference(projectId:string,reference:SchematicReference):void{if(!allowed(projectId,()=>true)||reference.projectId!==projectId)throw new Error('Schematic reference unavailable');buildSchematicContext(envelope(),reference);},
    revoke(){revoked=true;generation++;},
  });
}
export type ReviewedSchematicHost=ReturnType<typeof createReviewedSchematicHost>;
