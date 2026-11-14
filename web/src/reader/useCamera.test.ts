import { describe, expect, it } from 'vitest'
import { KEPT_IN_VIEW, constrainToBand } from './useCamera'

describe('constrainToBand', () => {
  const band = { top: 100, bottom: 600 }

  it('lets a band smaller than the window move up and down (owner test 14 Nov)', () => {
    // 500 world units at ×0.5 is 250 px in an 800 px window.
    const start = { x: 0, y: 24 - band.top * 0.5, s: 0.5 }
    expect(constrainToBand(start, band, 800).y).toBe(start.y)
    expect(constrainToBand({ ...start, y: start.y + 150 }, band, 800).y).toBe(start.y + 150)
    expect(constrainToBand({ ...start, y: start.y - 150 }, band, 800).y).toBe(start.y - 150)
  })

  it('keeps a strip of the band in view at the top and at the bottom', () => {
    for (const s of [0.5, 1, 2]) {
      const up = constrainToBand({ x: 0, y: -1e6, s }, band, 800)
      expect(up.y + band.bottom * s).toBeCloseTo(KEPT_IN_VIEW)
      const down = constrainToBand({ x: 0, y: 1e6, s }, band, 800)
      expect(800 - (down.y + band.top * s)).toBeCloseTo(KEPT_IN_VIEW)
    }
  })

  it('never leaves the window without part of the band, even in a very short window', () => {
    const c = constrainToBand({ x: 0, y: 1e6, s: 1 }, { top: 0, bottom: 10 }, 100)
    expect(c.y).toBeLessThanOrEqual(100)
    expect(c.y + 10).toBeGreaterThanOrEqual(0)
  })
})
