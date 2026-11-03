import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import {canonicalizeAawJsonV1} from './canonical-json';
import type {CircuitPointV1} from './reviewed-circuit-ir';
import type {ReviewedDeviceMetadata,ReviewedLabelMetadata,ReviewedParameter,SourcePlacement} from './reviewed-display';

export const FOLDED_SOURCE_FILES=Object.freeze({
  'snapshot.json':'fd2b44561caf36d811f88dafa7bcaa305e79d7583afa28c7960a94ae6463fcac',
  'review.json':'5737e76d5f7b9e015e72d6444151a5c77df6f525faa1053ed718aa3a02eacfbd',
  'reviewed-data.js':'65d28ee8bc8776a91e1c830d3d2416b9c1394579207fe6fa191d688aad8b0146',
  'snapshot.schema.json':'4ad5238dd76fd9a5c9fc995495813b6051df3d3d1bd2099e48e07f85ca0a8d6f',
  'ir.schema.json':'8949aa3cb40b5b85c69d1684700709b91d26e81c1a28a3a532a1d42be92a1562',
  'review.schema.json':'3bd6e082cd2d1c9b477d9ee1c727aaff3efa63c71a89d186c5086b468d6795f3',
});
export type FoldedSourceFiles=Readonly<Record<keyof typeof FOLDED_SOURCE_FILES,string>>;
export const FOLDED_SOURCE_DIGEST=FOLDED_SOURCE_FILES['snapshot.json'];
export const FOLDED_GLYPH_SOURCE_DIGEST='915713f4b0f83236eff48e33d3ce4aa3b81d2c728b5ab01d848a22254c56d159';
export const sha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
type Pin={id:string;name:string|null;nameStatus:string;terminalRole:'unknown';positionStatus:'unavailable_in_current_view';position:null;netId:string};
type Device={id:string;name:string;deviceKind:string;master:ReviewedDeviceMetadata['master'];placement:SourcePlacement;sourceTerminalSet:string[];pins:Pin[];parameters:ReviewedParameter[];bulkBinding?:ReviewedDeviceMetadata['bulkBinding']};
type Port={id:string;name:string;direction:string;positionStatus:'unavailable_in_current_view';position:null;netId:string;displayPlacement:SourcePlacement};
export type FoldedSourceIr={
  irId:string;readOnly:true;source:Record<string,string>;design:{library:string;cell:string;view:string};
  coordinateSystem:{databaseUnitsPerUserUnit:160;unit:'database_unit';xAxisDirection:'right';yAxisDirection:'up';grid:{snapSpacingX:null;snapSpacingY:null}};
  viewport:{contentBoundingBox:SourcePlacement['boundingBox']};devices:Device[];ports:Port[];
  nets:{id:string;name:string|null;nameStatus:string;members:{objectId:string;objectKind:string}[]}[];
  wires:{id:string;netId:string;points:CircuitPointV1[]}[];
  labels:(ReviewedLabelMetadata&{labelKind:string})[];
  graphics:({id:string;primitiveKind:'circle';center:CircuitPointV1;radiusX:number;radiusY:number}|{id:string;primitiveKind:'text';position:CircuitPointV1;text:string;rotation:number;alignment:string;orientation:string})[];
  displayOrder:string[];primitiveMappings:{master:Device['master'];mappingKind:string;primitiveType?:'pmos'|'nmos'}[];
  symbolDefinitions:unknown[];junctions:unknown[];annotations:unknown[];conditions:Record<string,unknown>;
};
function requireValue(condition:unknown):asserts condition {if(!condition)throw new TypeError('Reviewed source profile mismatch');}
const equal=(a:unknown,b:unknown)=>canonicalizeAawJsonV1(a)===canonicalizeAawJsonV1(b);

/** Exact wrapper and byte pins precede JSON/schema work; no script evaluation, file access, or reference following. */
export function admitFoldedSources(files:FoldedSourceFiles):FoldedSourceIr {
  requireValue(Object.keys(files).length===6);
  for(const [name,digest] of Object.entries(FOLDED_SOURCE_FILES)){
    const raw=files[name as keyof FoldedSourceFiles];
    requireValue(typeof raw==='string'&&Buffer.byteLength(raw)<=(name==='review.json'?16384:1048576)&&sha256(raw)===digest);
  }
  const prefix='/* Generated only from the main-control reviewed Snapshot + hash-bound sidecar. Reviewed SHA256 '+FOLDED_SOURCE_DIGEST+'; review SHA256 '+FOLDED_SOURCE_FILES['review.json']+'. */\nwindow.AAL_VIEWER_IR = ';
  const script=files['reviewed-data.js'];requireValue(script.startsWith(prefix)&&script.endsWith(';\n'));
  const ir=JSON.parse(script.slice(prefix.length,-2)) as FoldedSourceIr;
  const snapshot=JSON.parse(files['snapshot.json']) as Record<string,unknown>;
  const review=JSON.parse(files['review.json']) as {binding:Record<string,string>;reviewRef:string;decision:string;allowedUses:string[];sanitizationStatus:string;withdrawalStatus:string;evidenceLevel:string;reviewedArtifact:{sha256:string}};
  for(const [schema,value] of [['snapshot.schema.json',snapshot],['ir.schema.json',ir],['review.schema.json',review]] as const){
    const ajv=new Ajv2020({strict:false,validateFormats:false,allErrors:false});
    requireValue(ajv.compile(JSON.parse(files[schema]))(value));
  }
  requireValue(review.decision==='approved_for_read_only_viewer_v0'&&equal(review.allowedUses,['read_only_schematic_viewer'])&&review.sanitizationStatus==='approved'&&review.withdrawalStatus==='active'&&review.evidenceLevel==='oa_readable'&&review.reviewedArtifact.sha256==='sha256:'+FOLDED_SOURCE_DIGEST);
  requireValue(ir.readOnly&&ir.source.snapshotId===snapshot.snapshotId&&review.binding.snapshotId===snapshot.snapshotId&&review.reviewRef===ir.source.reviewRef);
  const source=snapshot.source as Record<string,unknown>;
  for(const [key,value] of Object.entries(review.binding)){if(key!=='snapshotId')requireValue(source[key]===value&&ir.source[key]===value);}
  for(const key of ['wires','labels','graphics','displayOrder','coordinateSystem','viewport','primitiveMappings','symbolDefinitions','junctions','annotations'] as const)requireValue(equal(ir[key],snapshot[key]));
  requireValue(equal(ir.ports.map(({netId:_,...port})=>port),snapshot.ports));
  const instances=snapshot.instances as {id:string;name:string;master:unknown;placement:unknown;parameters:unknown;sourceTerminalSet:unknown;terminals:unknown[];bulkBinding?:unknown}[];
  requireValue(instances.length===33&&ir.devices.length===33&&ir.ports.length===6&&ir.nets.length===17&&ir.wires.length===181&&ir.labels.length===24&&ir.graphics.length===48&&ir.displayOrder.length===292);
  const sourceNets=snapshot.nets as {id:string;name:string|null;nameStatus:string;members:{objectId:string;objectKind:string}[]}[];
  requireValue(equal(sourceNets.map(n=>({...n,members:n.members.map(m=>({...m,objectKind:m.objectKind==='instance_terminal'?'device_pin':m.objectKind}))})),ir.nets));
  const owners=new Map<string,string>();
  for(const net of ir.nets)for(const member of net.members){requireValue(!owners.has(member.objectId));owners.set(member.objectId,net.id);}
  let pins=0;
  ir.devices.forEach((device,index)=>{
    const original=instances[index];requireValue(original);
    for(const key of ['id','name','master','placement','parameters','sourceTerminalSet'] as const)requireValue(equal(original[key],device[key]));
    requireValue(equal(original.bulkBinding??null,device.bulkBinding??null)&&equal(original.terminals,device.pins.map(({netId:_,...pin})=>pin)));
    requireValue(equal(device.sourceTerminalSet,device.pins.map(pin=>pin.id)));
    for(const pin of device.pins){pins++;requireValue(pin.position===null&&pin.positionStatus==='unavailable_in_current_view'&&pin.terminalRole==='unknown'&&owners.get(pin.id)===pin.netId);}
  });
  for(const port of ir.ports)requireValue(port.position===null&&port.positionStatus==='unavailable_in_current_view'&&owners.get(port.id)===port.netId);
  requireValue(pins===108&&owners.size===114&&ir.symbolDefinitions.length===0&&ir.junctions.length===0&&ir.annotations.length===0&&Object.keys(ir.conditions).length===0);
  requireValue(ir.coordinateSystem.databaseUnitsPerUserUnit===160&&ir.coordinateSystem.unit==='database_unit'&&ir.coordinateSystem.xAxisDirection==='right'&&ir.coordinateSystem.yAxisDirection==='up'&&ir.coordinateSystem.grid.snapSpacingX===null&&ir.coordinateSystem.grid.snapSpacingY===null);
  requireValue(new Set(ir.displayOrder).size===292&&ir.wires.every(w=>ir.nets.some(n=>n.id===w.netId)));
  return ir;
}
