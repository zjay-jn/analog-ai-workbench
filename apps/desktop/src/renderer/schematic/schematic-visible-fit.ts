import {fitViewerViewportV1, VIEWER_INTERACTION_CONTRACT_V1, type ViewerViewportV1} from '../../../../../packages/schematic-workbench/src/viewer/view-state';

export type SchematicTextBounds = {minX: number; minY: number; maxX: number; maxY: number};

// Reviewed text scales with geometry. Include its actual rendered glyph bounds,
// including rotation and alignment, instead of estimating font widths.
export function fitSchematicVisibleBounds(bounds: SchematicTextBounds, texts: readonly SchematicTextBounds[], size: {width: number; height: number}): ViewerViewportV1 | null {
  if (![size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) return null;
  const all = [bounds, ...texts];
  if (all.some(value => !Object.values(value).every(Number.isFinite) || value.minX > value.maxX || value.minY > value.maxY)) return null;
  const visible = {minX: Math.min(...all.map(value => value.minX)), minY: Math.min(...all.map(value => value.minY)),
    maxX: Math.max(...all.map(value => value.maxX)), maxY: Math.max(...all.map(value => value.maxY))};
  const padding = VIEWER_INTERACTION_CONTRACT_V1.fitPaddingCssPx;
  if ((visible.maxX - visible.minX) * VIEWER_INTERACTION_CONTRACT_V1.minZoom > size.width - 2 * padding
    || (visible.maxY - visible.minY) * VIEWER_INTERACTION_CONTRACT_V1.minZoom > size.height - 2 * padding) return null;
  return fitViewerViewportV1(visible, size);
}

export function measureSchematicTextBounds(canvas: SVGSVGElement, viewport: ViewerViewportV1): SchematicTextBounds[] {
  const origin = canvas.getBoundingClientRect();
  return [...canvas.querySelectorAll('text')].map(node => {
    const rect = node.getBoundingClientRect();
    return {minX: (rect.left - origin.left - viewport.translateXCss) / viewport.zoom,
      maxX: (rect.right - origin.left - viewport.translateXCss) / viewport.zoom,
      minY: (rect.top - origin.top - viewport.translateYCss) / viewport.zoom,
      maxY: (rect.bottom - origin.top - viewport.translateYCss) / viewport.zoom};
  });
}
