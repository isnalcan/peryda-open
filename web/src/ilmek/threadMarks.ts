import { useEffect, useMemo, type RefObject } from 'react'
import type { JournalRecord } from '../data/db'
import { highlightColorOf } from '../reader/highlightColors'
import type { NormalizedRect, PdfYarnAnchor, YarnCard, YarnColor } from './types'

/** A passage inside a card (or a translated page) that a thread was opened from. */
export interface ThreadMark {
  sourceCardId: string
  text: string
  color: YarnColor
  /** Where it was selected, from the card's top, in world units: tells repeated passages apart. */
  nearY: number
}

/**
 * Passages in cards' and translated pages' text that threads were opened from, each in its thread's
 * colour. A removed thread takes its mark along. (Owner test 14 Nov: they were not marked at all.)
 */
export function threadMarks(cards: readonly YarnCard[]): ThreadMark[] {
  return cards.flatMap((card) =>
    card.anchors
      .filter((a) => a.sourceType === 'card' && a.sourceCardId && a.selectedText.trim())
      .map((a) => ({ sourceCardId: a.sourceCardId!, text: a.selectedText, color: card.color, nearY: a.boundingRect.y })),
  )
}

/**
 * Where `needle` is inside `root`, as ranges. Spaces are ignored on both sides: a selection's text
 * joins paragraphs and list items with line breaks the page itself does not hold.
 */
export function findTextRanges(root: Node, needle: string, limit = 20): Range[] {
  const target = needle.replace(/\s+/g, '')
  if (!target) return []
  const doc = root.ownerDocument ?? document
  const chars: { node: Text; offset: number }[] = []
  let flat = ''
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text
    for (let i = 0; i < text.data.length; i++) {
      const ch = text.data[i]!
      if (/\s/.test(ch)) continue
      flat += ch
      chars.push({ node: text, offset: i })
    }
  }
  const ranges: Range[] = []
  let from = 0
  while (ranges.length < limit) {
    const at = flat.indexOf(target, from)
    if (at < 0) break
    const start = chars[at]!
    const end = chars[at + target.length - 1]!
    const range = doc.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset + 1)
    ranges.push(range)
    from = at + target.length
  }
  return ranges
}

/** Of several places, the one nearest where the passage was selected in its card. */
function nearest(ranges: Range[], mark: ThreadMark, card: HTMLElement | null): Range {
  if (ranges.length === 1 || !card) return ranges[0]!
  const box = card.getBoundingClientRect()
  const scale = card.offsetHeight > 0 ? box.height / card.offsetHeight : 1
  const distance = (r: Range) => Math.abs((r.getBoundingClientRect().top - box.top) / (scale || 1) - mark.nearY)
  return ranges.reduce((best, r) => (distance(r) < distance(best) ? r : best))
}

/** The highlight names this module paints with: `yarn-card-<colour>` and `yarn-page-<colour>`. */
const painted = new Set<string>()

/**
 * Marks the passages threads were opened from inside the cards and translated pages under `root`,
 * with the CSS Custom Highlight API (no change to the text itself, so selecting keeps working). The
 * marks follow the text as answers stream in and cards come and go.
 */
export function useThreadMarks(root: RefObject<HTMLElement | null>, cards: readonly YarnCard[]) {
  const marks = useMemo(() => threadMarks(cards), [cards])
  useEffect(() => {
    const el = root.current
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (!el || !registry || typeof Highlight === 'undefined') return
    let frame = 0
    const paint = () => {
      frame = 0
      const byName = new Map<string, Range[]>()
      for (const mark of marks) {
        const sources = el.querySelectorAll<HTMLElement>(`[data-thread-source="${CSS.escape(mark.sourceCardId)}"]`)
        const found: Range[] = []
        for (const source of sources) found.push(...findTextRanges(source, mark.text))
        if (!found.length) continue
        const card = sources[0]!.closest<HTMLElement>('[data-card-id]')
        const where = sources[0]!.closest('.translated-page') ? 'page' : 'card'
        const name = `yarn-${where}-${mark.color}`
        byName.set(name, [...(byName.get(name) ?? []), nearest(found, mark, card)])
      }
      for (const name of painted) {
        if (!byName.has(name)) {
          registry.delete(name)
          painted.delete(name)
        }
      }
      for (const [name, ranges] of byName) {
        registry.set(name, new Highlight(...ranges))
        painted.add(name)
      }
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
      for (const name of painted) registry.delete(name)
      painted.clear()
    }
  }, [root, marks])
}

const paintedUserHighlights = new Set<string>()

function nearestByY(ranges: Range[], nearY: number | undefined, card: HTMLElement | null): Range {
  if (ranges.length === 1 || nearY === undefined || !card) return ranges[0]!
  const box = card.getBoundingClientRect()
  const scale = card.offsetHeight > 0 ? box.height / card.offsetHeight : 1
  const distance = (r: Range) => Math.abs((r.getBoundingClientRect().top - box.top) / (scale || 1) - nearY)
  return ranges.reduce((best, r) => (distance(r) < distance(best) ? r : best))
}

function entryNearY(entry: JournalRecord, card: HTMLElement | null): number | undefined {
  const frac = entry.marks?.[0]?.lineRects?.[0]?.y
  if (frac === undefined) return undefined
  return frac * (card?.offsetHeight || 980)
}

/**
 * Paints the reader's own highlights ("Vurgula") inside translated pages (`entry.cardId` set) using the
 * CSS Custom Highlight API (`user-page-<colour>`), keeping the text freely selectable.
 */
export function useTranslationHighlights(root: RefObject<HTMLElement | null>, entries: readonly JournalRecord[]) {
  const items = useMemo(
    () => entries.filter((e) => e.source === 'highlight' && Boolean(e.cardId) && Boolean(e.quote.trim())),
    [entries],
  )
  useEffect(() => {
    const el = root.current
    if (!el) return
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    let frame = 0
    const paint = () => {
      frame = 0
      const byName = new Map<string, Range[]>()
      const counts = new Map<HTMLElement, number>()
      for (const source of el.querySelectorAll<HTMLElement>('.translated-page [data-thread-source]')) {
        counts.set(source, 0)
      }
      for (const entry of items) {
        const sources = el.querySelectorAll<HTMLElement>(`[data-thread-source="${CSS.escape(entry.cardId!)}"]`)
        const found: Range[] = []
        for (const source of sources) found.push(...findTextRanges(source, entry.quote))
        if (!found.length) continue
        const source = sources[0]!
        counts.set(source, (counts.get(source) ?? 0) + 1)
        const card = source.closest<HTMLElement>('[data-card-id]')
        const range = nearestByY(found, entryNearY(entry, card), card)
        const name = `user-page-${highlightColorOf(entry)}`
        byName.set(name, [...(byName.get(name) ?? []), range])
      }
      for (const [source, count] of counts) {
        if (count > 0) source.dataset.userHighlights = String(count)
        else delete source.dataset.userHighlights
      }
      if (!registry || typeof Highlight === 'undefined') return
      for (const name of paintedUserHighlights) {
        if (!byName.has(name)) {
          registry.delete(name)
          paintedUserHighlights.delete(name)
        }
      }
      for (const [name, ranges] of byName) {
        registry.set(name, new Highlight(...ranges))
        paintedUserHighlights.add(name)
      }
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(paint)
    }
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
      if (registry) {
        for (const name of paintedUserHighlights) registry.delete(name)
      }
      paintedUserHighlights.clear()
    }
  }, [root, items])
}

function rectsOverlap(a: NormalizedRect, b: NormalizedRect): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return overlapX > 0.002 && overlapY > Math.min(a.height, b.height) * 0.35
}

/** Ids of PDF page highlights overlapped by `anchors`. */
export function matchingPdfHighlights(anchors: readonly PdfYarnAnchor[], entries: readonly JournalRecord[]): string[] {
  const pdfAnchors = anchors.filter((a) => a.sourceType === 'pdf_text' && a.lineRects.length)
  if (!pdfAnchors.length) return []
  const matched: string[] = []
  for (const entry of entries) {
    if (entry.source !== 'highlight' || entry.cardId || !entry.marks?.length) continue
    const hits = entry.marks.some((mark) =>
      pdfAnchors.some((a) => a.pageNumber === mark.pageNumber && a.lineRects.some((ar) => mark.lineRects.some((mr) => rectsOverlap(ar, mr)))),
    )
    if (hits) matched.push(entry.id)
  }
  return matched
}

/** Ids of translated-page highlights overlapped by `selectionRange` (or `selectedText`) inside `sourceEl`. */
export function matchingTranslationHighlights(
  sourceEl: HTMLElement,
  cardEl: HTMLElement | null,
  selectionRange: Range | null,
  selectedText: string,
  cardId: string,
  entries: readonly JournalRecord[],
): string[] {
  const compactSel = selectedText.replace(/\s+/g, '')
  if (!compactSel) return []
  const matched: string[] = []
  for (const entry of entries) {
    if (entry.source !== 'highlight' || entry.cardId !== cardId || !entry.quote.trim()) continue
    // Only highlights painted on the page right now can be offered for removal: one whose quote is no
    // longer in the text (say, after a re-translation) is invisible, so it is never matched.
    const found = findTextRanges(sourceEl, entry.quote)
    if (found.length && selectionRange) {
      const target = nearestByY(found, entryNearY(entry, cardEl), cardEl)
      try {
        if (
          selectionRange.compareBoundaryPoints(Range.END_TO_START, target) < 0 &&
          selectionRange.compareBoundaryPoints(Range.START_TO_END, target) > 0
        ) {
          matched.push(entry.id)
          continue
        }
      } catch {
        /* disconnected or cross-document range */
      }
    }
  }
  return matched
}

/**
 * Finds a child thread whose marked passage inside `sourceEl` (a card or translated page) contains
 * `(clientX, clientY)`, preferring folded (`collapsed`) threads so clicking a highlighted phrase opens it.
 */
export function findCardThreadAtPoint(
  sourceEl: HTMLElement,
  cardEl: HTMLElement | null,
  clientX: number,
  clientY: number,
  sourceCardId: string,
  cards: readonly YarnCard[],
): string | null {
  const candidates: { id: string; collapsed: boolean }[] = []
  for (const child of cards) {
    for (const a of child.anchors) {
      if (a.sourceType !== 'card' || a.sourceCardId !== sourceCardId || !a.selectedText.trim()) continue
      const found = findTextRanges(sourceEl, a.selectedText)
      if (!found.length) continue
      const target = nearestByY(found, a.boundingRect.y, cardEl)
      const rects = Array.from(target.getClientRects())
      const hit = rects.some((r) => clientX >= r.left - 2 && clientX <= r.right + 2 && clientY >= r.top - 2 && clientY <= r.bottom + 2)
      if (hit) candidates.push({ id: child.id, collapsed: child.collapsed })
    }
  }
  if (!candidates.length) return null
  return (candidates.find((c) => c.collapsed) ?? candidates[candidates.length - 1]!).id
}
