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
 * Where the camera goes to show a page's new translation: the zoom and the vertical position stay as the
 * reader left them (owner test 16 Nov: translating zoomed in to 120%). Sideways, the page and its
 * translation are centred when both fit at this zoom (with 24 px to spare on each side); otherwise the
 * translation's left edge comes to the middle of the window.
 */
export function cameraForTranslation(c: Camera, viewportWidth: number, span: { pageLeft: number; translationLeft: number; right: number }): Camera {
  const fits = (span.right - span.pageLeft) * c.s <= viewportWidth - 48
  const x = fits ? viewportWidth / 2 - ((span.pageLeft + span.right) / 2) * c.s : viewportWidth / 2 - span.translationLeft * c.s
  return { x, y: c.y, s: c.s }
}

/**
 * "Focus" ("Odak"): fits the PDF page cleanly (up to 100% on wide screens, fit-to-width on narrow/mobile
 * screens so pages never overflow sideways) and clamps the vertical position within the document so
 * returning from Map mode never jumps zoom above 100% or pushes pages off-screen.
 */
export function cameraForFocus(
  c: Camera,
  viewport: { width: number; height: number },
  pageWidth: number,
  docBounds: { top: number; bottom: number },
): Camera {
  const padX = viewport.width < 640 ? 20 : 48
  const padY = 24
  const s = clampScale(Math.min(1, (viewport.width - padX) / Math.max(1, pageWidth)))
  const x = viewport.width / 2 - (pageWidth / 2) * s
  const cy = (viewport.height / 2 - c.y) / c.s
  const rawY = viewport.height / 2 - cy * s
  const minY = viewport.height - padY - docBounds.bottom * s
  const maxY = padY - docBounds.top * s
  const y = minY > maxY ? maxY : Math.min(maxY, Math.max(minY, rawY))
  return { x, y, s }
}

/**
 * "Map" ("Harita"): fits and centres the actual bounding box of pages, visible threads and translations
 * horizontally and (around the current page's vertical band) vertically.
 */
export function cameraForMap(
  viewport: { width: number; height: number },
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  band?: { top: number; bottom: number } | null,
): Camera {
  const pad = viewport.width < 640 ? 24 : 48
  const contentW = Math.max(1, bounds.maxX - bounds.minX)
  const bandTop = band ? band.top : bounds.minY
  const bandBottom = band ? band.bottom : bounds.maxY
  const bandH = Math.max(1, bandBottom - bandTop)
  const sx = (viewport.width - pad * 2) / contentW
  const sy = (viewport.height - pad * 2) / bandH
  const s = clampScale(Math.min(0.85, sx, sy))
  const x = viewport.width / 2 - ((bounds.minX + bounds.maxX) / 2) * s
  const rawY = viewport.height / 2 - ((bandTop + bandBottom) / 2) * s
  const docH = (bounds.maxY - bounds.minY) * s
  const y =
    docH <= viewport.height - pad * 2
      ? viewport.height / 2 - ((bounds.minY + bounds.maxY) / 2) * s
      : Math.min(pad - bounds.minY * s, Math.max(viewport.height - pad - bounds.maxY * s, rawY))
  return { x, y, s }
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

export interface WheelAxisLock {
  axis: 'x' | 'y' | null
  accX: number
  accY: number
  lastAt: number
  target: EventTarget | null
}

export function createWheelAxisLock(): WheelAxisLock {
  return { axis: null, accX: 0, accY: 0, lastAt: -Infinity, target: null }
}

/**
 * Directional axis lock for scrolling inside an İlmek card or translated page (macOS trackpad, Windows
 * Precision Touchpad, standard mouse wheel, and Shift+Wheel):
 * - Vertical reading swipes lock to `'y'` so natural finger curvature (`deltaX = 2..8px`) never wobbles
 *   the background canvas horizontally.
 * - Deliberate sideways swipes (`|dx| > |dy| * 1.5`) or `Shift + Wheel` lock to `'x'` so the canvas pans
 *   smoothly left/right without shifting the card's vertical reading line.
 * - Resets after 140ms of silence, and permits immediate 90° interruption during inertial momentum tails.
 */
export function stepCardWheelLock(
  lock: WheelAxisLock,
  dxPx: number,
  dyPx: number,
  shiftKey: boolean,
  now: number,
  target: EventTarget | null,
): { scrollY: number; panX: number } {
  if (now - lock.lastAt > 140 || lock.target !== target) {
    lock.axis = null
    lock.accX = 0
    lock.accY = 0
    lock.target = target
  }
  lock.lastAt = now

  if (shiftKey) {
    lock.axis = 'x'
    return { scrollY: 0, panX: dxPx ? -dxPx : 0 }
  }

  const ax = Math.abs(dxPx)
  const ay = Math.abs(dyPx)

  if (lock.axis === 'y' && ax >= 14 && ax > ay * 2.5) {
    lock.axis = 'x'
  } else if (lock.axis === 'x' && ay >= 14 && ay > ax * 2.5) {
    lock.axis = 'y'
  }

  if (lock.axis === null) {
    if (dxPx === 0 && dyPx !== 0) {
      lock.axis = 'y'
    } else if (dyPx === 0 && ax >= 4) {
      lock.axis = 'x'
    } else {
      lock.accX += ax
      lock.accY += ay
      if (Math.hypot(lock.accX, lock.accY) >= 6) {
        lock.axis = lock.accX > lock.accY * 1.5 ? 'x' : 'y'
      }
    }
  }

  const activeAxis = lock.axis ?? (lock.accX > lock.accY * 1.5 ? 'x' : 'y')
  if (activeAxis === 'x') {
    return { scrollY: 0, panX: dxPx ? -dxPx : 0 }
  }
  return { scrollY: dyPx, panX: 0 }
}
