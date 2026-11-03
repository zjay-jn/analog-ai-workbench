import type {SafeSvgSceneV1} from '../../../../../packages/schematic-workbench/src/viewer/svg-scene';
import {VIEWER_INTERACTION_CONTRACT_V1, type ViewerViewportV1} from '../../../../../packages/schematic-workbench/src/viewer/view-state';

type Point = Readonly<{x: number; y: number}>;
export type SchematicDragBox = Readonly<{x: number; y: number; width: number; height: number}>;

export function schematicDragBox(start: Point, end: Point, viewport: {widthCss: number; heightCss: number}): SchematicDragBox {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  const a = {x: clamp(start.x, viewport.widthCss), y: clamp(start.y, viewport.heightCss)};
  const b = {x: clamp(end.x, viewport.widthCss), y: clamp(end.y, viewport.heightCss)};
  return {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)};
}

export function devicesInSchematicBox(scene: Pick<SafeSvgSceneV1, 'geometryVisible' | 'hitTargets'>, box: SchematicDragBox) {
  if (!scene.geometryVisible || box.width < 3 || box.height < 3) return [];
  return scene.hitTargets.filter(({target, shape}) => target.elementKind === 'instance' && shape.kind === 'rect'
    && shape.minX >= box.x && shape.maxX <= box.x + box.width
    && shape.minY >= box.y && shape.maxY <= box.y + box.height).map(hit => hit.target);
}

/** Select local geometry only. A selected wire does not select distant same-net wires. */
export function elementsInSchematicBox(scene: Pick<SafeSvgSceneV1, 'geometryVisible' | 'hitTargets'>, box: SchematicDragBox) {
  if (!scene.geometryVisible || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 3 || box.height < 3) return [];
  const inside = (p: Point) => p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
  return scene.hitTargets.filter(({target, shape}) => {
    if (target.elementKind === 'instance' && shape.kind === 'rect') return inside({x: shape.minX, y: shape.minY}) && inside({x: shape.maxX, y: shape.maxY});
    if (target.elementKind === 'wire' && shape.kind === 'polyline') return shape.points.length > 1 && shape.points.every(inside);
    if (target.elementKind === 'label' && shape.kind === 'point') return inside(shape.point);
    return false;
  }).map(hit => hit.target);
}

export function schematicBoxZoomIn(box: SchematicDragBox, viewport: ViewerViewportV1) {
  if (![box.x, box.y, box.width, box.height, ...Object.values(viewport)].every(Number.isFinite)
    || box.width < 3 || box.height < 3 || viewport.widthCss <= 0 || viewport.heightCss <= 0
    || viewport.zoom < VIEWER_INTERACTION_CONTRACT_V1.minZoom || viewport.zoom >= VIEWER_INTERACTION_CONTRACT_V1.maxZoom
    || box.x < 0 || box.y < 0 || box.x + box.width > viewport.widthCss || box.y + box.height > viewport.heightCss) return null;
  const factor = Math.min(viewport.widthCss / box.width, viewport.heightCss / box.height);
  if (factor <= 1) return null;
  const zoom = Math.min(VIEWER_INTERACTION_CONTRACT_V1.maxZoom, viewport.zoom * factor);
  const worldX = (box.x + box.width / 2 - viewport.translateXCss) / viewport.zoom;
  const worldY = (box.y + box.height / 2 - viewport.translateYCss) / viewport.zoom;
  return {type: 'zoom-box' as const, viewport: {...viewport, zoom,
    translateXCss: viewport.widthCss / 2 - worldX * zoom, translateYCss: viewport.heightCss / 2 - worldY * zoom}};
}
