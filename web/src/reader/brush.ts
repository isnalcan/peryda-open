/**
 * The İlmek brush's hit-testing: where on the page's text the pointer is, and how far it has been pulled
 * past the painted words. Kept apart from the reader so it can be tested.
 */

export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const p = d.caretPositionFromPoint?.(x, y)
  if (p) return { node: p.offsetNode, offset: p.offset }
  const r = d.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

/** Whether a point lies on a line of text (its box, with a pixel or two of slack). */
export function pointOnText(box: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x >= box.left - 2 && x <= box.right + 2 && y >= box.top - 2 && y <= box.bottom + 2
}

/**
 * The caret under the pointer, but only on text of `layer`. When the pointer is beside a line rather than
 * on it, the line is looked for along the same row: leftward while painting (past the end of a line the
 * caret is that line's end, so pulling right keeps the painted words) and also rightward when a stroke
 * starts (a stroke begun in the margin starts at the line's first word). A caret the browser snaps to
 * elsewhere (from empty space it often gives the page's first line) is refused: it made a stroke past
 * the text, or one begun in the margin, select the whole page and never become a thread (owner test
 * 15 Nov).
 */
export function brushCaretAt(x: number, y: number, layer: Element, starting = false): { node: Node; offset: number } | null {
  const steps: number[] = [0]
  for (let d = 16; d <= 480; d += 16) {
    steps.push(-d)
    if (starting) steps.push(d)
  }
  for (const dx of steps) {
    const px = x + dx
    const caret = caretAt(px, y)
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !layer.contains(caret.node)) continue
    const box = caret.node.parentElement?.getBoundingClientRect()
    if (!box || !pointOnText(box, px, y)) continue
    if (dx === 0) return caret
    // Found to the left: that span's end, where the line stops. To the right: its start.
    return { node: caret.node, offset: dx < 0 ? (caret.node.textContent?.length ?? caret.offset) : 0 }
  }
  return null
}

/** The right edge of a painted range's last line: the pull to make a thread is measured from there. */
export function lastLineRight(rects: readonly { right: number; bottom: number; width: number }[]): number | null {
  const lines = rects.filter((r) => r.width > 0)
  if (!lines.length) return null
  const lastBottom = Math.max(...lines.map((r) => r.bottom))
  return Math.max(...lines.filter((r) => Math.abs(r.bottom - lastBottom) < 4).map((r) => r.right))
}
