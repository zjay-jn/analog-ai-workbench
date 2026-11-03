// SPDX-License-Identifier: MIT
// Lab-derived display code: public grant recorded in docs/SOURCE_PERMISSIONS.md.
import type {ReviewedDeviceMetadata, ReviewedDisplayV1, ReviewedGeometry, SourceOrientation, SourcePlacement} from '../reviewed-display';
import {reviewedTextWorldBox} from './reviewed-text-layout';

export const REVIEWED_PORT_DISPLAY_VERSION = 'aaw.reviewed-port-display/v1' as const;
type Text = Extract<ReviewedGeometry, {tag: 'text'}>;
type Port = ReviewedDisplayV1['ports'][number];
const basicDirection: Readonly<Record<string, string>> = {ipin: 'input', opin: 'output', iopin: 'inout'};
function samePlacement(a: SourcePlacement, b: SourcePlacement) {
  return a.orientation === b.orientation && a.origin.x === b.origin.x && a.origin.y === b.origin.y
    && a.boundingBox.lowerLeft.x === b.boundingBox.lowerLeft.x && a.boundingBox.lowerLeft.y === b.boundingBox.lowerLeft.y
    && a.boundingBox.upperRight.x === b.boundingBox.upperRight.x && a.boundingBox.upperRight.y === b.boundingBox.upperRight.y;
}

// Exact exported display placement + master kind, never a PINn/name heuristic.
// The association is for display only; electrical anchors remain unavailable.
export function reviewedBasicPort(display: ReviewedDisplayV1, device: ReviewedDeviceMetadata): Port | null {
  if (device.displayKind !== 'placeholder' || device.master.library !== 'basic' || !Object.hasOwn(basicDirection, device.master.cell)) return null;
  const candidates = display.ports.filter(port => port.direction === basicDirection[device.master.cell] && samePlacement(device.placement, port.displayPlacement));
  const owners = display.devices.filter(other => other.master.library === 'basic' && Object.hasOwn(basicDirection, other.master.cell) && samePlacement(device.placement, other.placement));
  return candidates.length === 1 && owners.length === 1 ? candidates[0]! : null;
}

// Adapted from the already approved Lab viewer.js renderPort/textOrientationTransform.
// Coordinates here are display world units, with Y down. No Node/DOM dependency.
const orientationMatrix: Readonly<Record<SourceOrientation, readonly [number, number, number, number]>> = {
  R0: [1, 0, 0, 1], R90: [0, 1, -1, 0], R180: [-1, 0, 0, -1], R270: [0, -1, 1, 0],
  MX: [1, 0, 0, -1], MY: [-1, 0, 0, 1], MXR90: [0, -1, -1, 0], MYR90: [0, 1, 1, 0],
};
export function reviewedPortGeometry(device: ReviewedDeviceMetadata, port: Port): readonly ReviewedGeometry[] {
  const origin = {x: port.displayPlacement.origin.x * 100, y: -port.displayPlacement.origin.y * 100};
  const local = port.direction === 'input' ? [[-12, -8], [1, 0], [-12, 8]] : port.direction === 'output' ? [[12, -8], [-1, 0], [12, 8]] : [[0, -10], [10, 0], [0, 10], [-10, 0]];
  const m = orientationMatrix[port.displayPlacement.orientation];
  const points = local.map(([x, y]) => ({x: origin.x + m[0] * x! + m[1] * y!, y: origin.y + m[2] * x! + m[3] * y!}));
  const common = {sourceKind: 'instance' as const, sourceId: device.id, netId: port.netId};
  return [{...common, key: device.id + ':port-outline', tag: 'polyline', points: [...points, points[0]!], filled: false},
    {...common, key: device.id + ':port-display-origin', tag: 'circle', center: origin, radius: 2.5, filled: false}];
}

export function readableReviewedText(text: Text, orientation?: SourceOrientation): Text {
  const horizontal = orientation && ['R0', 'R180', 'MX', 'MY'].includes(orientation);
  let rotation = horizontal ? 0 : ((text.rotation + 180) % 360 + 360) % 360 - 180;
  const reverse = horizontal ? orientation === 'R180' || orientation === 'MY' : rotation > 90 || rotation < -90;
  if (!horizontal) {
    if (rotation > 90) rotation -= 180;
    else if (rotation < -90) rotation += 180;
  }
  const anchor = reverse && text.anchor !== 'middle' ? text.anchor === 'start' ? 'end' : 'start' : text.anchor;
  return rotation === text.rotation && anchor === text.anchor ? text : {...text, rotation, anchor};
}

function equivalentGraphic(text: Text, device: ReviewedDeviceMetadata, port: Port) {
  const b = device.placement.boundingBox, p = text.position;
  return text.sourceKind === 'graphic' && text.text === port.name
    && p.x >= b.lowerLeft.x * 100 && p.x <= b.upperRight.x * 100 && p.y >= -b.upperRight.y * 100 && p.y <= -b.lowerLeft.y * 100;
}

// A port name can sit across an unrelated exported wire (VIN beside VBIAS3).
// Keep clear names unchanged; move only the displayed text by a bounded amount.
function clearPortNameWires(text: Text, port: Port, display: ReviewedDisplayV1): Text {
  const wireBoxes = display.primitives.flatMap(p => p.sourceKind === 'wire' && p.tag === 'polyline' && p.netId !== port.netId
    ? p.points.slice(1).map((b, index) => {const a = p.points[index]!; return {
      minX: Math.min(a.x, b.x) - 1.5, maxX: Math.max(a.x, b.x) + 1.5,
      minY: Math.min(a.y, b.y) - 1.5, maxY: Math.max(a.y, b.y) + 1.5,
    };}) : []);
  const clear = (candidate: Text) => {const b = reviewedTextWorldBox(candidate);
    return !wireBoxes.some(w => b.minX < w.maxX && b.maxX > w.minX && b.minY < w.maxY && b.maxY > w.minY);};
  if (clear(text)) return text;
  for (let distance = 2; distance <= 16; distance += 2) for (const dy of [distance, -distance]) {
    const candidate = {...text, position: {...text.position, y: text.position.y + dy}};
    if (clear(candidate)) return candidate;
  }
  return text;
}

export function presentReviewedPorts(display: ReviewedDisplayV1): readonly ReviewedGeometry[] {
  const matched = display.devices.flatMap(device => {const port = reviewedBasicPort(display, device); return port ? [{device, port}] : [];});
  const byDevice = new Map(matched.map(match => [match.device.id, match]));
  const emitted = new Set<string>();
  const graphicOwners = new Map<string, typeof matched[number]>();
  for (const primitive of display.primitives) if (primitive.tag === 'text' && primitive.sourceKind === 'graphic') {
    const owners = matched.filter(({device, port}) => equivalentGraphic(primitive, device, port));
    if (owners.length === 1) graphicOwners.set(primitive.key, owners[0]!);
  }
  const result: ReviewedGeometry[] = [];
  for (const primitive of display.primitives) {
    const match = primitive.sourceKind === 'instance' ? byDevice.get(primitive.sourceId) : undefined;
    if (match) {
      if (!emitted.has(match.device.id)) {
        emitted.add(match.device.id); result.push(...reviewedPortGeometry(match.device, match.port));
        const hasName = [...graphicOwners.values()].some(owner => owner.device.id === match.device.id)
          || display.primitives.some(p => p.tag === 'text' && p.sourceKind === 'label' && p.netId === match.port.netId && p.text === match.port.name
            && Math.hypot(p.position.x - match.port.displayPlacement.origin.x * 100, p.position.y + match.port.displayPlacement.origin.y * 100) <= 80);
        if (!hasName) {
          const geometry = reviewedPortGeometry(match.device, match.port)[0]!;
          if (geometry.tag === 'polyline') {
            const x = Math.max(...geometry.points.map(p => p.x)) + 7, y = Math.min(...geometry.points.map(p => p.y)) - 5;
            result.push({key: match.device.id + ':port-net-name', sourceId: match.device.id, sourceKind: 'instance', netId: match.port.netId,
              tag: 'text', text: match.port.name, position: {x, y}, rotation: 0, anchor: 'start'});
          }
        }
      }
      continue;
    }
    if (primitive.tag === 'text') {
      const graphicOwner = graphicOwners.get(primitive.key);
      const label = primitive.sourceKind === 'label' ? display.labels.find(label => label.id === primitive.sourceId && label.targetKind === 'net') : undefined;
      if (graphicOwner || label) {
        const readable = readableReviewedText(primitive, graphicOwner?.port.displayPlacement.orientation ?? label!.orientation);
        result.push(graphicOwner ? clearPortNameWires(readable, graphicOwner.port, display) : readable); continue;
      }
    }
    result.push(primitive);
  }
  return result;
}
