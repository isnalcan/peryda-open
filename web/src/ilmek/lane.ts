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
}

export interface CardPlacement {
  x: number
  y: number
}

/**
 * Places every visible card. Pinned cards stay where the reader left them. Unpinned first-generation
 * cards share the lane right of the pages (at `laneX`, which follows the pages' size); a card opened
 * from inside another card goes to a lane right of its parent. Each lane is solved separately, parents
 * before children.
 */
export function layoutCards(cards: readonly CardForLayout[], laneX: number = LANE_X): Map<string, CardPlacement> {
  const result = new Map<string, CardPlacement>()
  const byId = new Map(cards.map((c) => [c.id, c]))
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

  const maxDepth = visible.reduce((m, c) => Math.max(m, depthOf(c)), 0)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const lanes = new Map<number, CardForLayout[]>()
    for (const c of visible) {
      if (c.isPinned || depthOf(c) !== depth) continue
      let x = laneX
      if (depth > 0 && c.parentCardId) {
        const parent = byId.get(c.parentCardId)
        const parentPlacement = parent ? result.get(parent.id) : undefined
        if (parent && parentPlacement) x = subLaneX({ x: parentPlacement.x, width: parent.width })
      }
      const list = lanes.get(x) ?? []
      list.push(c)
      lanes.set(x, list)
    }
    for (const [x, list] of lanes) {
      const solved = solveLane(list.map((c) => ({ id: c.id, desiredY: c.anchorY - GEOMETRY.anchorLift, height: c.height })))
      for (const c of list) result.set(c.id, { x, y: solved.get(c.id) ?? c.anchorY })
    }
  }
  return result
}
