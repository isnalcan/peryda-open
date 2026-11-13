import { clientRectToNormalized, unionRect } from '../ilmek/geometry'
import type { NormalizedRect, PdfYarnAnchor } from '../ilmek/types'
import { newId } from '../data/db'

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** Merges the many small rectangles a browser reports for a selection into one per line. */
export function mergeLineRects(rects: readonly Box[]): Box[] {
  const usable = rects.filter((r) => r.width > 0.5 && r.height > 0.5)
  const sorted = [...usable].sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2) || a.left - b.left)
  const lines: Box[] = []
  for (const r of sorted) {
    const mid = r.top + r.height / 2
    const line = lines.find((l) => Math.abs(l.top + l.height / 2 - mid) < Math.min(l.height, r.height) * 0.6)
    if (line) {
      const left = Math.min(line.left, r.left)
      const top = Math.min(line.top, r.top)
      const right = Math.max(line.right, r.right)
      const bottom = Math.max(line.bottom, r.bottom)
      Object.assign(line, { left, top, right, bottom, width: right - left, height: bottom - top })
    } else {
      lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height })
    }
  }
  return lines
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A range's text with line ends kept as spaces. pdf.js ends each line of its text layer with a <br>,
 * which Range.toString() drops, so words at line ends would run together.
 */
export function rangeText(range: Range): string {
  const fragment = range.cloneContents()
  for (const br of fragment.querySelectorAll('br')) br.replaceWith(' ')
  return normalizeText(fragment.textContent ?? '')
}

export interface PageElement {
  pageNumber: number
  element: HTMLElement
  textLayer: HTMLElement | null
}

/**
 * Turns the current text selection into one anchor per page it touches. Each anchor keeps the text and
 * the line rectangles, normalized to the page so they survive zooming and resizing.
 */
export function anchorsFromSelection(selection: Selection, pages: readonly PageElement[], bookId: string): PdfYarnAnchor[] {
  if (selection.rangeCount === 0 || selection.isCollapsed) return []
  const range = selection.getRangeAt(0)
  const anchors: PdfYarnAnchor[] = []
  for (const page of pages) {
    const layer = page.textLayer
    if (!layer || !range.intersectsNode(layer)) continue
    const clipped = range.cloneRange()
    if (!layer.contains(range.startContainer)) clipped.setStart(layer, 0)
    if (!layer.contains(range.endContainer)) clipped.setEnd(layer, layer.childNodes.length)
    const text = rangeText(clipped)
    if (!text) continue
    const pageBox = page.element.getBoundingClientRect()
    const lineRects: NormalizedRect[] = mergeLineRects([...clipped.getClientRects()])
      .map((r) => clientRectToNormalized(r, pageBox))
      .filter((r) => r.height < 0.25 && r.width > 0)
    if (!lineRects.length) continue
    anchors.push({
      id: newId(),
      sourceType: 'pdf_text',
      bookId,
      pageNumber: page.pageNumber,
      selectedText: text,
      lineRects,
      boundingRect: unionRect(lineRects),
    })
  }
  return anchors
}

/** Screen box around the whole selection, for placing the menu. */
export function selectionScreenRect(selection: Selection) {
  if (selection.rangeCount === 0) return null
  const rects = [...selection.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0)
  if (!rects.length) return null
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  }
}
