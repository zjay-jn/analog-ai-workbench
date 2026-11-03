import {parseReviewedDocumentRefV1, parseReviewedArtifactRefV1, type ReviewedDocumentRefV1, type ReviewedArtifactRefV1} from '../../../../../packages/document-contract/src/reviewed-identity';
import {validateReviewedCircuitIrV1, type ReviewedCircuitIrV1} from '../../../../../packages/schematic-workbench/src/reviewed-circuit-ir';

export const CLOUD_SCHEMATIC_VERSION = 'workbench.schematic.cloud/v1' as const;
export const CLOUD_SCHEMATIC_CHANNEL = 'workbench.schematic.cloud.openSynthetic.v1' as const;
export const CLOUD_SCHEMATIC_FIXTURE_ID = 'cloud-demo' as const;
export const CLOUD_SCHEMATIC_PROJECT_CACHE_LIMIT = 12;
export const CLOUD_SCHEMATIC_RESPONSE_MAX_BYTES = 64 * 1024;
export const CLOUD_SCHEMATIC_DOCUMENT_REF: ReviewedDocumentRefV1 = Object.freeze({documentId:'synthetic.schematic.cloud-demo', revisionId:'rev-1', documentKind:'schematic_reviewed'});
export const CLOUD_SCHEMATIC_ARTIFACT_REF: ReviewedArtifactRefV1 = Object.freeze({artifactId:'synthetic.circuit-ir.cloud-demo', revisionId:'rev-1', artifactKind:'circuit_ir_reviewed'});
export type CloudSchematicRequest = Readonly<{contractVersion:typeof CLOUD_SCHEMATIC_VERSION; projectId:string; fixtureId:typeof CLOUD_SCHEMATIC_FIXTURE_ID}>;
export type CloudSchematicValue = Readonly<{contractVersion:typeof CLOUD_SCHEMATIC_VERSION; projectId:string; documentRef:ReviewedDocumentRefV1; artifactRef:ReviewedArtifactRefV1; freshness:'current'; reviewedCircuitIr:ReviewedCircuitIrV1}>;
export type CloudSchematicCode = 'INVALID_REQUEST'|'CAPABILITY_DENIED'|'REVISION_UNAVAILABLE'|'INTERNAL';
export type CloudSchematicResult = Readonly<{ok:true; value:CloudSchematicValue}> | Readonly<{ok:false; error:Readonly<{code:CloudSchematicCode}>}>;
export type WorkbenchSchematicApi = Readonly<{openSynthetic(request:CloudSchematicRequest):Promise<CloudSchematicResult>}>;
declare global { interface Window { readonly workbenchSchematic?: WorkbenchSchematicApi; } }

function bad():never { throw new TypeError('Invalid synthetic schematic data'); }
function exact(value:unknown, keys:readonly string[]):Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype) bad();
  const descriptors=Object.getOwnPropertyDescriptors(value), actual=Reflect.ownKeys(descriptors);
  if(actual.length!==keys.length||actual.some(key=>typeof key!=='string'||!keys.includes(key))) bad();
  const copy:Record<string,unknown>={};
  for(const key of keys){const descriptor=descriptors[key];if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)bad();copy[key]=descriptor.value;}
  return copy;
}
function project(value:unknown):string {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))bad();
  return value;
}
export function parseCloudSchematicRequest(value:unknown):CloudSchematicRequest {
  const row=exact(value,['contractVersion','projectId','fixtureId']);
  if(row.contractVersion!==CLOUD_SCHEMATIC_VERSION||row.fixtureId!==CLOUD_SCHEMATIC_FIXTURE_ID)bad();
  return Object.freeze({contractVersion:CLOUD_SCHEMATIC_VERSION,projectId:project(row.projectId),fixtureId:CLOUD_SCHEMATIC_FIXTURE_ID});
}
export function cloudSchematicFailure(code:CloudSchematicCode):CloudSchematicResult {return Object.freeze({ok:false,error:Object.freeze({code})});}

// Reject exotic/getter/cyclic/oversized clone graphs before JSON serialization or IR validation.
function boundedCloneData(value:unknown):void {
  const seen=new Set<object>();let nodes=0,stringBytes=0;
  const visit=(node:unknown,depth:number):void=>{
    if(++nodes>4096||depth>64)bad();
    if(typeof node==='string'){if(node.length>CLOUD_SCHEMATIC_RESPONSE_MAX_BYTES)bad();stringBytes+=new TextEncoder().encode(node).length;if(stringBytes>CLOUD_SCHEMATIC_RESPONSE_MAX_BYTES)bad();return;}
    if(node===null||typeof node==='boolean')return;
    if(typeof node==='number'){if(!Number.isFinite(node)||Object.is(node,-0))bad();return;}
    if(typeof node!=='object'||seen.has(node))bad();
    const array=Array.isArray(node);
    if(Object.getPrototypeOf(node)!==(array?Array.prototype:Object.prototype))bad();
    const keys=Reflect.ownKeys(node);if(keys.length>4096)bad();
    if(array){
      const length=Object.getOwnPropertyDescriptor(node,'length')?.value;
      if(!Number.isSafeInteger(length)||length>4095||keys.length!==length+1)bad();
      for(let index=0;index<length;index++){const d=Object.getOwnPropertyDescriptor(node,String(index));if(!d||!('value'in d)||!d.enumerable)bad();}
    }
    seen.add(node);
    for(const key of keys){if(typeof key!=='string')bad();const d=Object.getOwnPropertyDescriptor(node,key);if(!d||!('value'in d))bad();if(array&&key==='length')continue;if(!d.enumerable)bad();visit(key,depth+1);visit(d.value,depth+1);}
    seen.delete(node);
  };
  visit(value,0);
  if(new TextEncoder().encode(JSON.stringify(value)).length>CLOUD_SCHEMATIC_RESPONSE_MAX_BYTES)bad();
}
export function parseCloudSchematicResult(value:unknown,expectedProjectId?:string):CloudSchematicResult {
  boundedCloneData(value);
  if(value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'ok')?.value===true){
    const root=exact(value,['ok','value']),row=exact(root.value,['contractVersion','projectId','documentRef','artifactRef','freshness','reviewedCircuitIr']);
    const projectId=project(row.projectId),documentRef=parseReviewedDocumentRefV1(row.documentRef),artifactRef=parseReviewedArtifactRefV1(row.artifactRef);
    if(row.contractVersion!==CLOUD_SCHEMATIC_VERSION||row.freshness!=='current'||(expectedProjectId!==undefined&&projectId!==expectedProjectId)||documentRef.documentId!==CLOUD_SCHEMATIC_DOCUMENT_REF.documentId||documentRef.revisionId!=='rev-1'||artifactRef.artifactId!==CLOUD_SCHEMATIC_ARTIFACT_REF.artifactId||artifactRef.revisionId!=='rev-1')bad();
    return Object.freeze({ok:true,value:Object.freeze({contractVersion:CLOUD_SCHEMATIC_VERSION,projectId,documentRef,artifactRef,freshness:'current',reviewedCircuitIr:validateReviewedCircuitIrV1(row.reviewedCircuitIr)})});
  }
  const root=exact(value,['ok','error']),error=exact(root.error,['code']);
  if(root.ok!==false||!['INVALID_REQUEST','CAPABILITY_DENIED','REVISION_UNAVAILABLE','INTERNAL'].includes(error.code as string))bad();
  return cloudSchematicFailure(error.code as CloudSchematicCode);
}
