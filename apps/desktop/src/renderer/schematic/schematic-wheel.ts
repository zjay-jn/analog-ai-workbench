type WheelDelta = Pick<WheelEvent, 'deltaY' | 'deltaMode'>;

// Scale (not viewBox size): positive wheel delta zooms out.
export function schematicWheelFactor(event: WheelDelta, pageHeight: number): number | null {
  const unit = event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : NaN;
  if (!Number.isFinite(event.deltaY) || !Number.isFinite(unit) || unit <= 0 || event.deltaY === 0) return null;
  const pixels = Math.max(-240, Math.min(240, event.deltaY * unit));
  return Math.exp(-pixels * Math.log(1.12) / 100);
}

export function bindSchematicWheel(
  canvas: SVGSVGElement,
  zoom: (factor: number, anchorCss: {x: number; y: number}) => void,
): () => void {
  const handleWheel = (event: WheelEvent): void => {
    const rect = canvas.getBoundingClientRect();
    if (!canvas.isConnected || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
    // This listener belongs only to the visible SVG, never the document or Inspector.
    event.preventDefault();
    event.stopPropagation();
    const factor = schematicWheelFactor(event, rect.height);
    if (factor === null || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    zoom(factor, {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    });
  };
  canvas.addEventListener('wheel', handleWheel, {passive: false});
  return () => canvas.removeEventListener('wheel', handleWheel);
}
