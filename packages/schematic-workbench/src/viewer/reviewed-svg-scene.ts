import type {ReviewedArtifactRefV1} from '../../../document-contract/src/reviewed-identity';
import type {ReviewedSchematicEnvelope} from '../reviewed-display';
import {validateReviewedSchematicEnvelope} from '../reviewed-display-validation';
import {ViewerViewStateError,viewerWorldToScreenV1,type ViewerElementTargetV1,type ViewerViewStateV1} from './view-state';
import {SVG_LAYER_ORDER_V1,type SafeSvgPrimitiveV1,type SafeSvgSceneV1,type SafeSvgHitTargetV1,type SafeSvgLayerKindV1,type SchematicViewerRenderStateV1} from './svg-scene';
import {layoutReviewedDisplayText} from './reviewed-text-layout';
import {presentReviewedPorts} from './reviewed-port-display';

export type ReviewedSvgPrimitiveV1=Omit<SafeSvgPrimitiveV1,'target'>&Readonly<{target:ViewerElementTargetV1|null}>;
export type ReviewedSvgSceneV1=Omit<SafeSvgSceneV1,'primitives'|'layers'|'persistentBanner'>&Readonly<{
  primitives:readonly ReviewedSvgPrimitiveV1[];layers:readonly Readonly<{kind:SafeSvgLayerKindV1;primitives:readonly ReviewedSvgPrimitiveV1[]}>[];
  persistentBanner:'REVIEWED EXPORT · READ-ONLY · ELECTRICAL ANCHORS UNKNOWN';
}>;
export function buildReviewedSvgSceneV1(input:Readonly<{envelope:ReviewedSchematicEnvelope;artifactRef:ReviewedArtifactRefV1;viewState:ViewerViewStateV1;renderState:SchematicViewerRenderStateV1}>):ReviewedSvgSceneV1{
  const {display,reviewedCircuitIr}=validateReviewedSchematicEnvelope(input.envelope),{viewState,artifactRef,renderState}=input;
  const exact=(v:{artifactId:string;revisionId:string})=>v.artifactId===artifactRef.artifactId&&v.revisionId===artifactRef.revisionId;
  if(!exact(display.artifactRef)||!exact(viewState.artifactBinding)||viewState.occurrencePath.length||viewState.selection.some(t=>!exact(t)||t.definitionId!==display.definitionId||t.occurrencePath.length)||viewState.netHighlight&&(!exact(viewState.netHighlight)||viewState.netHighlight.definitionId!==display.definitionId||viewState.netHighlight.occurrencePath.length))throw new ViewerViewStateError('REVISION_UNAVAILABLE','Reviewed revision unavailable');
  const geometryVisible=renderState.status==='ready',primitives:ReviewedSvgPrimitiveV1[]=[],hitTargets:SafeSvgHitTargetV1[]=[];
  const target=(kind:ViewerElementTargetV1['elementKind'],id:string):ViewerElementTargetV1=>({artifactId:artifactRef.artifactId,revisionId:artifactRef.revisionId,occurrencePath:[],definitionId:display.definitionId,elementKind:kind,elementId:id});
  if(geometryVisible){
    for(const g of layoutReviewedDisplayText(display,presentReviewedPorts(display))){
      const t=g.sourceKind==='graphic'?null:target(g.sourceKind,g.sourceId);
      const attributes:Record<string,string|number>={fill:'none',stroke:'currentColor',strokeWidth:1.25,vectorEffect:'non-scaling-stroke',strokeLinecap:'round',strokeLinejoin:'round'};
      if(g.tag==='polyline'){attributes.points=g.points.map(p=>p.x+','+p.y).join(' ');if(g.filled)attributes.fill='currentColor';}
      else if(g.tag==='circle'){attributes.cx=g.center.x;attributes.cy=g.center.y;attributes.r=g.radius;if(g.filled)attributes.fill='currentColor';}
      else {attributes.x=g.position.x;attributes.y=g.position.y;attributes.fill='currentColor';attributes.stroke='none';attributes.textAnchor=g.anchor;if(g.rotation)attributes.transform=`rotate(${g.rotation} ${g.position.x} ${g.position.y})`;}
      const primitive:ReviewedSvgPrimitiveV1={key:g.key,tag:g.tag,layer:'base',attributes,text:g.tag==='text'?g.text:null,styleToken:g.tag==='text'?'base-label':g.sourceKind==='wire'?'base-wire':'base-instance',target:t};primitives.push(primitive);
      if(viewState.netHighlight&&g.netId===viewState.netHighlight.netId)primitives.push({...primitive,key:g.key+':net',layer:'net',styleToken:'net-highlight'});
      if(t&&viewState.selection.some(s=>s.elementId===t.elementId&&s.elementKind===t.elementKind))primitives.push({...primitive,key:g.key+':selected',layer:'selection',styleToken:'selection-highlight'});
    }
    for(const {instanceId,bounds} of display.instanceBounds){
      const a=viewerWorldToScreenV1(viewState.viewport,{x:bounds.minX,y:bounds.minY}),b=viewerWorldToScreenV1(viewState.viewport,{x:bounds.maxX,y:bounds.maxY});
      hitTargets.push({target:target('instance',instanceId),priority:3,screenArea:Math.abs((b.x-a.x)*(b.y-a.y)),shape:{kind:'rect',minX:a.x,minY:a.y,maxX:b.x,maxY:b.y}});
    }
    for(const wire of reviewedCircuitIr.definitions[0]!.wires){
      const points=wire.points!.map(p=>viewerWorldToScreenV1(viewState.viewport,p));
      const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
      hitTargets.push({target:target('wire',wire.wireId),priority:2,screenArea:(Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys)),shape:{kind:'polyline',points}});
    }
    for(const label of display.labels){const p=reviewedCircuitIr.definitions[0]!.labels.find(l=>l.labelId===label.id)!;hitTargets.push({target:target('label',label.id),priority:1,screenArea:0,shape:{kind:'point',point:viewerWorldToScreenV1(viewState.viewport,{x:p.x!,y:p.y!}),radiusCss:0}});}
  }
  const layers=SVG_LAYER_ORDER_V1.map(kind=>({kind,primitives:primitives.filter(p=>p.layer===kind)}));
  return {viewport:viewState.viewport,layers,primitives:layers.flatMap(l=>l.primitives),hitTargets,geometryVisible,deliveryAllowed:geometryVisible,cancelDelivery:renderState.status==='revoked'||renderState.status==='quarantined',historicalWarningVisible:renderState.status==='ready'&&renderState.freshness==='historical',overlayVisible:false,overlayLocalErrorVisible:false,persistentBanner:'REVIEWED EXPORT · READ-ONLY · ELECTRICAL ANCHORS UNKNOWN',overlayBanner:null};
}
