// SPDX-License-Identifier: MIT
// Lab-derived display code: public grant recorded in docs/SOURCE_PERMISSIONS.md.
import {canonicalizeAawJsonV1} from './canonical-json';
import {admitFoldedSources,FOLDED_SOURCE_DIGEST,sha256,type FoldedSourceFiles,type FoldedSourceIr} from './folded-source-profile';
import {validateReviewedCircuitIrV1,type CircuitBoundsV1,type CircuitPointV1} from './reviewed-circuit-ir';
import {REVIEWED_DISPLAY_VERSION,type ReviewedDisplayV1,type ReviewedGeometry,type ReviewedSchematicEnvelope,type SourceOrientation,type SourcePlacement} from './reviewed-display';

const DOCUMENT_REF={documentId:'reviewed.schematic.folded-cascode',revisionId:'export-20260829-001',documentKind:'schematic_reviewed'} as const;
const ARTIFACT_REF={artifactId:'reviewed.circuit-ir.folded-cascode',revisionId:'folded-adapter-v1',artifactKind:'circuit_ir_reviewed'} as const;
const ROOT='definition:folded-cascode';
export const FOLDED_ORIENTATION_MATRICES:Readonly<Record<SourceOrientation,readonly [number,number,number,number]>>=Object.freeze({R0:[1,0,0,1],R90:[0,-1,1,0],R180:[-1,0,0,-1],R270:[0,1,-1,0],MX:[1,0,0,-1],MY:[-1,0,0,1],MXR90:[0,1,1,0],MYR90:[0,-1,-1,0]});
const clean=(n:number)=>n===0?0:n;
export const foldedSourceToDisplay=(p:CircuitPointV1):CircuitPointV1=>({x:clean(100*p.x),y:clean(-100*p.y)});
export function foldedLocalToDisplay(placement:SourcePlacement,p:CircuitPointV1):CircuitPointV1{
  const m=FOLDED_ORIENTATION_MATRICES[placement.orientation];if(!m)throw new TypeError('Unsupported reviewed orientation');
  return foldedSourceToDisplay({x:placement.origin.x+m[0]*p.x+m[1]*p.y,y:placement.origin.y+m[2]*p.x+m[3]*p.y});
}
function box(b:SourcePlacement['boundingBox']):CircuitBoundsV1{return {minX:100*b.lowerLeft.x,minY:-100*b.upperRight.y,maxX:100*b.upperRight.x,maxY:-100*b.lowerLeft.y};}
function anchor(alignment:string):'start'|'middle'|'end'{return alignment.includes('left')?'start':alignment.includes('right')?'end':'middle';}

/** Minimal adaptation of Lab viewer.js lines 185-202,244-260,498-518,688-794; no DOM/runtime or electrical-anchor inference. */
function deviceGeometry(device:FoldedSourceIr['devices'][number],kind:'nmos'|'pmos'|'placeholder'):ReviewedGeometry[]{
  const result:ReviewedGeometry[]=[];
  const common=()=>({key:device.id+':glyph:'+result.length,sourceId:device.id,sourceKind:'instance' as const,netId:null});
  const point=(x:number,y:number)=>foldedLocalToDisplay(device.placement,{x,y});
  const line=(coords:readonly (readonly [number,number])[],filled=false)=>result.push({...common(),tag:'polyline',points:coords.map(([x,y])=>point(x,y)),filled});
  const text=(position:CircuitPointV1,value:string,a:'start'|'middle'|'end'='start')=>result.push({...common(),tag:'text',position,text:value,rotation:0,anchor:a});
  if(kind==='placeholder'){
    line([[-.05,-.05],[.05,-.05],[.05,.05],[-.05,.05],[-.05,-.05]]);
    text(point(0,0),'?','middle');text(point(.08,.06),device.name);return result;
  }
  line([[.25,-.1875],[.25,-.13],[.17,-.13]]);line([[.25,.1875],[.25,.13],[.17,.13]]);
  line([[.17,-.13],[.17,.13]]);line([[.135,-.13],[.135,.13]]);line([[0,0],[kind==='pmos'?.095:.135,0]]);
  if(kind==='pmos')result.push({...common(),tag:'circle',center:point(.1125,0),radius:1.25,filled:false});
  line([[.17,0],[.25,0]]);
  const direction=kind==='pmos'?-1:1,y=kind==='pmos'?.13:-.13;
  const tip:[number,number]=[.21+direction*.018,y];
  line([tip,[.21-direction*.008,y+.024],[.21-direction*.008,y-.024],tip],true);
  const label=point(.34,.17),origin=point(0,0),a=label.x<origin.x?'end':'start';text(label,device.name,a);
  // Parameter literals, including source quotes, are deliberately preserved.
  const summary=['w','l'].map(name=>device.parameters.find(p=>p.name===name)).filter(p=>p!==undefined).map(p=>p.name.toUpperCase()+'='+p.valueText).join(' · ');
  if(summary)text({x:label.x,y:label.y+15},summary,a);
  return result;
}

export function adaptFoldedReviewedSources(files:FoldedSourceFiles):ReviewedSchematicEnvelope {
  const ir=admitFoldedSources(files),bounds=box(ir.viewport.contentBoundingBox);
  const kinds=new Map(ir.primitiveMappings.map(m=>[JSON.stringify(m.master),m.mappingKind==='builtin_primitive'?m.primitiveType:'placeholder']));
  const devices:ReviewedDisplayV1['devices']=ir.devices.map(d=>{
    const kind=kinds.get(JSON.stringify(d.master));if(kind!=='nmos'&&kind!=='pmos'&&kind!=='placeholder')throw new TypeError('Unsupported reviewed device');
    return {id:d.id,name:d.name,master:d.master,placement:d.placement,parameters:d.parameters,pinIds:d.pins.map(p=>p.id),displayKind:kind,renderEvidence:kind==='placeholder'?'placeholder':'builtin_normalized_display_only',...(d.bulkBinding===undefined?{}:{bulkBinding:d.bulkBinding})};
  });
  const pins=ir.devices.flatMap(d=>d.pins.map(p=>({pinId:p.id,instanceId:d.id,terminalId:p.id,netId:p.netId})));
  const ports=ir.ports.map(p=>({portId:p.id,netId:p.netId}));
  const wires=ir.wires.map(w=>({wireId:w.id,netId:w.netId,points:w.points.map(foldedSourceToDisplay)}));
  const labels=ir.labels.map(l=>({labelId:l.id,text:l.text,...foldedSourceToDisplay(l.position)}));
  const nets=ir.nets.map(n=>({netId:n.id,memberElementIds:[...n.members.map(m=>m.objectId),...ir.wires.filter(w=>w.netId===n.id).map(w=>w.id)]}));
  const instances=ir.devices.map(d=>({instanceId:d.id,blackbox:true as const,bounds:box(d.placement.boundingBox)}));
  const renderOrder=ir.displayOrder.filter(id=>!ir.graphics.some(g=>g.id===id));
  renderOrder.push(...pins.map(p=>p.pinId));
  const reviewedCircuitIr=validateReviewedCircuitIrV1({schemaVersion:'aaw.circuit-ir.reviewed/v1alpha1',canonicalizationVersion:'aaw-json-c14n/v1',coordinateUnit:'reviewed_display_100x_source_y_down',bounds,rootDefinitionId:ROOT,definitions:[{definitionId:ROOT,bounds,instances,pins,ports,nets,wires,labels,renderOrder}]});
  const geometry=new Map<string,ReviewedGeometry[]>();
  ir.devices.forEach((d,index)=>geometry.set(d.id,deviceGeometry(d,devices[index]!.displayKind)));
  for(const w of wires)geometry.set(w.wireId,[{key:w.wireId,sourceId:w.wireId,sourceKind:'wire',netId:w.netId,tag:'polyline',points:w.points,filled:false}]);
  for(const l of ir.labels)geometry.set(l.id,[{key:l.id,sourceId:l.id,sourceKind:'label',netId:l.targetKind==='net'?l.targetId:null,tag:'text',position:foldedSourceToDisplay(l.position),text:l.text,rotation:clean(-l.rotation),anchor:anchor(l.alignment)}]);
  for(const g of ir.graphics){
    const common={key:g.id,sourceId:g.id,sourceKind:'graphic' as const,netId:null};
    if(g.primitiveKind==='circle'){
      if(g.radiusX!==g.radiusY)throw new TypeError('Unsupported reviewed ellipse');
      geometry.set(g.id,[{...common,tag:'circle',center:foldedSourceToDisplay(g.center),radius:g.radiusX*100,filled:false}]);
    }else geometry.set(g.id,[{...common,tag:'text',position:foldedSourceToDisplay(g.position),text:g.text,rotation:clean(-g.rotation),anchor:anchor(g.alignment)}]);
  }
  const displayWithoutDigest:Omit<ReviewedDisplayV1,'adaptedDigest'>={
    contractVersion:REVIEWED_DISPLAY_VERSION,documentRef:DOCUMENT_REF,artifactRef:ARTIFACT_REF,sourceDigest:FOLDED_SOURCE_DIGEST,definitionId:ROOT,
    source:{snapshotId:ir.source.snapshotId!,irId:ir.irId,reviewRef:ir.source.reviewRef!,...ir.design,coordinateUnit:'database_unit',dbuPerUserUnit:160,axisX:'right',axisY:'up',gridSpacing:null},
    transform:{scaleX:100,scaleY:-100},glyphRevision:'builtin-normalized-mos-v1-user-frozen',
    counts:{devices:33,pins:108,ports:6,nets:17,wires:181,labels:24,graphics:48,displayOrder:292,unknownAnchors:114},devices,
    terminals:[...ir.devices.flatMap(d=>d.pins.map(p=>({...p,instanceId:d.id}))),...ir.ports.map(p=>({id:p.id,instanceId:null,name:p.name,nameStatus:'source_named',netId:p.netId,terminalRole:'unknown' as const,positionStatus:p.positionStatus,position:null}))],
    ports:ir.ports.map(({id,name,direction,netId,displayPlacement})=>({id,name,direction,netId,displayPlacement})),
    nets:ir.nets.map(n=>({id:n.id,name:n.name,nameStatus:n.nameStatus,memberIds:n.members.map(m=>m.objectId),wireIds:ir.wires.filter(w=>w.netId===n.id).map(w=>w.id)})),
    labels:ir.labels.map(({id,text,position,orientation,rotation,alignment,targetKind,targetId})=>({id,text,position,orientation,rotation,alignment,targetKind,targetId})),
    displayOrder:ir.displayOrder.map(objectId=>({objectId,objectKind:ir.devices.some(d=>d.id===objectId)?'instance':ir.ports.some(p=>p.id===objectId)?'port':ir.wires.some(w=>w.id===objectId)?'wire':ir.labels.some(l=>l.id===objectId)?'label':'graphic'})),
    primitives:ir.displayOrder.flatMap(id=>geometry.get(id)??[]),instanceBounds:instances.map(i=>({instanceId:i.instanceId,bounds:i.bounds})),
  };
  // The digest field is excluded to avoid self-reference; every other display field and the entire topology are covered.
  const adaptedDigest=sha256(canonicalizeAawJsonV1({reviewedCircuitIr,display:displayWithoutDigest}));
  return {reviewedCircuitIr,display:{...displayWithoutDigest,adaptedDigest}};
}
