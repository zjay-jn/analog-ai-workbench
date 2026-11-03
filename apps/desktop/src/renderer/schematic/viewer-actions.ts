import {reduceViewerViewStateV1,type ViewerActionV1,type ViewerViewStateV1} from '../../../../../packages/schematic-workbench/src/viewer/view-state';
import type {SchematicViewerActionV1,SchematicViewerProps} from '../SchematicViewer';
type ViewerDelivery={artifactRef:SchematicViewerProps['artifactRef'];reviewedCircuitIr:SchematicViewerProps['circuitIr']};
function mapViewerAction(
  delivery: ViewerDelivery,
  state: ViewerViewStateV1,
  action: SchematicViewerActionV1,
): ViewerActionV1 | null {
  switch (action.type) {
    case "marquee-select":
      return null; // Applied atomically below using the existing validated selection reducer.
    case "resize-css":
      return {type:"set-viewport",viewport:{...state.viewport,widthCss:action.width,heightCss:action.height,translateXCss:state.viewport.translateXCss+(action.width-state.viewport.widthCss)/2,translateYCss:state.viewport.translateYCss+(action.height-state.viewport.heightCss)/2}};
    case "fit":
      return {type: 'fit'};
    case 'zoom-box':
      return {type: 'set-viewport', viewport: action.viewport};
    case "zoom-css":
      return {
        type: "zoom",
        factor: action.factor,
        anchorCss: action.anchorCss,
        source: "button",
      };
    case "pan-css":
      return {
        type: "set-viewport",
        viewport: {
          ...state.viewport,
          translateXCss:
            state.viewport.translateXCss + action.deltaCss.x,
          translateYCss:
            state.viewport.translateYCss + action.deltaCss.y,
        },
      };
    case "primary-select":
    case "toggle-selection-net":
      return action;
    case "open-inspector":
      return action;
    case "enter-selection": {
      const selected = state.selection.length === 1 ? state.selection[0] : undefined;
      return selected?.elementKind === "instance"
        ? { type: "enter-hierarchy", instanceId: selected.elementId }
        : null;
    }
    case "hierarchy-back":
      return { type: "back-hierarchy" };
    case "hierarchy-breadcrumb":
      return action.depth === state.occurrencePath.length
        ? null
        : { type: "breadcrumb-hierarchy", depth: action.depth };
    case "close-inspector":
      return { type: "close-inspector" };
    case "escape-highest-priority":
      return { type: "escape" };
    case "select-net-from-list":
      return {
        type: "select-net",
        target: {
          artifactId: delivery.artifactRef.artifactId,
          revisionId: delivery.artifactRef.revisionId,
          occurrencePath: action.occurrencePath,
          definitionId: action.definitionId,
          netId: action.netId,
        },
      };
  }
}

export function applySchematicViewerAction(delivery:ViewerDelivery,state:ViewerViewStateV1,action:SchematicViewerActionV1):ViewerViewStateV1{
 try{
 if(action.type==='marquee-select'){
   let next=action.ctrlKey?state:reduceViewerViewStateV1(delivery.reviewedCircuitIr,state,{type:'primary-select',target:null,ctrlKey:false});
   if(!action.ctrlKey && next.netHighlight) next={...next,netHighlight:null};
   const key=(target: SchematicViewerProps['viewState']['selection'][number])=>JSON.stringify([target.artifactId,target.revisionId,target.occurrencePath,target.definitionId,target.elementKind,target.elementId]);
   const selected=new Set(next.selection.map(key));
   for(const target of action.targets){
     if(!['instance','wire','label'].includes(target.elementKind))throw new Error('Unsupported marquee target');
     if(selected.has(key(target)))continue;
     next=reduceViewerViewStateV1(delivery.reviewedCircuitIr,next,{type:'primary-select',target,ctrlKey:true});
     selected.add(key(target));
   }
   return next;
 }
 const mapped=mapViewerAction(delivery,state,action);if(!mapped)return state;
 const next=reduceViewerViewStateV1(delivery.reviewedCircuitIr,state,mapped);
 if(action.type==='fit'&&action.viewport)return reduceViewerViewStateV1(delivery.reviewedCircuitIr,next,{type:'set-viewport',viewport:action.viewport});
 return action.type==='resize-css'&&action.fit?reduceViewerViewStateV1(delivery.reviewedCircuitIr,next,{type:'fit'}):next;
 }catch{return state;}
}
