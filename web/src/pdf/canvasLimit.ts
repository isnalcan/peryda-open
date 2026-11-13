/**
 * One limit for every canvas drawn from a PDF page (page view, page pictures for translation, area
 * crops, library covers). A page can declare an enormous size; without a cap one "Translate page"
 * would ask for a canvas of hundreds of megapixels and could take the tab down.
 */
export const MAX_CANVAS_PIXELS = 16_000_000

/** `scale` lowered just enough that `width` × `height` (in points) draws within MAX_CANVAS_PIXELS. */
export function cappedScale(width: number, height: number, scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return s
  const pixels = width * height * s * s
  return pixels > MAX_CANVAS_PIXELS ? s * Math.sqrt(MAX_CANVAS_PIXELS / pixels) : s
}
