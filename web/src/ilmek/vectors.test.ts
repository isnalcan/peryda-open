import { describe, expect, it } from 'vitest'
import bezierVectors from '@shared/vectors/bezier.json'
import worldVectors from '@shared/vectors/world.json'
import pdfVectors from '@shared/vectors/pdf-coordinates.json'
import laneVectors from '@shared/vectors/lane.json'
import areaVectors from '@shared/vectors/area.json'
import zoomVectors from '@shared/vectors/zoom.json'
import providerVectors from '@shared/vectors/provider.json'
import pageScaleVectors from '@shared/vectors/page-scale.json'
import {
  GEOMETRY,
  LANE_X,
  anchorWorldPoint,
  areaAccepted,
  bezierControls,
  cardAttachPoint,
  clampPageScale,
  cropPixels,
  laneX,
  normalizedToPdf,
  pageLayout,
  pdfToNormalized,
  remapPinned,
  subLaneX,
  zoomAt,
} from './geometry'
import { solveLane } from './lane'
import { normalizeSettings, resolveActiveProvider, type ProviderId } from '../ai/provider'

const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 9)
const closeAll = (actual: readonly number[], expected: readonly number[]) => {
  expect(actual.length).toBe(expected.length)
  actual.forEach((value, i) => close(value, expected[i]!))
}

describe('shared vectors: yarn curve', () => {
  it.each(bezierVectors.cases)('from $from to $to', (c) => {
    const { c1, c2 } = bezierControls(c.from[0]!, c.from[1]!, c.to[0]!, c.to[1]!)
    closeAll(c1, c.c1)
    closeAll(c2, c.c2)
  })
})

describe('shared vectors: world space', () => {
  const sizes = worldVectors.pageSizes.map((s) => [s[0]!, s[1]!] as const)
  const pages = pageLayout(sizes)

  it('stacks pages at a fixed width with gaps', () => {
    pages.forEach((p, i) => {
      const e = worldVectors.pages[i]!
      closeAll([p.x, p.y, p.width, p.height], [e.x, e.y, e.width, e.height])
    })
  })

  it.each(worldVectors.anchors)('anchor on page $page', (a) => {
    closeAll(anchorWorldPoint(a.rect, pages[a.page]!), a.world)
  })

  it('card attach point, lane and sub-lane', () => {
    for (const c of worldVectors.cardAttach) closeAll(cardAttachPoint(c.card), c.point)
    expect(LANE_X).toBe(worldVectors.laneX)
    expect(subLaneX(worldVectors.subLane.parent)).toBe(worldVectors.subLane.x)
  })
})

describe('shared vectors: resizing the pages', () => {
  const sizes = pageScaleVectors.sizes.map((s) => [s[0]!, s[1]!] as const)
  const base = pageLayout(sizes)

  it('stacks pages at scale 1 like the world vectors', () => {
    base.forEach((p, i) => {
      const e = pageScaleVectors.basePages[i]!
      closeAll([p.x, p.y, p.width, p.height], [e.x, e.y, e.width, e.height])
    })
  })

  it.each(pageScaleVectors.scaled)('scale $scale: pages, lane and placed cards', (c) => {
    const pages = pageLayout(sizes, GEOMETRY.pageWorldWidth * c.scale)
    pages.forEach((p, i) => {
      const e = c.pages[i]!
      closeAll([p.x, p.y, p.width, p.height], [e.x, e.y, e.width, e.height])
    })
    close(laneX(pages[0]!.width), c.laneX)
    for (const pin of c.pinned) closeAll(remapPinned([pin.from[0]!, pin.from[1]!], base, pages), pin.to)
  })

  it.each(pageScaleVectors.clamp)('clamps $scale', (c) => {
    close(clampPageScale(c.scale), c.clamped)
  })
})

describe('shared vectors: PDF coordinates', () => {
  it.each(pdfVectors.cases)('bounds $bounds', (c) => {
    const bounds = c.bounds as [number, number, number, number]
    const rect = c.rect as [number, number, number, number]
    const n = pdfToNormalized(bounds, rect)
    closeAll([n.x, n.y, n.width, n.height], [c.normalized.x, c.normalized.y, c.normalized.width, c.normalized.height])
    closeAll(normalizedToPdf(bounds, n), rect)
  })
})

describe('shared vectors: magnetic lane', () => {
  it.each(laneVectors.cases)('$name', (c) => {
    const placed = solveLane(c.cards)
    for (const [id, y] of Object.entries(c.placedY)) close(placed.get(id)!, y)
  })
})

describe('shared vectors: area stitch', () => {
  it.each(areaVectors.crops)('crop on $canvas', (c) => {
    expect(cropPixels(c.canvas[0]!, c.canvas[1]!, c.norm)).toEqual(c.pixels)
  })
  it.each(areaVectors.minimum)('minimum size $norm', (c) => {
    expect(areaAccepted(c.norm)).toBe(c.accepted)
  })
})

describe('shared vectors: zoom around the cursor', () => {
  it.each(zoomVectors.cases)('scale $scale -> $nextScale', (c) => {
    const r = zoomAt([c.pan[0]!, c.pan[1]!], c.scale, [c.cursor[0]!, c.cursor[1]!], c.nextScale)
    closeAll(r.world, c.world)
    closeAll(r.pan, c.nextPan)
  })
})

describe('shared vectors: provider choice', () => {
  it.each(providerVectors.cases)('%#', (c) => {
    const settings = normalizeSettings({ ...c.settings, activeProvider: c.settings.activeProvider as ProviderId })
    expect(resolveActiveProvider(settings)).toBe(c.provider)
  })
})
