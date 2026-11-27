import { kindTitle } from '../ai/compose'
import type { Lang } from '../i18n/strings'
import { GEOMETRY, anchorWorldPoint, laneX, pageWidthOf, remapPinned } from './geometry'
import { layoutCards, type CardForLayout, type CardPlacement } from './lane'
import type { PageBox, Point, YarnCard, YarnColor } from './types'
import type { YarnSegment } from './YarnLayer'

/**
 * Where everything sits on the reading surface: threads, page translations, knots and yarns. Same rules
 * as the Mac app's ReaderModel (mac/PerydaMac/Reader/ReaderModel.swift), kept free of React so it can
 * be tested.
 */

export const DEFAULT_CARD_HEIGHT = 150
/** Free room beyond the outermost page, thread or translation: somewhere to move threads to. */
export const ROOM_AROUND = 1100
export const ROOM_BELOW = 600
/** A page translation sits this far right of the threads beside its page (or of the page). */
export const TRANSLATION_GAP = 60

export interface WorldInput {
  cards: readonly YarnCard[]
  pages: readonly PageBox[]
  /** Measured card heights in world units. */
  heights: Readonly<Record<string, number>>
  /** One page at a time instead of one long scroll. */
  pagedReading: boolean
  currentPage: number
  /** The eye button: threads hidden, except those opened again from their highlight. */
  hideThreads: boolean
  revealed: ReadonlySet<string>
}

const heightOf = (input: WorldInput, id: string) => input.heights[id] ?? DEFAULT_CARD_HEIGHT

function byIdOf(cards: readonly YarnCard[]) {
  return new Map(cards.map((c) => [c.id, c]))
}

/** The card a thread was opened from: its parent, or the card its anchor sits in. */
function sourceOf(card: YarnCard, byId: Map<string, YarnCard>): YarnCard | undefined {
  if (card.parentCardId && byId.has(card.parentCardId)) return byId.get(card.parentCardId)
  const sid = card.anchors.find((a) => a.sourceCardId)?.sourceCardId
  return sid ? byId.get(sid) : undefined
}

/** The page a card belongs to: its first page anchor, or for a thread opened inside a card, that card's page. */
export function homePage(card: YarnCard, byId: Map<string, YarnCard>): number {
  const seen = new Set<string>()
  let current: YarnCard | undefined = card
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.translatedPage !== undefined) return current.translatedPage
    const pages = current.anchors.filter((a) => a.sourceType !== 'card' && a.pageNumber >= 1).map((a) => a.pageNumber)
    if (pages.length) return Math.min(...pages)
    current = sourceOf(current, byId)
  }
  return 1
}

/** Cards shown now: all, or in page-by-page reading only the current page's; hidden threads stay hidden. */
export function isShown(card: YarnCard, input: WorldInput, byId?: Map<string, YarnCard>): boolean {
  // A page translation is not a thread: the eye button leaves it.
  if (input.hideThreads && !input.revealed.has(card.id) && card.translatedPage === undefined) return false
  return !input.pagedReading || homePage(card, byId ?? byIdOf(input.cards)) === input.currentPage
}

/** Folded itself, or under a folded thread at any depth. */
function folded(card: YarnCard, byId: Map<string, YarnCard>): boolean {
  const seen = new Set<string>()
  let current: YarnCard | undefined = card
  while (current && !seen.has(current.id)) {
    if (current.collapsed) return true
    seen.add(current.id)
    current = current.parentCardId ? byId.get(current.parentCardId) : undefined
  }
  return false
}

/** A page translation, or a thread opened inside one. */
function fromTranslation(card: YarnCard, byId: Map<string, YarnCard>): boolean {
  const seen = new Set<string>()
  let current: YarnCard | undefined = card
  while (current && !seen.has(current.id)) {
    if (current.translatedPage !== undefined) return true
    seen.add(current.id)
    current = sourceOf(current, byId)
  }
  return false
}

function samePlacements(a: Map<string, CardPlacement>, b: Map<string, CardPlacement>): boolean {
  if (a.size !== b.size) return false
  for (const [id, p] of a) {
    const q = b.get(id)
    if (!q || Math.abs(q.x - p.x) > 0.01 || Math.abs(q.y - p.y) > 0.01) return false
  }
  return true
}

/**
 * Places every unfolded card. A thread opened inside a card sits level with its parent, which must be
 * placed first; each round places one more generation, so it repeats until nothing moves (deep chains
 * included). Page translations sit level with their page, right of the threads beside it.
 */
export function placeCards(input: WorldInput): Map<string, CardPlacement> {
  const { cards, pages } = input
  const byId = byIdOf(cards)
  const anchorY = (card: YarnCard, placed: Map<string, CardPlacement>): number => {
    const ys: number[] = []
    for (const a of card.anchors) {
      if (a.sourceType === 'card') {
        const p = a.sourceCardId ? placed.get(a.sourceCardId) : undefined
        if (p) ys.push(p.y + a.boundingRect.y + a.boundingRect.height / 2)
      } else {
        const page = pages[a.pageNumber - 1]
        if (page) ys.push(anchorWorldPoint(a.boundingRect, page)[1])
      }
    }
    return ys.length ? Math.min(...ys) : 0
  }
  const translationOrigin = (t: YarnCard, placed: Map<string, CardPlacement>): CardPlacement => {
    const page = t.translatedPage !== undefined ? pages[t.translatedPage - 1] : undefined
    if (!page) return { x: t.x, y: t.y }
    let right = page.x + page.width
    for (const c of cards) {
      if (fromTranslation(c, byId) || !isShown(c, input, byId)) continue
      const p = placed.get(c.id)
      if (!p) continue
      if (p.y < page.y + page.height && p.y + heightOf(input, c.id) > page.y) right = Math.max(right, p.x + c.width)
    }
    return { x: right + TRANSLATION_GAP, y: page.y }
  }

  const pageOf = new Map(cards.map((c) => [c.id, homePage(c, byId)]))
  const pw = pageWidthOf(pages)
  // The lane follows the pages' right edge (the reader can resize the pages); crowded pages overflow left.
  const lane = laneX(pw)
  let placed = new Map<string, CardPlacement>()
  for (let round = 0; round < 32; round += 1) {
    const previous = placed
    const items: CardForLayout[] = cards.map((c) => {
      const origin = c.translatedPage !== undefined ? translationOrigin(c, previous) : null
      return {
        id: c.id,
        parentCardId: c.parentCardId && byId.has(c.parentCardId) ? c.parentCardId : undefined,
        isPinned: Boolean(origin) || c.isPinned,
        collapsed: folded(c, byId),
        x: origin?.x ?? c.x,
        y: origin?.y ?? c.y,
        width: c.width,
        anchorY: anchorY(c, previous),
        height: heightOf(input, c.id),
        page: pageOf.get(c.id),
        createdAt: c.createdAt,
      }
    })
    if (input.pagedReading) {
      // Each page lays out its own threads, so another page's stack never pushes them down.
      const groups = new Map<number, CardForLayout[]>()
      for (const item of items) {
        const page = pageOf.get(item.id) ?? 1
        groups.set(page, [...(groups.get(page) ?? []), item])
      }
      const merged = new Map<string, CardPlacement>()
      for (const group of groups.values()) for (const [id, p] of layoutCards(group, lane, { pageWidth: pw })) merged.set(id, p)
      placed = merged
    } else {
      placed = layoutCards(items, lane, { pageWidth: pw })
    }
    if (samePlacements(placed, previous)) break
  }
  return placed
}

export interface ContentRect {
  minX: number
  maxX: number
  maxY: number
  /** The pages' world width (pageWorldWidth when not given): the world stays centred on the pages. */
  pageWidth?: number
}

/** Where things are: the pages, the default lane, and every placed thread and translation. */
export function contentRect(input: WorldInput, placements: Map<string, CardPlacement>): ContentRect {
  const pageWidth = pageWidthOf(input.pages)
  let minX = 0
  let maxX = laneX(pageWidth) + GEOMETRY.cardWidth
  const last = input.pages[input.pages.length - 1]
  let maxY = last ? last.y + last.height : 0
  const byId = byIdOf(input.cards)
  for (const [id, p] of placements) {
    const w = byId.get(id)?.width ?? GEOMETRY.cardWidth
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x + w)
    maxY = Math.max(maxY, p.y + heightOf(input, id))
  }
  return { minX, maxX, maxY, pageWidth }
}

/** The content's width when kept centred on the page (what the camera fits). */
export function centredContentWidth(c: ContentRect): number {
  const mid = (c.pageWidth ?? GEOMETRY.pageWorldWidth) / 2
  return 2 * Math.max(c.maxX - mid, mid - c.minX) + 80
}

/** The world's extent: the content plus generous room on both sides, symmetric around the page's centre. */
export function worldRect(c: ContentRect): { x: number; y: number; width: number; height: number } {
  const mid = (c.pageWidth ?? GEOMETRY.pageWorldWidth) / 2
  const half = Math.max(c.maxX - mid, mid - c.minX) + ROOM_AROUND
  return { x: mid - half, y: 0, width: half * 2, height: c.maxY + ROOM_BELOW }
}

/** A folded thread opened inside a card: a knot tied through that card's edge, on the side the thread was on. */
export interface Clip {
  cardId: string
  color: YarnColor
  title: string
  right: boolean
  point: Point
}

export function clipsFor(input: WorldInput, placements: Map<string, CardPlacement>, lang: Lang): Clip[] {
  const byId = byIdOf(input.cards)
  const pageMid = pageWidthOf(input.pages) / 2
  const out: Clip[] = []
  for (const card of input.cards) {
    if (!card.collapsed) continue
    const anchor = card.anchors.find((a) => a.sourceType === 'card')
    const parent = anchor?.sourceCardId ? byId.get(anchor.sourceCardId) : undefined
    const pp = parent ? placements.get(parent.id) : undefined
    if (!anchor || !parent || !pp || !isShown(parent, input, byId)) continue
    const parentMid = pp.x + parent.width / 2
    const right = card.isPinned ? card.x + card.width / 2 >= parentMid : parentMid >= pageMid
    const parentH = heightOf(input, parent.id)
    const rawY = pp.y + anchor.boundingRect.y + anchor.boundingRect.height / 2
    const y = Math.min(Math.max(rawY, pp.y + 46), pp.y + Math.max(52, parentH - 28))
    out.push({ cardId: card.id, color: card.color, title: kindTitle(lang, card), right, point: [right ? pp.x + parent.width : pp.x, y] })
  }
  // Knots on the same edge never overlap.
  out.sort((a, b) => a.point[1] - b.point[1])
  const lastY = new Map<number, number>()
  for (const clip of out) {
    const last = lastY.get(clip.point[0])
    if (last !== undefined && clip.point[1] < last + 30) clip.point = [clip.point[0], last + 30]
    lastY.set(clip.point[0], clip.point[1])
  }
  return out
}

/**
 * Yarns from passages (or text inside a card) to the cards shown. A card moved to the left of the page
 * (or left of its parent card) takes its yarn on its right edge, from the source's left end; otherwise
 * left edge, right end.
 */
export function yarnSegments(input: WorldInput, placements: ReadonlyMap<string, CardPlacement>): YarnSegment[] {
  const byId = byIdOf(input.cards)
  const out: YarnSegment[] = []
  const pageMid = pageWidthOf(input.pages) / 2
  for (const card of input.cards) {
    if (card.translatedPage !== undefined || !isShown(card, input, byId)) continue
    const p = placements.get(card.id)
    if (!p) continue
    const cardMid = p.x + card.width / 2
    for (const a of card.anchors) {
      let from: Point | null = null
      let onLeft = cardMid < pageMid
      if (a.sourceType === 'card') {
        const parent = a.sourceCardId ? byId.get(a.sourceCardId) : undefined
        const pp = a.sourceCardId ? placements.get(a.sourceCardId) : undefined
        if (parent && pp && isShown(parent, input, byId)) {
          onLeft = cardMid < pp.x + parent.width / 2
          const parentH = heightOf(input, parent.id)
          const rawY = pp.y + a.boundingRect.y + a.boundingRect.height / 2
          const attachY = Math.min(Math.max(rawY, pp.y + 46), pp.y + Math.max(52, parentH - 28))
          from = [onLeft ? pp.x : pp.x + parent.width, attachY]
        }
      } else {
        const page = input.pages[a.pageNumber - 1]
        if (page) {
          from = onLeft
            ? [page.x + a.boundingRect.x * page.width, page.y + (a.boundingRect.y + a.boundingRect.height / 2) * page.height]
            : anchorWorldPoint(a.boundingRect, page)
        }
      }
      if (from) {
        const to: Point = onLeft ? [p.x + card.width, p.y + GEOMETRY.cardAttachY] : [p.x, p.y + GEOMETRY.cardAttachY]
        out.push({ key: `${card.id}-${a.id}`, color: card.color, from, to, cardId: card.id, sourceCardId: a.sourceCardId })
      }
    }
  }
  return out
}

/** The current page plus any of its threads that reach above or below it, with a margin (page-by-page reading). */
export function pageBand(input: WorldInput, placements: ReadonlyMap<string, CardPlacement>, page: number): { top: number; bottom: number } | null {
  const box = input.pages[page - 1]
  if (!box) return null
  let top = box.y
  let bottom = box.y + box.height
  const byId = byIdOf(input.cards)
  for (const card of input.cards) {
    const p = placements.get(card.id)
    if (!p || !isShown(card, input, byId)) continue
    top = Math.min(top, p.y)
    bottom = Math.max(bottom, p.y + heightOf(input, card.id))
  }
  return { top: top - 32, bottom: bottom + 32 }
}

/**
 * The cards as the surface lays them out and draws them: a page translation is the size of its page now
 * (the reader can resize the pages; the stored card keeps the size it was made at), and while the pages
 * are being resized, the cards the reader placed follow them (`moved`). Unchanged cards keep their
 * identity, so cards that did not change are not drawn again.
 */
export function cardsForSurface(cards: readonly YarnCard[], pages: readonly PageBox[], moved?: ReadonlyMap<string, CardPlacement>): YarnCard[] {
  return cards.map((c) => {
    if (c.translatedPage !== undefined) {
      const page = pages[c.translatedPage - 1]
      if (page && (c.width !== page.width || c.height !== page.height)) return { ...c, width: page.width, height: page.height }
      return c
    }
    const m = moved?.get(c.id)
    return m && (m.x !== c.x || m.y !== c.y) ? { ...c, x: m.x, y: m.y } : c
  })
}

/** Cards the reader placed (not page translations): where they go when the pages change from `from` to `to`. */
export function pinnedAfterResize(cards: readonly YarnCard[], from: readonly PageBox[], to: readonly PageBox[]): Map<string, CardPlacement> {
  const out = new Map<string, CardPlacement>()
  for (const c of cards) {
    if (!c.isPinned || c.translatedPage !== undefined) continue
    const [x, y] = remapPinned([c.x, c.y], from, to)
    out.set(c.id, { x, y })
  }
  return out
}
