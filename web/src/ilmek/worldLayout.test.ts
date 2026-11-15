import { describe, expect, it } from 'vitest'
import { GEOMETRY, LANE_X, laneX, pageLayout, remapPinned, subLaneX } from './geometry'
import type { PdfYarnAnchor, YarnCard } from './types'
import { ROOM_AROUND, TRANSLATION_GAP, cardsForSurface, centredContentWidth, clipsFor, contentRect, isShown, pageBand, pinnedAfterResize, placeCards, worldRect, yarnSegments, type WorldInput } from './worldLayout'

const pages = pageLayout([
  [612, 792],
  [612, 792],
  [612, 792],
])

let n = 0
function card(over: Partial<YarnCard> & { anchors: PdfYarnAnchor[] }): YarnCard {
  n += 1
  return {
    id: over.id ?? `c${n}`,
    bookId: 'b',
    color: 'lavender',
    kind: 'lavender',
    x: 0,
    y: 0,
    width: GEOMETRY.cardWidth,
    isPinned: false,
    collapsed: false,
    messages: [],
    createdAt: n,
    updatedAt: n,
    ...over,
  }
}

const onPage = (page: number, y = 0.3): PdfYarnAnchor => ({
  id: `a-${page}-${y}`,
  sourceType: 'pdf_text',
  bookId: 'b',
  pageNumber: page,
  selectedText: 'metin',
  lineRects: [{ x: 0.1, y, width: 0.5, height: 0.02 }],
  boundingRect: { x: 0.1, y, width: 0.5, height: 0.02 },
})

const inCard = (parent: string, y = 120): PdfYarnAnchor => ({
  id: `in-${parent}`,
  sourceType: 'card',
  bookId: 'b',
  pageNumber: 0,
  selectedText: 'iç',
  lineRects: [],
  boundingRect: { x: 20, y, width: 100, height: 16 },
  sourceCardId: parent,
})

function input(cards: YarnCard[], over: Partial<WorldInput> = {}): WorldInput {
  return { cards, pages, heights: {}, pagedReading: false, currentPage: 1, hideThreads: false, revealed: new Set(), ...over }
}

describe('world layout', () => {
  it('a deep chain of threads opened inside threads stays level with its parents, however deep', () => {
    const chain: YarnCard[] = [card({ id: 'root', anchors: [onPage(1)] })]
    for (let i = 1; i <= 8; i += 1) chain.push(card({ id: `d${i}`, parentCardId: chain[i - 1]!.id, anchors: [inCard(chain[i - 1]!.id)] }))
    const placed = placeCards(input(chain))
    expect(placed.size).toBe(9)
    for (let i = 1; i <= 8; i += 1) {
      const parent = placed.get(chain[i - 1]!.id)!
      const child = placed.get(chain[i]!.id)!
      expect(child.x).toBe(subLaneX({ x: parent.x, width: GEOMETRY.cardWidth }))
      // Level with the text it came from: never above its parent.
      expect(child.y).toBeGreaterThanOrEqual(parent.y)
      expect(child.y).toBeCloseTo(parent.y + 120 + 8 - GEOMETRY.anchorLift, 5)
    }
  })

  it('a folded thread folds what was opened from it, and shows as a knot on the parent’s edge', () => {
    const root = card({ id: 'root', anchors: [onPage(1)] })
    const child = card({ id: 'child', parentCardId: 'root', anchors: [inCard('root')], collapsed: true })
    const grandchild = card({ id: 'grand', parentCardId: 'child', anchors: [inCard('child')] })
    const sibling = card({ id: 'sib', parentCardId: 'root', anchors: [inCard('root', 200)] })
    const world = input([root, child, grandchild, sibling])
    const placed = placeCards(world)
    expect([...placed.keys()].sort()).toEqual(['root', 'sib'])
    const clips = clipsFor(world, placed, 'tr')
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({ cardId: 'child', right: true })
    expect(clips[0]!.point[0]).toBe(placed.get('root')!.x + GEOMETRY.cardWidth)
  })

  it('a folded thread pinned left of its parent ties its knot on the left edge; knots never overlap', () => {
    const root = card({ id: 'root', anchors: [onPage(1)] })
    const a = card({ id: 'a', parentCardId: 'root', anchors: [inCard('root', 100)], collapsed: true, isPinned: true, x: 0, y: 0 })
    const b = card({ id: 'b', parentCardId: 'root', anchors: [inCard('root', 110)], collapsed: true, isPinned: true, x: 0, y: 0 })
    const world = input([root, a, b])
    const clips = clipsFor(world, placeCards(world), 'tr')
    expect(clips.every((c) => !c.right)).toBe(true)
    expect(clips[1]!.point[1] - clips[0]!.point[1]).toBeGreaterThanOrEqual(30)
  })

  it('page by page: each page lays out its own threads and only the current page’s are shown', () => {
    const tall = card({ id: 'p1', anchors: [onPage(1, 0.9)] })
    const next = card({ id: 'p2', anchors: [onPage(2, 0.0)] })
    const heights = { p1: 900 }
    const scrolling = placeCards(input([tall, next], { heights }))
    const paged = placeCards(input([tall, next], { heights, pagedReading: true }))
    // Scrolling, the tall card on page 1 pushes page 2's card down; page by page it does not.
    expect(scrolling.get('p2')!.y).toBeGreaterThan(paged.get('p2')!.y)
    const world = input([tall, next], { heights, pagedReading: true, currentPage: 2 })
    expect(isShown(tall, world)).toBe(false)
    expect(isShown(next, world)).toBe(true)
    const band = pageBand(world, paged, 2)!
    expect(band.top).toBeLessThanOrEqual(pages[1]!.y - 32)
  })

  it('a page translation sits level with its page, a little right of the threads beside it', () => {
    const thread = card({ id: 't', anchors: [onPage(2)] })
    const translation = card({ id: 'tr', kind: 'translate', color: 'sky', anchors: [onPage(2)], translatedPage: 2, translationLanguage: 'tr', width: 760, height: pages[1]!.height })
    const sub = card({ id: 'sub', parentCardId: 'tr', anchors: [inCard('tr', 300)] })
    const placed = placeCards(input([thread, translation, sub], { heights: { t: 200 } }))
    expect(placed.get('tr')).toEqual({ x: LANE_X + GEOMETRY.cardWidth + TRANSLATION_GAP, y: pages[1]!.y })
    expect(placed.get('sub')!.x).toBe(subLaneX({ x: placed.get('tr')!.x, width: 760 }))
    // The eye button hides threads, not translations.
    const hidden = input([thread, translation, sub], { hideThreads: true })
    expect(isShown(translation, hidden)).toBe(true)
    expect(isShown(thread, hidden)).toBe(false)
    expect(isShown(thread, { ...hidden, revealed: new Set(['t']) })).toBe(true)
  })

  it('a card moved left of the page takes its yarn on its right edge, from the passage’s left end', () => {
    const left = card({ id: 'l', anchors: [onPage(1)], isPinned: true, x: -500, y: 100 })
    const world = input([left])
    const [segment] = yarnSegments(world, placeCards(world))
    expect(segment!.to[0]).toBe(-500 + GEOMETRY.cardWidth)
    expect(segment!.from[0]).toBeCloseTo(0.1 * GEOMETRY.pageWorldWidth, 5)
  })

  it('the world has generous room on both sides, centred on the page', () => {
    const left = card({ id: 'l', anchors: [onPage(1)], isPinned: true, x: -500, y: 100 })
    const world = input([left])
    const content = contentRect(world, placeCards(world))
    const rect = worldRect(content)
    const mid = GEOMETRY.pageWorldWidth / 2
    expect(rect.x + rect.width / 2).toBeCloseTo(mid, 5)
    expect(rect.x).toBeLessThanOrEqual(-500 - ROOM_AROUND + 1)
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(LANE_X + GEOMETRY.cardWidth + ROOM_AROUND)
    expect(centredContentWidth(content)).toBeGreaterThan(2 * (mid + 500))
  })

  // Owner, 16 Nov: the pages are resized from a page's corner; everything stays with its passage.
  describe('resized pages', () => {
    const sizes = [
      [612, 792],
      [612, 792],
      [612, 792],
    ] as const
    const big = pageLayout(sizes, 1.5 * GEOMETRY.pageWorldWidth)

    it('the lane, the yarns’ ends and the world follow the pages’ width', () => {
      const thread = card({ id: 'lane', anchors: [onPage(2, 0.5)] })
      const world = input([thread], { pages: big })
      const placed = placeCards(world)
      expect(placed.get('lane')!.x).toBe(laneX(big[0]!.width))
      const [segment] = yarnSegments(world, placed)
      expect(segment!.from[0]).toBeCloseTo(0.6 * big[0]!.width, 5)
      expect(segment!.from[1]).toBeCloseTo(big[1]!.y + 0.51 * big[1]!.height, 5)
      const content = contentRect(world, placed)
      expect(content.pageWidth).toBe(big[0]!.width)
      const rect = worldRect(content)
      expect(rect.x + rect.width / 2).toBeCloseTo(big[0]!.width / 2, 5)
    })

    it('a translation is drawn at its page’s size now, and placed cards move with their passage', () => {
      const translation = card({ id: 'tr', kind: 'translate', color: 'sky', anchors: [onPage(2)], translatedPage: 2, translationLanguage: 'tr', width: 760, height: pages[1]!.height })
      const pinned = card({ id: 'p', anchors: [onPage(2)], isPinned: true, x: 900, y: pages[1]!.y + 100 })
      const lane = card({ id: 'l', anchors: [onPage(1)] })
      const cards = [translation, pinned, lane]
      const shown = cardsForSurface(cards, big)
      expect(shown[0]).toMatchObject({ width: big[1]!.width, height: big[1]!.height })
      // Unchanged cards keep their identity, so they are not drawn again.
      expect(shown[1]).toBe(pinned)
      expect(shown[2]).toBe(lane)
      // The stored translation keeps the size it was made at.
      expect(translation.width).toBe(760)

      const moved = pinnedAfterResize(cards, pages, big)
      expect([...moved.keys()]).toEqual(['p'])
      const at = moved.get('p')!
      expect([at.x, at.y]).toEqual(remapPinned([900, pages[1]!.y + 100], pages, big))
      // Right of the page it keeps its distance from the page's right edge.
      expect(at.x - big[0]!.width).toBeCloseTo(900 - pages[0]!.width, 9)
      const during = cardsForSurface(cards, big, moved)
      expect(during[1]).toMatchObject({ x: at.x, y: at.y })
    })
  })
})
