import { useCallback, useEffect, useRef, useState } from 'react'
import { zoomAt } from '../ilmek/geometry'
import type { Point } from '../ilmek/types'

export interface Camera {
  x: number
  y: number
  s: number
}

export const MIN_SCALE = 0.15
export const MAX_SCALE = 4

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** How much of the current page's band stays on screen, at least, in page-by-page reading (px). */
export const KEPT_IN_VIEW = 120

/**
 * Page by page, the view moves freely up and down around the current page's band (its page and
 * threads) until only a strip of it is left at the bottom or the top of the window. (Owner test
 * 14 Nov: with the band smaller than the window the surface did not move at all.)
 */
export function constrainToBand(c: Camera, band: { top: number; bottom: number }, viewportHeight: number): Camera {
  const kept = Math.min(KEPT_IN_VIEW, viewportHeight / 2)
  const lowest = kept - band.bottom * c.s
  const highest = viewportHeight - kept - band.top * c.s
  return { ...c, y: lowest > highest ? (lowest + highest) / 2 : Math.min(highest, Math.max(lowest, c.y)) }
}

/**
 * Pan and zoom for the reading surface. The camera only changes on the reader's own input or when a
 * camera button is pressed; nothing else moves it.
 */
export function useCamera(initial: Camera, constrain?: { current: ((c: Camera) => Camera) | null }) {
  const [camera, setCameraState] = useState(initial)
  const ref = useRef(initial)
  const [settledScale, setSettledScale] = useState(initial.s)
  const settleTimer = useRef<number | undefined>(undefined)

  const setCamera = useCallback((next: Camera) => {
    const scaled = { x: next.x, y: next.y, s: clampScale(next.s) }
    // In page-by-page reading the view keeps to the current page's band.
    const c = constrain?.current ? constrain.current(scaled) : scaled
    ref.current = c
    setCameraState(c)
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => setSettledScale(c.s), 180)
  }, [constrain])

  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  const panBy = useCallback((dx: number, dy: number) => {
    const c = ref.current
    setCamera({ ...c, x: c.x + dx, y: c.y + dy })
  }, [setCamera])

  const zoomAround = useCallback((cursor: Point, nextScale: number) => {
    const c = ref.current
    const s = clampScale(nextScale)
    const { pan } = zoomAt([c.x, c.y], c.s, cursor, s)
    setCamera({ x: pan[0], y: pan[1], s })
  }, [setCamera])

  return { camera, cameraRef: ref, settledScale, setCamera, panBy, zoomAround }
}
