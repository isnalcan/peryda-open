import type { NormalizedRect } from '../ilmek/types'
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy } from '../pdf/pdfjs'

/**
 * Find in the document (Ctrl/Cmd+F, owner 16 Nov). Matching ignores case and accents the way a reader
 * expects in Turkish and the other languages: lower case, accents and other marks removed (Unicode
 * compatibility decomposition, so ligatures such as "ﬁ" read as "fi"), and İ, I, ı and i are one letter.
 * Any run of white space (spaces, line breaks, tabs) is one space, in the page and in the query; the query
 * is trimmed; matches never overlap. The Mac app follows the same rules.
 */

/** A text folded for matching, with each folded code unit's place in the original text. */
export interface Folded {
  text: string
  /** Start (inclusive) and end (exclusive) in the original text of each folded code unit. */
  from: number[]
  to: number[]
}

function foldChar(ch: string): string {
  if (ch === 'İ' || ch === 'I' || ch === 'ı' || ch === 'i') return 'i'
  return ch.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
}

const SPACE = /\s/u

export function fold(input: string): Folded {
  let text = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  let lastSpace = false
  for (const ch of input) {
    const start = at
    at += ch.length
    if (SPACE.test(ch)) {
      if (lastSpace) {
        to[to.length - 1] = at
        continue
      }
      text += ' '
      from.push(start)
      to.push(at)
      lastSpace = true
      continue
    }
    lastSpace = false
    const folded = foldChar(ch)
    for (let k = 0; k < folded.length; k += 1) {
      text += folded[k]
      from.push(start)
      to.push(at)
    }
  }
  return { text, from, to }
}

/** The query as matched: folded and trimmed; empty means nothing is looked for. */
export function foldQuery(query: string): string {
  return fold(query.trim()).text.trim()
}

/** Every match of a folded query in a text, as [start, end) in the original text, in order. */
/**
 * The most matches a search keeps (audit 16 Nov, W16-1): a one-letter query in a long book would
 * otherwise find hundreds of thousands and stall the tab. The counter then reads "… / 5000+".
 * The Mac keeps the same limit (DocumentFind.maxHits).
 */
export const MAX_FIND_HITS = 5000

/** The longest query searched for: a longer one is cut (the Mac keeps the same limit). */
export const MAX_FIND_QUERY = 500

export function findInText(haystack: Folded | string, query: string, limit = MAX_FIND_HITS): [number, number][] {
  const hay = typeof haystack === 'string' ? fold(haystack) : haystack
  const q = foldQuery(query.slice(0, MAX_FIND_QUERY))
  const out: [number, number][] = []
  if (!q) return out
  let from = 0
  while (out.length < limit) {
    const k = hay.text.indexOf(q, from)
    if (k === -1) break
    out.push([hay.from[k]!, hay.to[k + q.length - 1]!])
    from = k + q.length
  }
  return out
}

/** A piece of a page's text and where it is drawn (fractions of the page). */
export interface TextRun {
  start: number
  end: number
  left: number
  top: number
  width: number
  height: number
}

/** A page's text in reading order and the runs it is made of. */
export interface PageText {
  text: string
  runs: TextRun[]
  folded: Folded
}

interface ItemLike {
  str: string
  transform: number[]
  width: number
  hasEOL?: boolean
}

/**
 * Joins a page's text items. Items on one line that touch are joined as they are (pdf.js often splits a
 * word); a gap wider than a fifth of the font size, a new line or an end-of-line mark is a space.
 */
export function pageTextFrom(items: readonly ItemLike[], viewport: { width: number; height: number; transform: number[] }): PageText {
  let text = ''
  const runs: TextRun[] = []
  let prev: { right: number; baseline: number; size: number } | null = null
  let pendingBreak = false
  for (const item of items) {
    const str = item.str
    if (!str) {
      if (item.hasEOL) pendingBreak = true
      continue
    }
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = pdfjs.Util.transform(viewport.transform, item.transform) as number[]
    const size = Math.hypot(c, d) || 1
    const scale = Math.hypot(a, b) / (Math.hypot(item.transform[0] ?? 1, item.transform[1] ?? 0) || 1)
    const width = item.width * (Number.isFinite(scale) && scale > 0 ? scale : 1)
    if (text && !SPACE.test(text[text.length - 1]!)) {
      const sameLine = prev !== null && Math.abs(f - prev.baseline) < Math.max(size, prev.size) * 0.5
      if (pendingBreak || !sameLine || (prev !== null && e - prev.right > Math.max(size, prev.size) * 0.2)) text += ' '
    }
    pendingBreak = false
    const start = text.length
    text += str
    runs.push({ start, end: text.length, left: e / viewport.width, top: (f - size) / viewport.height, width: width / viewport.width, height: size / viewport.height })
    prev = { right: e + width, baseline: f, size }
    if (item.hasEOL) pendingBreak = true
  }
  return { text, runs, folded: fold(text) }
}

export async function pageTextOf(page: PDFPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 })
  // A page with no usable size has nothing to find on it (audit 16 Nov, M16-1).
  if (!(viewport.width >= 1 && viewport.height >= 1)) return { text: '', runs: [], folded: fold('') }
  const content = await page.getTextContent()
  const items = content.items.filter((i): i is ItemLike & (typeof content.items)[number] => 'str' in i)
  return pageTextFrom(items, viewport)
}

/** The page rectangles a match covers: the matched part of each run, by its share of the run's characters. */
export function rectsFor(page: PageText, start: number, end: number): NormalizedRect[] {
  const out: NormalizedRect[] = []
  for (const run of page.runs) {
    if (run.end <= start || run.start >= end) continue
    const len = run.end - run.start
    const a = (Math.max(start, run.start) - run.start) / len
    const b = (Math.min(end, run.end) - run.start) / len
    out.push({ x: run.left + run.width * a, y: run.top, width: run.width * (b - a), height: run.height })
  }
  return out
}

/** One match: its page, and the rectangles to tint. */
export interface FindHit {
  page: number
  rects: NormalizedRect[]
}

export function hitsOnPage(page: PageText, pageNumber: number, query: string, limit = MAX_FIND_HITS): FindHit[] {
  return findInText(page.folded, query, limit)
    .map(([s, e]) => ({ page: pageNumber, rects: rectsFor(page, s, e) }))
    .filter((h) => h.rects.length > 0)
}

/**
 * Looks through the whole document, page by page, handing over each page's matches as it goes so the
 * counter fills in while a long book is searched. Pages' text is kept in `cache` for the next search.
 */
export async function searchDocument(
  doc: PDFDocumentProxy,
  query: string,
  options: { signal: AbortSignal; cache: Map<number, PageText>; onHits: (hits: FindHit[]) => void },
): Promise<boolean> {
  if (!foldQuery(query)) return false
  let found = 0
  for (let n = 1; n <= doc.numPages; n += 1) {
    if (options.signal.aborted) return false
    let text = options.cache.get(n)
    if (!text) {
      try {
        text = await pageTextOf(await doc.getPage(n))
      } catch {
        continue
      }
      options.cache.set(n, text)
      if (options.signal.aborted) return false
    } else if (n % 25 === 0) {
      // Cached pages are quick; still let the window breathe now and then.
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      if (options.signal.aborted) return false
    }
    const hits = hitsOnPage(text, n, query, MAX_FIND_HITS - found)
    found += hits.length
    if (hits.length) options.onHits(hits)
    // Enough: the reader narrows the query rather than paging through thousands.
    if (found >= MAX_FIND_HITS) return true
  }
  return false
}
