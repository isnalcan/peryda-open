import { useEffect, useMemo, type RefObject } from 'react'
import type { YarnCard, YarnColor } from './types'

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
