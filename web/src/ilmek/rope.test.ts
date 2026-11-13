import { describe, expect, it } from 'vitest'
import { GEOMETRY, LANE_X } from './geometry'
import { bentPath, restMid, stepRopes, type RopeSegment, type Ropes } from './rope'
import type { Point } from './types'

/** Same scenario as the Mac test: a card pulled right at 360 points a second for half a second. */
describe('yarn ropes', () => {
  const from: Point = [480, 300]
  const startTo: Point = [LANE_X, 300 + GEOMETRY.cardAttachY]
  const seg = (dx: number): RopeSegment => ({ key: 'y', from, to: [startTo[0] + dx, startTo[1]] })

  it('trails and sags while held, then swings past the curve and settles', () => {
    const ropes: Ropes = new Map()
    const held = new Set(['y'])
    let bends = new Map<string, Point>()
    for (let i = 1; i <= 60; i++) bends = stepRopes(ropes, [seg(i * 3)], held, 1 / 120)
    const b = bends.get('y')!
    expect(b[0]).toBeLessThan(-4)
    expect(b[1]).toBeGreaterThan(8)

    let swung = false
    let frames = 0
    while (ropes.size > 0 && frames < 600) {
      bends = stepRopes(ropes, [seg(180)], new Set(), 1 / 120)
      const r = bends.get('y')
      if (r && r[1] < -0.3) swung = true
      frames++
    }
    expect(swung).toBe(true)
    expect(frames).toBeLessThan(240)
    expect(bends.size).toBe(0)
  })

  it('leaves still yarns alone and draws them on the usual curve', () => {
    const ropes: Ropes = new Map()
    const bends = stepRopes(ropes, [seg(0)], new Set(), 1 / 60)
    expect(bends.size).toBe(0)
    expect(bentPath(from, startTo)).toBe(bentPath(from, startTo, [0, 0]))
  })

  it('moves the drawn midpoint by exactly the bend', () => {
    const s = seg(0)
    const bend: Point = [-6, 12]
    const nums = bentPath(s.from, s.to, bend).match(/-?\d+(\.\d+)?/g)!.map(Number)
    const [x0, y0, x1, y1, x2, y2, x3, y3] = nums as [number, number, number, number, number, number, number, number]
    const mid: Point = [(x0 + 3 * x1 + 3 * x2 + x3) / 8, (y0 + 3 * y1 + 3 * y2 + y3) / 8]
    const rest = restMid(s)
    expect(mid[0] - rest[0]).toBeCloseTo(bend[0], 1)
    expect(mid[1] - rest[1]).toBeCloseTo(bend[1], 1)
  })
})
