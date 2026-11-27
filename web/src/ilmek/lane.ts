import { GEOMETRY, LANE_X, subLaneX } from './geometry'

export interface LaneItem {
  id: string
  desiredY: number
  height: number
}

/**
 * Magnetic lane: cards sit level with their sentence (desiredY) but never overlap. Cards are taken top
 * to bottom; each one goes as high as it wants unless the previous card is still in the way.
 * Equal desiredY values keep their input order (pass cards in creation order).
 */
export function solveLane(items: readonly LaneItem[]): Map<string, number> {
  const order = items.map((item, index) => ({ item, index }))
  order.sort((a, b) => a.item.desiredY - b.item.desiredY || a.index - b.index)
  const placed = new Map<string, number>()
  let cursorBottom = GEOMETRY.laneTop
  for (const { item } of order) {
    const y = Math.max(item.desiredY, cursorBottom)
    placed.set(item.id, y)
    cursorBottom = y + item.height + GEOMETRY.laneGap
  }
  return placed
}

export interface CardForLayout {
  id: string
  parentCardId?: string
  isPinned: boolean
  collapsed: boolean
  x: number
  y: number
  width: number
  /** World y of the point the card's yarn starts from (sentence, area or text inside a parent card). */
  anchorY: number
  /** Measured height; a sensible estimate before the card has rendered. */
  height: number
  /** Home page number (1-based), used to balance right vs left margin lanes when a page's right side crowds up. */
  page?: number
  /** When the thread was created (ms). Threads from before the left lane existed always stay right (unknown: may use either side). */
  createdAt?: number
}

/**
 * The left margin lane arrived with this update (27 Nov 2026). Threads created before it keep their
 * place on the right, so opening an older book after updating never rearranges what the reader left.
 */
export const LEFT_LANE_SINCE = Date.UTC(2026, 10, 27)

export interface CardPlacement {
  x: number
  y: number
}

export interface LayoutOptions {
  /** World width of the PDF pages (`pageWorldWidth * pageScale`); enables symmetric left-margin overflow when set. */
  pageWidth?: number
}

const PROBE_CARD_HEIGHT = 260

function laneDisplacement(items: readonly LaneItem[]): number {
  if (!items.length) return 0
  const placed = solveLane(items)
  let sum = 0
  for (const it of items) sum += Math.max(0, (placed.get(it.id) ?? it.desiredY) - it.desiredY)
  return sum
}

function pinnedOverlap(
  pinnedBoxes: readonly { top: number; bottom: number }[],
  desiredY: number,
  height: number,
): number {
  let overlap = 0
  const endY = desiredY + height
  for (const b of pinnedBoxes) {
    const ov = Math.min(endY, b.bottom + GEOMETRY.laneGap) - Math.max(desiredY, b.top - GEOMETRY.laneGap)
    if (ov > 0) overlap += ov
  }
  return overlap
}

/**
 * Places every visible card. Pinned cards stay where the reader left them. Unpinned first-generation
 * cards use the lane right of the pages first, and overflow to the symmetric lane left of the pages when
 * the right margin beside that page is already crowded; a card opened from inside another card flows
 * outward (right of a right-side parent, left of a left-side parent).
 */
export function layoutCards(
  cards: readonly CardForLayout[],
  laneX: number = LANE_X,
  options?: LayoutOptions,
): Map<string, CardPlacement> {
  const result = new Map<string, CardPlacement>()
  const byId = new Map(cards.map((c) => [c.id, c]))
  const pageWidth = options?.pageWidth
  const pageMid = pageWidth !== undefined ? pageWidth / 2 : undefined

  const depthOf = (card: CardForLayout): number => {
    let depth = 0
    let current: CardForLayout | undefined = card
    const seen = new Set<string>()
    while (current?.parentCardId && byId.has(current.parentCardId) && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parentCardId)
      depth += 1
    }
    return depth
  }

  const visible = cards.filter((c) => !c.collapsed)
  for (const c of visible) if (c.isPinned) result.set(c.id, { x: c.x, y: c.y })

  // Pre-assign depth-0 unpinned threads between the Right and Left margin lanes. Every card counts with
  // the same fixed probe height (`PROBE_CARD_HEIGHT`), and folded cards count too, so a card never
  // changes sides because its answer grows taller or because an earlier thread was folded or unfolded.
  const rootSide = new Map<string, 'left' | 'right'>()
  if (pageWidth !== undefined && pageMid !== undefined) {
    const rightPinned: { top: number; bottom: number; page?: number }[] = []
    const leftPinned: { top: number; bottom: number; page?: number }[] = []
    for (const c of cards) {
      if (!c.isPinned || depthOf(c) !== 0) continue
      // Ignore whole-page translations (which are pinned far right at >= pageWidth + TRANSLATION_GAP with width === pageWidth).
      if (Math.abs(c.width - pageWidth) < 1 && c.x >= pageWidth) continue
      const center = c.x + c.width / 2
      if (center >= pageMid && c.x < laneX + GEOMETRY.cardWidth * 0.85) {
        rightPinned.push({ top: c.y, bottom: c.y + c.height, page: c.page })
      } else if (center < pageMid && c.x + c.width > -GEOMETRY.laneOffset - GEOMETRY.cardWidth * 0.85) {
        leftPinned.push({ top: c.y, bottom: c.y + c.height, page: c.page })
      }
    }

    const rightProbes: (LaneItem & { page?: number })[] = []
    const leftProbes: (LaneItem & { page?: number })[] = []

    for (const c of cards) {
      if (c.isPinned || depthOf(c) !== 0) continue
      const desiredY = c.anchorY - GEOMETRY.anchorLift
      const probe: LaneItem & { page?: number } = { id: c.id, desiredY, height: PROBE_CARD_HEIGHT, page: c.page }
      if (c.createdAt !== undefined && c.createdAt < LEFT_LANE_SINCE) {
        rootSide.set(c.id, 'right')
        rightProbes.push(probe)
        continue
      }

      const samePageOnRight =
        c.page !== undefined
          ? rightProbes.filter((p) => p.page === c.page).length + rightPinned.filter((p) => p.page === c.page).length
          : rightProbes.length + rightPinned.length

      if (samePageOnRight >= 1) {
        const rightAdded =
          laneDisplacement([...rightProbes, probe]) -
          laneDisplacement(rightProbes) +
          pinnedOverlap(rightPinned, desiredY, PROBE_CARD_HEIGHT)
        const leftAdded =
          laneDisplacement([...leftProbes, probe]) -
          laneDisplacement(leftProbes) +
          pinnedOverlap(leftPinned, desiredY, PROBE_CARD_HEIGHT)

        if (rightAdded >= 120 && leftAdded + 60 < rightAdded) {
          rootSide.set(c.id, 'left')
          leftProbes.push(probe)
          continue
        }
      }
      rootSide.set(c.id, 'right')
      rightProbes.push(probe)
    }
  }

  const maxDepth = visible.reduce((m, c) => Math.max(m, depthOf(c)), 0)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const lanes = new Map<string, { xFor: (c: CardForLayout) => number; list: CardForLayout[] }>()
    for (const c of visible) {
      if (c.isPinned || depthOf(c) !== depth) continue
      let laneKey = `x:${laneX}`
      let xFor = (_card: CardForLayout) => laneX
      if (depth === 0 && rootSide.get(c.id) === 'left') {
        laneKey = 'left-root'
        xFor = (card: CardForLayout) => -GEOMETRY.laneOffset - card.width
      } else if (depth > 0 && c.parentCardId) {
        const parent = byId.get(c.parentCardId)
        const parentPlacement = parent ? result.get(parent.id) : undefined
        if (parent && parentPlacement) {
          const parentOnLeft = pageMid !== undefined && parentPlacement.x + parent.width / 2 < pageMid
          if (parentOnLeft) {
            laneKey = `left-sub:${parent.id}`
            xFor = (card: CardForLayout) => parentPlacement.x - card.width - GEOMETRY.subLaneGap
          } else {
            const sx = subLaneX({ x: parentPlacement.x, width: parent.width })
            laneKey = `x:${sx}`
            xFor = () => sx
          }
        }
      }
      const entry = lanes.get(laneKey) ?? { xFor, list: [] }
      entry.list.push(c)
      lanes.set(laneKey, entry)
    }
    for (const { xFor, list } of lanes.values()) {
      const solved = solveLane(list.map((c) => ({ id: c.id, desiredY: c.anchorY - GEOMETRY.anchorLift, height: c.height })))
      for (const c of list) result.set(c.id, { x: xFor(c), y: solved.get(c.id) ?? c.anchorY })
    }
  }
  return result
}
