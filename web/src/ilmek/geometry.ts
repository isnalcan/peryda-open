import tokens from '@shared/tokens.json'
import type { NormalizedRect, PageBox, Point } from './types'

export const GEOMETRY = tokens.geometry

/** Control points of the yarn curve from the anchor (x1, y1) to the card (x2, y2). */
export function bezierControls(x1: number, y1: number, x2: number, y2: number): { c1: Point; c2: Point } {
  const span = Math.max(GEOMETRY.bezierMinSpan, Math.abs(x2 - x1) * GEOMETRY.bezierSpanRatio)
  return { c1: [x1 + span, y1], c2: [x2 - span, y2] }
}

export function bezierPath(from: Point, to: Point): string {
  const { c1, c2 } = bezierControls(from[0], from[1], to[0], to[1])
  const f = (n: number) => Number(n.toFixed(2))
  return `M ${f(from[0])} ${f(from[1])} C ${f(c1[0])} ${f(c1[1])}, ${f(c2[0])} ${f(c2[1])}, ${f(to[0])} ${f(to[1])}`
}

/**
 * Pages stack vertically at one world width (the reader's page size: pageWorldWidth times the book's
 * page scale); sizes are the page boxes in points.
 */
/**
 * A page size layout can use: a page with no size (or not a number) is drawn as a letter page, and a
 * long strip is kept to at most 20 times as long as wide, or as wide as long (audit 16 Nov, M16-1:
 * an empty MediaBox divided zero by zero). Matches make-vectors.py.
 */
export function usablePageSize(w: number, h: number): [number, number] {
  if (!(Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1)) return [612, 792]
  return [w, w * Math.min(Math.max(h / w, 0.05), 20)]
}

export function pageLayout(sizes: ReadonlyArray<readonly [number, number]>, width: number = GEOMETRY.pageWorldWidth): PageBox[] {
  let y = 0
  return sizes.map(([rawW, rawH]) => {
    const [w, h] = usablePageSize(rawW, rawH)
    const height = width * (h / w)
    const box = { x: 0, y, width, height }
    y += height + GEOMETRY.pageGap
    return box
  })
}

/** The page scale kept within its limits (the pages are resized from a page's corner). */
export function clampPageScale(s: number): number {
  return Math.min(Math.max(s, GEOMETRY.pageScaleMin), GEOMETRY.pageScaleMax)
}

/** The world width of the pages at a page scale. */
export function pageWidthAt(scale: number): number {
  return GEOMETRY.pageWorldWidth * scale
}

/** The pages' world width (pageWorldWidth when there are none). */
export function pageWidthOf(pages: readonly PageBox[]): number {
  return pages[0]?.width ?? GEOMETRY.pageWorldWidth
}

/** The lane right of pages this wide. */
export function laneX(pageWidth: number): number {
  return pageWidth + GEOMETRY.laneOffset
}

/**
 * Where a card the reader placed goes when the pages are resized, so it stays by its passage.
 * x: right of the pages it moves with their right edge, left of them it stays, over them it scales.
 * y: on a page it keeps its place within that page; in the gap below a page it moves with that page's
 * bottom; above the first page it stays. (Same rule as shared/tools/make-vectors.py and the Mac app.)
 */
export function remapPinned(point: Point, oldPages: readonly PageBox[], newPages: readonly PageBox[]): Point {
  const [x, y] = point
  if (!oldPages.length || !newPages.length || oldPages.length !== newPages.length) return [x, y]
  const oldW = oldPages[0]!.width
  const newW = newPages[0]!.width
  const nx = x >= oldW ? x + (newW - oldW) : x <= 0 ? x : (x * newW) / oldW
  let index = -1
  for (let i = 0; i < oldPages.length; i += 1) {
    if (oldPages[i]!.y <= y) index = i
    else break
  }
  if (index === -1) return [nx, y]
  const o = oldPages[index]!
  const n = newPages[index]!
  const ny = y <= o.y + o.height ? n.y + ((y - o.y) * n.height) / o.height : y + (n.y + n.height) - (o.y + o.height)
  return [nx, ny]
}

export function worldHeight(pages: readonly PageBox[]): number {
  const last = pages[pages.length - 1]
  return last ? last.y + last.height : 0
}

/** Where a yarn starts: the middle of the right edge of the anchor's bounding rectangle. */
export function anchorWorldPoint(rect: NormalizedRect, page: PageBox): Point {
  return [page.x + (rect.x + rect.width) * page.width, page.y + (rect.y + rect.height / 2) * page.height]
}

/** Where a yarn ends: the card's left edge, a fixed distance below its top. */
export function cardAttachPoint(card: { x: number; y: number }): Point {
  return [card.x, card.y + GEOMETRY.cardAttachY]
}

export const LANE_X = laneX(GEOMETRY.pageWorldWidth)

export function subLaneX(parent: { x: number; width: number }): number {
  return parent.x + parent.width + GEOMETRY.subLaneGap
}

/** PDF points with a bottom-left origin (as PDFKit and pdf.js user space report them) to normalized. */
export function pdfToNormalized(
  bounds: readonly [number, number, number, number],
  rect: readonly [number, number, number, number],
): NormalizedRect {
  const [bx, by, bw, bh] = bounds
  const [rx, ry, rw, rh] = rect
  return { x: (rx - bx) / bw, y: (by + bh - (ry + rh)) / bh, width: rw / bw, height: rh / bh }
}

export function normalizedToPdf(
  bounds: readonly [number, number, number, number],
  n: NormalizedRect,
): [number, number, number, number] {
  const [bx, by, bw, bh] = bounds
  return [bx + n.x * bw, by + (1 - (n.y + n.height)) * bh, n.width * bw, n.height * bh]
}

/** Normalizes a rectangle measured in the same pixel space as the rendered page element. */
export function clientRectToNormalized(
  rect: { left: number; top: number; width: number; height: number },
  page: { left: number; top: number; width: number; height: number },
): NormalizedRect {
  return {
    x: (rect.left - page.left) / page.width,
    y: (rect.top - page.top) / page.height,
    width: rect.width / page.width,
    height: rect.height / page.height,
  }
}

export function unionRect(rects: readonly NormalizedRect[]): NormalizedRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function clampRect(r: NormalizedRect): NormalizedRect {
  const x = Math.min(Math.max(r.x, 0), 1)
  const y = Math.min(Math.max(r.y, 0), 1)
  return { x, y, width: Math.min(Math.max(r.width, 0), 1 - x), height: Math.min(Math.max(r.height, 0), 1 - y) }
}

/** A rectangle drawn in any direction, as two corners, to a normalized rectangle. */
export function rectFromCorners(a: Point, b: Point): NormalizedRect {
  return clampRect({
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(b[0] - a[0]),
    height: Math.abs(b[1] - a[1]),
  })
}

/** Tiny boxes are treated as stray clicks, not area selections. */
export function areaAccepted(n: NormalizedRect): boolean {
  return !(n.width < GEOMETRY.areaMinWidth || n.height < GEOMETRY.areaMinHeight)
}

/** Pixel crop of a rendered page canvas for an area selection. */
export function cropPixels(canvasWidth: number, canvasHeight: number, n: NormalizedRect) {
  return {
    sx: Math.round(n.x * canvasWidth),
    sy: Math.round(n.y * canvasHeight),
    sw: Math.max(1, Math.round(n.width * canvasWidth)),
    sh: Math.max(1, Math.round(n.height * canvasHeight)),
  }
}

/** Zooms around the cursor: the world point under the cursor stays where it is. */
export function zoomAt(pan: Point, scale: number, cursor: Point, nextScale: number): { world: Point; pan: Point } {
  const world: Point = [(cursor[0] - pan[0]) / scale, (cursor[1] - pan[1]) / scale]
  return { world, pan: [cursor[0] - world[0] * nextScale, cursor[1] - world[1] * nextScale] }
}

export function screenToWorld(point: Point, pan: Point, scale: number): Point {
  return [(point[0] - pan[0]) / scale, (point[1] - pan[1]) / scale]
}
