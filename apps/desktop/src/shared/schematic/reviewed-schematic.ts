import type {ReviewedArtifactRefV1,ReviewedDocumentRefV1} from '../../../../../packages/document-contract/src/reviewed-identity';
import type {ReviewedSchematicEnvelope,ReviewedParameter} from '../../../../../packages/schematic-workbench/src/reviewed-display';
import {parseReviewedArtifactRefV1,parseReviewedDocumentRefV1} from '../../../../../packages/document-contract/src/reviewed-identity';
import {validateReviewedSchematicEnvelope,FOLDED_ADAPTED_DIGEST,FOLDED_REVIEWED_SOURCE_DIGEST} from '../../../../../packages/schematic-workbench/src/reviewed-display-validation';
import {boundReviewedJson,reviewedBad as bad,reviewedExact as exact,reviewedCanonical,reviewedSha256} from '../../../../../packages/schematic-workbench/src/reviewed-json';

export const REVIEWED_SCHEMATIC_VERSION='workbench.schematic.reviewed/v1' as const;
export const REVIEWED_SCHEMATIC_DATASET='folded-cascode-reviewed' as const;
export const SCHEMATIC_CONTEXT_VERSION='aaw.schematic-context/v1' as const;
export const SCHEMATIC_CONTEXT_COUNT=2,SCHEMATIC_TARGET_COUNT=8,SCHEMATIC_CONTEXT_BYTES=8192,REVIEWED_RESPONSE_BYTES=2*1024*1024;
export const REVIEWED_SCHEMATIC_CHANNELS=Object.freeze({list:'workbench.schematic.reviewed.list.v1',openReviewed:'workbench.schematic.reviewed.openReviewed.v1',previewSelection:'workbench.schematic.reviewed.previewSelection.v1',resolveReference:'workbench.schematic.reviewed.resolveReference.v1'});
export const REVIEWED_DOCUMENT_REF:ReviewedDocumentRefV1=Object.freeze({documentId:'reviewed.schematic.folded-cascode',revisionId:'export-20260829-001',documentKind:'schematic_reviewed'});
export const REVIEWED_ARTIFACT_REF:ReviewedArtifactRefV1=Object.freeze({artifactId:'reviewed.circuit-ir.folded-cascode',revisionId:'folded-adapter-v1',artifactKind:'circuit_ir_reviewed'});
export type SchematicSelectionTarget=Readonly<{occurrencePath:readonly [];definitionId:string}>&(Readonly<{kind:'instance';elementId:string}>|Readonly<{kind:'net';netId:string}>);
export type SchematicReference=Readonly<{kind:'schematic_reference';projectId:string;datasetId:typeof REVIEWED_SCHEMATIC_DATASET;documentRef:ReviewedDocumentRefV1;artifactRef:ReviewedArtifactRefV1;sourceDigest:string;adaptedDigest:string;targets:readonly SchematicSelectionTarget[]}>;
export type SchematicExcerpt=Readonly<{
  title:string; evidence:'reviewed_export_read_only'; electricalAnchors:'unavailable';
  devices:readonly Readonly<{id:string;name:string;master:Readonly<{library:string;cell:string;view:string}>;parameters:readonly ReviewedParameter[];terminals:readonly Readonly<{id:string;name:string|null;role:'unknown';netId:string}>[]}>[];
  nets:readonly Readonly<{id:string;name:string|null;nameStatus:string;wireCount:number;totalMembers:number;shownMembers:number;truncated:false;members:readonly Readonly<{terminalId:string;instanceId:string|null;instanceName:string|null;terminalName:string|null;role:'unknown'}>[]}>[];
}>;
export type SchematicContext=Readonly<{contractVersion:typeof SCHEMATIC_CONTEXT_VERSION;reference:SchematicReference;previewDigest:string;excerpt:SchematicExcerpt}>;
export type ReviewedSchematicCode='INVALID_REQUEST'|'CAPABILITY_DENIED'|'REVISION_UNAVAILABLE'|'DATA_UNAVAILABLE'|'INTERNAL'|'LIMIT';
export type ReviewedSchematicResult<T>=Readonly<{ok:true;value:T}>|Readonly<{ok:false;error:Readonly<{code:ReviewedSchematicCode}>}>;
export type ReviewedProjectRequest=Readonly<{contractVersion:typeof REVIEWED_SCHEMATIC_VERSION;projectId:string}>;
export type OpenReviewedRequest=ReviewedProjectRequest&Readonly<{datasetId:typeof REVIEWED_SCHEMATIC_DATASET}>;
export type PreviewSelectionRequest=OpenReviewedRequest&Readonly<{documentRef:ReviewedDocumentRefV1;artifactRef:ReviewedArtifactRefV1;sourceDigest:string;adaptedDigest:string;targets:readonly SchematicSelectionTarget[]}>;
export type ResolveSchematicReferenceRequest=ReviewedProjectRequest&Readonly<{reference:SchematicReference}>;
export type ReviewedSchematicDescriptor=Readonly<{datasetId:typeof REVIEWED_SCHEMATIC_DATASET;displayName:string;kind:'reviewed';documentRef:ReviewedDocumentRefV1;artifactRef:ReviewedArtifactRefV1;sourceDigest:string;adaptedDigest:string;availability:'available'|'unavailable'}>;
export type OpenReviewedValue=ReviewedSchematicEnvelope&Readonly<{contractVersion:typeof REVIEWED_SCHEMATIC_VERSION;projectId:string;datasetId:typeof REVIEWED_SCHEMATIC_DATASET;documentRef:ReviewedDocumentRefV1;artifactRef:ReviewedArtifactRefV1;sourceDigest:string;adaptedDigest:string;freshness:'current'}>;
export type ResolveSchematicReferenceValue=Readonly<{document:OpenReviewedValue;reference:SchematicReference}>;
export type WorkbenchReviewedSchematicApi=Readonly<{
  list(request:ReviewedProjectRequest):Promise<ReviewedSchematicResult<readonly ReviewedSchematicDescriptor[]>>;
  openReviewed(request:OpenReviewedRequest):Promise<ReviewedSchematicResult<OpenReviewedValue>>;
  previewSelection(request:PreviewSelectionRequest):Promise<ReviewedSchematicResult<SchematicContext>>;
  resolveReference(request:ResolveSchematicReferenceRequest):Promise<ReviewedSchematicResult<ResolveSchematicReferenceValue>>;
}>;
declare global {interface Window {readonly workbenchReviewedSchematic?:WorkbenchReviewedSchematicApi}}

export const schematicCanonical=reviewedCanonical;
const same=(a:unknown,b:unknown)=>reviewedCanonical(a)===reviewedCanonical(b);
function string(value:unknown,nullable=false):string|null{if(nullable&&value===null)return null;if(typeof value!=='string'||!value.length||value.length>4096)bad();return value;}
function project(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))bad();return value;}
function identity(row:Record<string,unknown>):void{
  if(row.datasetId!==REVIEWED_SCHEMATIC_DATASET||row.sourceDigest!==FOLDED_REVIEWED_SOURCE_DIGEST||row.adaptedDigest!==FOLDED_ADAPTED_DIGEST||!same(parseReviewedDocumentRefV1(row.documentRef),REVIEWED_DOCUMENT_REF)||!same(parseReviewedArtifactRefV1(row.artifactRef),REVIEWED_ARTIFACT_REF))bad();
}
export function parseSchematicTargets(value:unknown):readonly SchematicSelectionTarget[]{
  boundReviewedJson(value,8192);if(!Array.isArray(value)||value.length<1||value.length>SCHEMATIC_TARGET_COUNT)bad();
  const targets=value.map(v=>{const row=exact(v,['kind','occurrencePath','definitionId',v?.kind==='instance'?'elementId':'netId']);if((row.kind!=='instance'&&row.kind!=='net')||row.definitionId!=='definition:folded-cascode'||!Array.isArray(row.occurrencePath)||row.occurrencePath.length)bad();string(row.kind==='instance'?row.elementId:row.netId);return JSON.parse(JSON.stringify(row)) as SchematicSelectionTarget;});
  if(new Set(targets.map(reviewedCanonical)).size!==targets.length)bad();return targets;
}
export function parseSchematicReference(value:unknown):SchematicReference{
  boundReviewedJson(value,8192);const row=exact(value,['kind','projectId','datasetId','documentRef','artifactRef','sourceDigest','adaptedDigest','targets']);
  if(row.kind!=='schematic_reference')bad();project(row.projectId);identity(row);return {...row,targets:parseSchematicTargets(row.targets)} as SchematicReference;
}
export function parseReviewedProjectRequest(value:unknown):ReviewedProjectRequest{
  boundReviewedJson(value,1024);const row=exact(value,['contractVersion','projectId']);if(row.contractVersion!==REVIEWED_SCHEMATIC_VERSION)bad();return {contractVersion:REVIEWED_SCHEMATIC_VERSION,projectId:project(row.projectId)};
}
export function parseOpenReviewedRequest(value:unknown):OpenReviewedRequest{
  boundReviewedJson(value,2048);const row=exact(value,['contractVersion','projectId','datasetId']);if(row.datasetId!==REVIEWED_SCHEMATIC_DATASET)bad();return {...parseReviewedProjectRequest({contractVersion:row.contractVersion,projectId:row.projectId}),datasetId:REVIEWED_SCHEMATIC_DATASET};
}
export function parsePreviewSelectionRequest(value:unknown):PreviewSelectionRequest{
  boundReviewedJson(value,8192);const row=exact(value,['contractVersion','projectId','datasetId','documentRef','artifactRef','sourceDigest','adaptedDigest','targets']);
  if(row.contractVersion!==REVIEWED_SCHEMATIC_VERSION)bad();const ref=parseSchematicReference({kind:'schematic_reference',projectId:row.projectId,datasetId:row.datasetId,documentRef:row.documentRef,artifactRef:row.artifactRef,sourceDigest:row.sourceDigest,adaptedDigest:row.adaptedDigest,targets:row.targets});
  const {kind:_,...rest}=ref;return {contractVersion:REVIEWED_SCHEMATIC_VERSION,...rest};
}
export function parseResolveSchematicReferenceRequest(value:unknown):ResolveSchematicReferenceRequest{
  boundReviewedJson(value,8192);const row=exact(value,['contractVersion','projectId','reference']);const request=parseReviewedProjectRequest({contractVersion:row.contractVersion,projectId:row.projectId}),reference=parseSchematicReference(row.reference);if(reference.projectId!==request.projectId)bad();return {...request,reference};
}
export function buildSchematicContext(envelope:ReviewedSchematicEnvelope,reference:SchematicReference):SchematicContext{
  const ref=parseSchematicReference(reference),{display}=validateReviewedSchematicEnvelope(envelope);
  const devices:SchematicExcerpt['devices'][number][]=[],nets:SchematicExcerpt['nets'][number][]=[];
  for(const target of ref.targets){
    if(target.kind==='instance'){
      const d=display.devices.find(d=>d.id===target.elementId);if(!d)bad();
      devices.push({id:d.id,name:d.name,master:d.master,parameters:d.parameters,terminals:display.terminals.filter(t=>t.instanceId===d.id).map(t=>({id:t.id,name:t.name,role:'unknown',netId:t.netId}))});
    }else{
      const n=display.nets.find(n=>n.id===target.netId);if(!n)bad();
      nets.push({id:n.id,name:n.name,nameStatus:n.nameStatus,wireCount:n.wireIds.length,totalMembers:n.memberIds.length,shownMembers:n.memberIds.length,truncated:false,members:n.memberIds.map(id=>{const t=display.terminals.find(t=>t.id===id);if(!t)bad();return {terminalId:t.id,instanceId:t.instanceId,instanceName:display.devices.find(d=>d.id===t.instanceId)?.name??null,terminalName:t.name,role:'unknown'};})});
    }
  }
  const value={contractVersion:SCHEMATIC_CONTEXT_VERSION,reference:ref,excerpt:{title:'FOLDED_CASCODE',evidence:'reviewed_export_read_only' as const,electricalAnchors:'unavailable' as const,devices,nets}};
  const context={...value,previewDigest:reviewedSha256(reviewedCanonical(value))};return parseSchematicContext(context);
}
export function parseSchematicContext(value:unknown):SchematicContext{
  boundReviewedJson(value,SCHEMATIC_CONTEXT_BYTES);const row=exact(value,['contractVersion','reference','previewDigest','excerpt']);
  if(row.contractVersion!==SCHEMATIC_CONTEXT_VERSION||typeof row.previewDigest!=='string'||!/^[0-9a-f]{64}$/u.test(row.previewDigest))bad();const reference=parseSchematicReference(row.reference);
  const excerpt=exact(row.excerpt,['title','evidence','electricalAnchors','devices','nets']);
  if(excerpt.title!=='FOLDED_CASCODE'||excerpt.evidence!=='reviewed_export_read_only'||excerpt.electricalAnchors!=='unavailable'||!Array.isArray(excerpt.devices)||!Array.isArray(excerpt.nets)||excerpt.devices.length+excerpt.nets.length!==reference.targets.length)bad();
  for(const d of excerpt.devices){const v=exact(d,['id','name','master','parameters','terminals']);string(v.id);string(v.name);const m=exact(v.master,['library','cell','view']);Object.values(m).forEach(v=>string(v));if(!Array.isArray(v.parameters)||!Array.isArray(v.terminals))bad();for(const p of v.parameters){const r=exact(p,['name','valueText']);string(r.name);if(typeof r.valueText!=='string')bad();}for(const t of v.terminals){const r=exact(t,['id','name','role','netId']);string(r.id);string(r.name,true);string(r.netId);if(r.role!=='unknown')bad();}}
  for(const n of excerpt.nets){const v=exact(n,['id','name','nameStatus','wireCount','totalMembers','shownMembers','truncated','members']);string(v.id);string(v.name,true);string(v.nameStatus);if(v.truncated!==false||!Array.isArray(v.members)||v.totalMembers!==v.members.length||v.shownMembers!==v.totalMembers||!Number.isSafeInteger(v.wireCount)||Number(v.wireCount)<0)bad();for(const m of v.members){const r=exact(m,['terminalId','instanceId','instanceName','terminalName','role']);string(r.terminalId);string(r.instanceId,true);string(r.instanceName,true);string(r.terminalName,true);if(r.role!=='unknown')bad();}}
  const {previewDigest:_,...content}=row;if(reviewedSha256(reviewedCanonical(content))!==row.previewDigest)bad();return JSON.parse(JSON.stringify(row)) as SchematicContext;
}
export function parseSchematicContexts(value:unknown):SchematicContext[]{boundReviewedJson(value,SCHEMATIC_CONTEXT_BYTES*2);if(!Array.isArray(value)||value.length>2)bad();const contexts=value.map(parseSchematicContext);if(new Set(contexts.map(c=>reviewedCanonical(c.reference))).size!==contexts.length)bad();return contexts;}
export function reviewedSchematicFailure(code:ReviewedSchematicCode):Readonly<{ok:false;error:Readonly<{code:ReviewedSchematicCode}>}>{return {ok:false,error:{code}};}
function result<T>(value:unknown,parse:(value:unknown)=>T):ReviewedSchematicResult<T>{
  boundReviewedJson(value);const root=exact(value,['ok',value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===true?'value':'error']);
  if(root.ok===true)return {ok:true,value:parse(root.value)};const error=exact(root.error,['code']);if(root.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','REVISION_UNAVAILABLE','DATA_UNAVAILABLE','INTERNAL','LIMIT'].includes(error.code as string))bad();return reviewedSchematicFailure(error.code as ReviewedSchematicCode);
}
export function parseOpenReviewedValue(value:unknown,expectedProjectId?:string):OpenReviewedValue{
  const row=exact(value,['contractVersion','projectId','datasetId','documentRef','artifactRef','sourceDigest','adaptedDigest','freshness','reviewedCircuitIr','display']);
  if(row.contractVersion!==REVIEWED_SCHEMATIC_VERSION||row.freshness!=='current'||(expectedProjectId!==undefined&&row.projectId!==expectedProjectId))bad();project(row.projectId);identity(row);
  const envelope=validateReviewedSchematicEnvelope({reviewedCircuitIr:row.reviewedCircuitIr,display:row.display});
  if(!same(envelope.display.documentRef,row.documentRef)||!same(envelope.display.artifactRef,row.artifactRef)||envelope.display.sourceDigest!==row.sourceDigest||envelope.display.adaptedDigest!==row.adaptedDigest)bad();return {...row,...envelope} as OpenReviewedValue;
}
export function parseOpenReviewedResult(value:unknown,expectedProjectId?:string):ReviewedSchematicResult<OpenReviewedValue>{return result(value,v=>parseOpenReviewedValue(v,expectedProjectId));}
export function parseReviewedSchematicListResult(value:unknown):ReviewedSchematicResult<readonly ReviewedSchematicDescriptor[]>{return result(value,v=>{if(!Array.isArray(v)||v.length!==1)bad();const row=exact(v[0],['datasetId','displayName','kind','documentRef','artifactRef','sourceDigest','adaptedDigest','availability']);identity(row);if(row.kind!=='reviewed'||row.displayName!=='FOLDED_CASCODE'||!['available','unavailable'].includes(row.availability as string))bad();return [JSON.parse(JSON.stringify(row)) as ReviewedSchematicDescriptor];});}
export function parseSchematicPreviewResult(value:unknown):ReviewedSchematicResult<SchematicContext>{return result(value,parseSchematicContext);}
export function parseResolveSchematicReferenceResult(value:unknown):ReviewedSchematicResult<ResolveSchematicReferenceValue>{return result(value,v=>{const row=exact(v,['document','reference']),reference=parseSchematicReference(row.reference),document=parseOpenReviewedValue(row.document,reference.projectId);return {document,reference};});}
