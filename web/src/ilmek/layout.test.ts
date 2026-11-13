import { describe, expect, it } from 'vitest'
import { GEOMETRY, LANE_X, subLaneX } from './geometry'
import { layoutCards, type CardForLayout } from './lane'
import { mergeLineRects } from '../reader/selection'
import { parseBlocks } from '../ui/Markdown'

const card = (over: Partial<CardForLayout> & { id: string }): CardForLayout => ({
  isPinned: false,
  collapsed: false,
  x: 0,
  y: 0,
  width: GEOMETRY.cardWidth,
  anchorY: 100,
  height: 120,
  ...over,
})

describe('layoutCards', () => {
  it('lifts a card slightly above its sentence in the first lane', () => {
    const placed = layoutCards([card({ id: 'a', anchorY: 300 })])
    expect(placed.get('a')).toEqual({ x: LANE_X, y: 300 - GEOMETRY.anchorLift })
  })

  it('keeps pinned cards where the reader left them and leaves them out of the lane', () => {
    const placed = layoutCards([
      card({ id: 'pinned', isPinned: true, x: 50, y: 900, anchorY: 300 }),
      card({ id: 'free', anchorY: 300 }),
    ])
    expect(placed.get('pinned')).toEqual({ x: 50, y: 900 })
    expect(placed.get('free')!.y).toBe(300 - GEOMETRY.anchorLift)
  })

  it('does not place folded cards, and the rest close the gap', () => {
    const placed = layoutCards([card({ id: 'a', anchorY: 300, collapsed: true }), card({ id: 'b', anchorY: 310 })])
    expect(placed.has('a')).toBe(false)
    expect(placed.get('b')!.y).toBe(310 - GEOMETRY.anchorLift)
  })

  it('puts a thread opened from a card in a lane right of its parent', () => {
    const placed = layoutCards([card({ id: 'parent', anchorY: 200 }), card({ id: 'child', parentCardId: 'parent', anchorY: 260 })])
    const parent = placed.get('parent')!
    expect(placed.get('child')!.x).toBe(subLaneX({ x: parent.x, width: GEOMETRY.cardWidth }))
  })

  it('follows a pinned parent with its child lane', () => {
    const placed = layoutCards([
      card({ id: 'parent', isPinned: true, x: 1500, y: 40 }),
      card({ id: 'child', parentCardId: 'parent', anchorY: 90 }),
    ])
    expect(placed.get('child')!.x).toBe(1500 + GEOMETRY.cardWidth + GEOMETRY.subLaneGap)
  })
})

describe('mergeLineRects', () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })
  it('joins fragments on one line and keeps separate lines apart', () => {
    const lines = mergeLineRects([box(10, 100, 50, 12), box(62, 101, 40, 11), box(10, 120, 80, 12), box(0, 0, 0, 0)])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ left: 10, right: 102 })
    expect(lines[1]).toMatchObject({ top: 120 })
  })
})

describe('Markdown', () => {
  it('splits paragraphs, lists and headings', () => {
    expect(parseBlocks('# Başlık\nbir\niki\n\n- a\n- b\n1. c')).toEqual([
      { type: 'h', text: 'Başlık' },
      { type: 'p', text: 'bir iki' },
      { type: 'ul', items: ['a', 'b'] },
      { type: 'ol', items: ['c'] },
    ])
  })
})
