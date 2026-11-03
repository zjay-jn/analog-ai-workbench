import {hitTestSafeSvgSceneV1, type SafeSvgSceneV1, type SafeSvgHitTargetV1} from '../../../../../packages/schematic-workbench/src/viewer/svg-scene';

type Primitive = {tag: string; attributes: Readonly<Record<string, unknown>>; target?: SafeSvgHitTargetV1['target'] | null};
type Scene = Pick<SafeSvgSceneV1, 'viewport' | 'geometryVisible' | 'hitTargets'> & {primitives: readonly Primitive[]};
const key = (target: SafeSvgHitTargetV1['target']) => JSON.stringify([target.artifactId, target.revisionId, target.occurrencePath, target.definitionId, target.elementKind, target.elementId]);

// Source instance bounds include old annotation space and overlap neighboring
// MOS bodies. Click the actually drawn symbol, retaining the admitted identity.
export function schematicCanvasHitTargets(scene: Scene, reviewed: boolean): readonly SafeSvgHitTargetV1[] {
  if (!reviewed) return scene.hitTargets;
  const bodies = new Map<string, {minX: number; minY: number; maxX: number; maxY: number}>();
  for (const primitive of scene.primitives) {
    if (primitive.target?.elementKind !== 'instance') continue;
    const a = primitive.attributes;
    let points: {x: number; y: number}[] = [];
    if (primitive.tag === 'polyline' && typeof a.points === 'string') {
      const values = a.points.trim().split(/[\s,]+/).map(Number);
      if (values.length % 2 || !values.every(Number.isFinite)) continue;
      points = values.flatMap((x, index) => index % 2 === 0 ? [{x, y: values[index + 1]!}] : []);
    } else if (primitive.tag === 'circle' && typeof a.cx === 'number' && typeof a.cy === 'number' && typeof a.r === 'number') {
      points = [{x: a.cx - a.r, y: a.cy - a.r}, {x: a.cx + a.r, y: a.cy + a.r}];
    }
    if (!points.length || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
    const id = key(primitive.target), bounds = bodies.get(id) ?? {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
    for (const point of points) {
      bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
      bounds.minY = Math.min(bounds.minY, point.y); bounds.maxY = Math.max(bounds.maxY, point.y);
    }
    bodies.set(id, bounds);
  }
  return scene.hitTargets.map(hit => {
    const body = bodies.get(key(hit.target)); if (!body) return hit;
    const v = scene.viewport;
    const shape = {kind: 'rect' as const, minX: body.minX * v.zoom + v.translateXCss, maxX: body.maxX * v.zoom + v.translateXCss,
      minY: body.minY * v.zoom + v.translateYCss, maxY: body.maxY * v.zoom + v.translateYCss};
    return {...hit, shape, screenArea: (shape.maxX - shape.minX) * (shape.maxY - shape.minY)};
  });
}

export function hitTestSchematicCanvas(scene: Pick<SafeSvgSceneV1, 'geometryVisible' | 'hitTargets'>, pointCss: {x: number; y: number}, toleranceCssPx = 6, reviewed = false) {
  // An exact body hit wins over a neighboring body's tolerance halo.
  const exact = reviewed ? hitTestSafeSvgSceneV1({...scene, hitTargets: scene.hitTargets.filter(hit => hit.target.elementKind === 'instance')}, {pointCss, toleranceCssPx: 0}) : null;
  return exact ?? hitTestSafeSvgSceneV1(scene, {pointCss, toleranceCssPx});
}
