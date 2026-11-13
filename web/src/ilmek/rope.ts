import { useEffect, useRef, useState } from 'react'
import { bezierControls } from './geometry'
import type { Point } from './types'

/**
 * Rope-like motion for yarns (same rules as the Mac app). While a card is dragged, the middle of each
 * yarn attached to it trails the movement and sags a little under gravity; after release it swings back
 * to the drawn curve and settles. Each yarn's midpoint is a small mass on a spring toward the curve's
 * resting midpoint.
 */
export interface RopeSegment {
  key: string
  from: Point
  to: Point
}

interface Rope {
  mid: Point
  v: Point
}

export type Ropes = Map<string, Rope>

/** Spring in Apple's terms: response (seconds) and damping ratio (below 1 swings a little). */
const RESPONSE = 0.42
const DAMPING = 0.6
export const STIFFNESS = (2 * Math.PI / RESPONSE) ** 2
export const FRICTION = (4 * Math.PI * DAMPING) / RESPONSE

/**
 * The resting curve's control points. A yarn running leftwards (to a card left of the page) is the
 * mirror image of the usual left-to-right curve.
 */
export function baseControls(from: Point, to: Point): { c1: Point; c2: Point } {
  if (to[0] >= from[0]) return bezierControls(from[0], from[1], to[0], to[1])
  const { c1, c2 } = bezierControls(-from[0], from[1], -to[0], to[1])
  return { c1: [-c1[0], c1[1]], c2: [-c2[0], c2[1]] }
}

/** Midpoint of the drawn cubic curve. */
export function restMid(seg: RopeSegment): Point {
  const { c1, c2 } = baseControls(seg.from, seg.to)
  return [(seg.from[0] + 3 * c1[0] + 3 * c2[0] + seg.to[0]) / 8, (seg.from[1] + 3 * c1[1] + 3 * c2[1] + seg.to[1]) / 8]
}

/** Steady sag while held: slight, and smaller on short yarns. */
export function sag(seg: RopeSegment): number {
  return Math.min(26, Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]) * 0.08)
}

/**
 * Advances the ropes by `dt` seconds (mutates `ropes`). `held` are the yarns attached to the card being
 * dragged. Returns how far each moving yarn's midpoint sits from its resting curve.
 */
export function stepRopes(ropes: Ropes, segments: readonly RopeSegment[], held: ReadonlySet<string>, dt: number): Map<string, Point> {
  const byKey = new Map(segments.map((s) => [s.key, s]))
  for (const key of held) {
    const seg = byKey.get(key)
    if (seg && !ropes.has(key)) ropes.set(key, { mid: restMid(seg), v: [0, 0] })
  }
  const bends = new Map<string, Point>()
  for (const [key, rope] of ropes) {
    const seg = byKey.get(key)
    if (!seg) {
      ropes.delete(key)
      continue
    }
    const rest = restMid(seg)
    const isHeld = held.has(key)
    const target: Point = [rest[0], rest[1] + (isHeld ? sag(seg) : 0)]
    if (dt > 0) {
      const n = Math.max(1, Math.ceil(dt * 240))
      const h = dt / n
      for (let i = 0; i < n; i++) {
        const ax = STIFFNESS * (target[0] - rope.mid[0]) - FRICTION * rope.v[0]
        const ay = STIFFNESS * (target[1] - rope.mid[1]) - FRICTION * rope.v[1]
        rope.v = [rope.v[0] + ax * h, rope.v[1] + ay * h]
        rope.mid = [rope.mid[0] + rope.v[0] * h, rope.mid[1] + rope.v[1] * h]
      }
    }
    // Keep the bend modest even after a fast fling.
    const chord = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1])
    const limit = Math.max(10, chord * 0.3)
    let d: Point = [rope.mid[0] - rest[0], rope.mid[1] - rest[1]]
    const length = Math.hypot(d[0], d[1])
    if (length > limit) {
      d = [(d[0] * limit) / length, (d[1] * limit) / length]
      rope.mid = [rest[0] + d[0], rest[1] + d[1]]
      rope.v = [rope.v[0] * 0.5, rope.v[1] * 0.5]
    }
    if (!isHeld && Math.hypot(d[0], d[1]) < 0.2 && Math.hypot(rope.v[0], rope.v[1]) < 3) {
      ropes.delete(key)
      continue
    }
    bends.set(key, d)
  }
  return bends
}

/** Path for a yarn, bent so the curve's midpoint moves by `bend` (moving both control points by b moves a cubic's midpoint by 3b/4). */
export function bentPath(from: Point, to: Point, bend?: Point): string {
  const { c1, c2 } = baseControls(from, to)
  const bx = bend ? (bend[0] * 4) / 3 : 0
  const by = bend ? (bend[1] * 4) / 3 : 0
  const f = (n: number) => Number(n.toFixed(2))
  return `M ${f(from[0])} ${f(from[1])} C ${f(c1[0] + bx)} ${f(c1[1] + by)}, ${f(c2[0] + bx)} ${f(c2[1] + by)}, ${f(to[0])} ${f(to[1])}`
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Runs the ropes on the display clock while a card is held or a yarn is still swinging; idle otherwise.
 * With reduced motion the yarns only follow the card.
 */
export function useRopes(segments: readonly RopeSegment[], held: ReadonlySet<string>): Map<string, Point> {
  const ropes = useRef<Ropes>(new Map())
  const latest = useRef({ segments, held })
  const [bends, setBends] = useState<Map<string, Point>>(() => new Map())
  latest.current = { segments, held }
  const active = held.size > 0

  useEffect(() => {
    if (prefersReducedMotion()) return
    if (!active && ropes.current.size === 0) return
    let frame = 0
    let last: number | null = null
    const tick = (now: number) => {
      const dt = last === null ? 1 / 120 : Math.min(1 / 30, Math.max(0, (now - last) / 1000))
      last = now
      const next = stepRopes(ropes.current, latest.current.segments, latest.current.held, dt)
      setBends(next)
      if (latest.current.held.size > 0 || ropes.current.size > 0) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active])

  return bends
}
