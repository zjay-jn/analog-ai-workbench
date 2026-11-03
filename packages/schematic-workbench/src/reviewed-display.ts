import type {ReviewedArtifactRefV1, ReviewedDocumentRefV1} from '../../document-contract/src/reviewed-identity';
import type {CircuitBoundsV1, CircuitPointV1, ReviewedCircuitIrV1} from './reviewed-circuit-ir';

export const REVIEWED_DISPLAY_VERSION = 'aaw.reviewed-display/v1' as const;
export type SourceOrientation = 'R0'|'R90'|'R180'|'R270'|'MX'|'MY'|'MXR90'|'MYR90';
export type SourcePlacement = Readonly<{origin:CircuitPointV1; orientation:SourceOrientation; boundingBox:Readonly<{lowerLeft:CircuitPointV1;upperRight:CircuitPointV1}>}>;
export type ReviewedParameter = Readonly<{name:string;valueText:string}>;
export type ReviewedDeviceMetadata = Readonly<{
  id:string; name:string; master:Readonly<{library:string;cell:string;view:string}>;
  placement:SourcePlacement; parameters:readonly ReviewedParameter[]; pinIds:readonly string[];
  displayKind:'nmos'|'pmos'|'placeholder'; renderEvidence:'builtin_normalized_display_only'|'placeholder';
  bulkBinding?:Readonly<{evidence:'none';status:'implicit_unresolved'}>;
}>;
export type ReviewedTerminalMetadata = Readonly<{
  id:string; instanceId:string|null; name:string|null; nameStatus:string; netId:string;
  terminalRole:'unknown'; positionStatus:'unavailable_in_current_view'; position:null;
}>;
export type ReviewedNetMetadata = Readonly<{id:string;name:string|null;nameStatus:string;memberIds:readonly string[];wireIds:readonly string[]}>;
export type ReviewedLabelMetadata = Readonly<{id:string;text:string;position:CircuitPointV1;orientation:SourceOrientation;rotation:number;alignment:string;targetKind:string;targetId:string|null}>;
export type ReviewedGeometry = Readonly<{
  key:string; sourceId:string; sourceKind:'instance'|'port'|'wire'|'label'|'graphic';
  netId:string|null;
}> & (Readonly<{tag:'polyline';points:readonly CircuitPointV1[];filled:boolean}>
  | Readonly<{tag:'circle';center:CircuitPointV1;radius:number;filled:boolean}>
  | Readonly<{tag:'text';position:CircuitPointV1;text:string;rotation:number;anchor:'start'|'middle'|'end'}>);
/** Geometry and topology coordinates both use T(x,y)=(100x,-100y). Metadata placement/label coordinates remain source coordinates. */
export type ReviewedDisplayV1 = Readonly<{
  contractVersion:typeof REVIEWED_DISPLAY_VERSION; documentRef:ReviewedDocumentRefV1; artifactRef:ReviewedArtifactRefV1;
  sourceDigest:string; adaptedDigest:string; definitionId:string;
  source:Readonly<{snapshotId:string;irId:string;reviewRef:string;library:string;cell:string;view:string;
    coordinateUnit:'database_unit';dbuPerUserUnit:160;axisX:'right';axisY:'up';gridSpacing:null}>;
  transform:Readonly<{scaleX:100;scaleY:-100}>;
  glyphRevision:'builtin-normalized-mos-v1-user-frozen';
  counts:Readonly<{devices:33;pins:108;ports:6;nets:17;wires:181;labels:24;graphics:48;displayOrder:292;unknownAnchors:114}>;
  devices:readonly ReviewedDeviceMetadata[]; terminals:readonly ReviewedTerminalMetadata[];
  ports:readonly Readonly<{id:string;name:string;direction:string;netId:string;displayPlacement:SourcePlacement}>[];
  nets:readonly ReviewedNetMetadata[]; labels:readonly ReviewedLabelMetadata[];
  displayOrder:readonly Readonly<{objectKind:string;objectId:string}>[];
  primitives:readonly ReviewedGeometry[];
  instanceBounds:readonly Readonly<{instanceId:string;bounds:CircuitBoundsV1}>[];
}>;
export type ReviewedSchematicEnvelope = Readonly<{reviewedCircuitIr:ReviewedCircuitIrV1;display:ReviewedDisplayV1}>;
