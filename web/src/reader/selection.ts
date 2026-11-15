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

/** A letter or digit, or an apostrophe or hyphen inside a word. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’\-]/u

/**
 * The range widened to whole words at both ends, so a highlight never starts or ends mid-word
 * (owner test 15 Nov: "r. Bu çaba … bırakm"). pdf.js often splits one word over several spans
 * ("YAVA" + "Ş"), so the text nodes under `root` are read in order as one stream. A range that already
 * starts and ends on word boundaries comes back unchanged.
 */
export function expandToWords(range: Range, root: Node = range.commonAncestorContainer): Range {
  const out = range.cloneRange()
  const isWord = (c: string | undefined) => c !== undefined && WORD_CHAR.test(c)
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode ?? root : root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  /** The character just before / at a position, across node boundaries. */
  const charBefore = (k: number, offset: number): [number, number] | null => {
    for (let i = k, o = offset; i >= 0; i--, o = nodes[i]?.length ?? 0) if (o > 0) return [i, o - 1]
    return null
  }
  const charAt = (k: number, offset: number): [number, number] | null => {
    for (let i = k, o = offset; i < nodes.length; i++, o = 0) if (o < nodes[i]!.length) return [i, o]
    return null
  }
  const ch = (p: [number, number] | null) => (p ? nodes[p[0]]!.data[p[1]] : undefined)

  const si = nodes.indexOf(out.startContainer as Text)
  if (si >= 0 && isWord(ch(charAt(si, out.startOffset))) && isWord(ch(charBefore(si, out.startOffset)))) {
    let k = si
    let o = out.startOffset
    for (let p = charBefore(k, o); p && isWord(ch(p)); p = charBefore(k, o)) [k, o] = p
    out.setStart(nodes[k]!, o)
  }
  const ei = nodes.indexOf(out.endContainer as Text)
  if (ei >= 0 && isWord(ch(charBefore(ei, out.endOffset))) && isWord(ch(charAt(ei, out.endOffset)))) {
    let k = ei
    let o = out.endOffset
    for (let p = charAt(k, o); p && isWord(ch(p)); p = charAt(k, o)) [k, o] = [p[0], p[1] + 1]
    out.setEnd(nodes[k]!, o)
  }
  return out
}
