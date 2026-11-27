import { useEffect, useMemo, useRef, useState } from 'react'

export type PresenceState = 'entering' | 'open' | 'closing'

export const THREAD_EXIT_MS = 560
export const THREAD_STAGGER_STEP_MS = 35
export const THREAD_STAGGER_MAX_MS = 175

export interface ThreadPresence {
  /** Cards to keep mounted right now (both active `shownIds` and cards currently playing their exit animation). */
  renderedIds: ReadonlySet<string>
  /** State of each mounted card ('entering' on first frame -> 'open', or 'closing' while unravelling). */
  stateOf: ReadonlyMap<string, PresenceState>
  /** Per-card stagger delay in ms when several threads appear or hide together. */
  delayOf: ReadonlyMap<string, number>
}

/**
 * Coordinates smooth enter ("ip uzaması") and exit ("düğüme katlanma / çözülerek kaybolma") transitions
 * for İlmek cards and their yarns. Cards already visible when the book opens start as `'open'` with no
 * flash; newly created, unfolded or unhidden threads animate `'entering' -> 'open'`, and folded or
 * hidden threads stay mounted for `THREAD_EXIT_MS` in `'closing'` before unmounting. Interrupting a
 * closing thread (e.g. toggling Show Threads mid-hide) immediately flips it back to `'open'` so CSS
 * transitions reverse smoothly in place.
 */
export function useThreadPresence(
  existingIds: ReadonlySet<string>,
  shownIds: ReadonlySet<string>,
  resetKey = 'default',
  /**
   * False while the book's saved cards are still loading. Cards arrive after the first render, so
   * until then nothing counts as "added": the threads already in the book open with no animation.
   */
  ready = true,
): ThreadPresence {
  const initializedRef = useRef(false)
  const prevKeyRef = useRef(resetKey)
  const prevShownRef = useRef<ReadonlySet<string>>(shownIds)
  const timersRef = useRef(new Map<string, number>())
  const closingIdsRef = useRef(new Set<string>())
  const rafOuterRef = useRef(0)
  const rafInnerRef = useRef(0)
  const enterTimerRef = useRef(0)

  const [entering, setEntering] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [closing, setClosing] = useState<ReadonlyMap<string, number>>(() => new Map())

  const keyChanged = prevKeyRef.current !== resetKey

  // Synchronously compare `shownIds` against `prevShownRef.current` on every render (never trapped inside a
  // `useMemo` that omits the ref!) so frame 0 of an added/removed card gets 'entering'/'closing' AND frame 2
  // after `setEntering(new Map())` is guaranteed to see `justAdded = []` and transition to `'open'`.
  const justAdded: string[] = []
  const justRemoved: string[] = []
  if (ready && initializedRef.current && !keyChanged) {
    const prev = prevShownRef.current
    for (const id of shownIds) {
      if (!prev.has(id) && !closing.has(id)) justAdded.push(id)
    }
    for (const id of prev) {
      if (!shownIds.has(id) && existingIds.has(id)) justRemoved.push(id)
    }
  }
  const addedKey = justAdded.length ? justAdded.join('\0') : ''
  const removedKey = justRemoved.length ? justRemoved.join('\0') : ''

  useEffect(() => {
    if (!ready) {
      // Not loaded yet: the first render after loading starts from scratch (all 'open', no flash).
      initializedRef.current = false
      return
    }
    if (!initializedRef.current || prevKeyRef.current !== resetKey) {
      initializedRef.current = true
      prevKeyRef.current = resetKey
      prevShownRef.current = shownIds
      cancelAnimationFrame(rafOuterRef.current)
      cancelAnimationFrame(rafInnerRef.current)
      window.clearTimeout(enterTimerRef.current)
      for (const t of timersRef.current.values()) window.clearTimeout(t)
      timersRef.current.clear()
      closingIdsRef.current.clear()
      setEntering((m) => (m.size ? new Map() : m))
      setClosing((m) => (m.size ? new Map() : m))
      return
    }
    const prev = prevShownRef.current
    prevShownRef.current = shownIds

    const added: string[] = []
    const interrupted: string[] = []
    const removed: string[] = []

    for (const id of shownIds) {
      if (!prev.has(id)) {
        if (timersRef.current.has(id) || closingIdsRef.current.has(id)) interrupted.push(id)
        else added.push(id)
      }
    }
    for (const id of prev) {
      if (!shownIds.has(id) && existingIds.has(id)) removed.push(id)
    }

    // Cancel exit timers for any cards that became visible again mid-exit or were deleted.
    for (const id of interrupted) {
      const t = timersRef.current.get(id)
      if (t !== undefined) {
        window.clearTimeout(t)
        timersRef.current.delete(id)
      }
      closingIdsRef.current.delete(id)
    }
    const deleted: string[] = []
    for (const [id, t] of [...timersRef.current.entries()]) {
      if (!existingIds.has(id)) {
        window.clearTimeout(t)
        timersRef.current.delete(id)
        closingIdsRef.current.delete(id)
        deleted.push(id)
      }
    }
    if (deleted.length > 0) {
      setClosing((curr) => {
        if (!deleted.some((id) => curr.has(id))) return curr
        const next = new Map(curr)
        for (const id of deleted) next.delete(id)
        return next
      })
    }

    if (interrupted.length > 0) {
      setClosing((curr) => {
        let changed = false
        const next = new Map(curr)
        for (const id of interrupted) {
          if (next.delete(id)) changed = true
        }
        return changed ? next : curr
      })
    }

    if (added.length > 0 || removed.length > 0) {
      setEntering((curr) => {
        const next = new Map(curr)
        for (const id of removed) next.delete(id)
        added.forEach((id, i) => next.set(id, Math.min(i * THREAD_STAGGER_STEP_MS, THREAD_STAGGER_MAX_MS)))
        return next
      })
      if (added.length > 0) {
        const finishEntering = () => {
          window.clearTimeout(enterTimerRef.current)
          cancelAnimationFrame(rafOuterRef.current)
          cancelAnimationFrame(rafInnerRef.current)
          setEntering((curr) => (curr.size ? new Map() : curr))
        }
        cancelAnimationFrame(rafOuterRef.current)
        cancelAnimationFrame(rafInnerRef.current)
        window.clearTimeout(enterTimerRef.current)
        rafOuterRef.current = requestAnimationFrame(() => {
          // Double-rAF ensures the browser has painted the 'entering' frame before transitioning to 'open'.
          rafInnerRef.current = requestAnimationFrame(finishEntering)
        })
        // Fallback timer guarantees 'entering' transitions to 'open' even if rAF is throttled.
        enterTimerRef.current = window.setTimeout(finishEntering, 90)
      }
    }

    if (removed.length > 0) {
      const delays = new Map<string, number>()
      removed.forEach((id, i) => {
        const delay = Math.min(i * THREAD_STAGGER_STEP_MS, THREAD_STAGGER_MAX_MS)
        delays.set(id, delay)
        closingIdsRef.current.add(id)
        const prevTimer = timersRef.current.get(id)
        if (prevTimer !== undefined) window.clearTimeout(prevTimer)
        const timer = window.setTimeout(() => {
          timersRef.current.delete(id)
          closingIdsRef.current.delete(id)
          setClosing((latest) => {
            if (!latest.has(id)) return latest
            const copy = new Map(latest)
            copy.delete(id)
            return copy
          })
        }, THREAD_EXIT_MS + delay)
        timersRef.current.set(id, timer)
      })
      setClosing((curr) => {
        const next = new Map(curr)
        for (const [id, delay] of delays) next.set(id, delay)
        return next
      })
    }
  }, [shownIds, existingIds, resetKey, ready])

  useEffect(
    () => () => {
      initializedRef.current = false
      cancelAnimationFrame(rafOuterRef.current)
      cancelAnimationFrame(rafInnerRef.current)
      window.clearTimeout(enterTimerRef.current)
      for (const t of timersRef.current.values()) window.clearTimeout(t)
      timersRef.current.clear()
      closingIdsRef.current.clear()
    },
    [],
  )

  return useMemo(() => {
    const renderedIds = new Set<string>(shownIds)
    const stateOf = new Map<string, PresenceState>()
    const delayOf = new Map<string, number>()

    for (const id of shownIds) {
      stateOf.set(id, 'open')
    }
    justAdded.forEach((id, i) => {
      stateOf.set(id, 'entering')
      delayOf.set(id, Math.min(i * THREAD_STAGGER_STEP_MS, THREAD_STAGGER_MAX_MS))
    })
    for (const [id, delay] of entering) {
      if (shownIds.has(id)) {
        stateOf.set(id, 'entering')
        delayOf.set(id, delay)
      }
    }
    for (const [id, delay] of closing) {
      if (!keyChanged && !shownIds.has(id) && existingIds.has(id)) {
        renderedIds.add(id)
        stateOf.set(id, 'closing')
        delayOf.set(id, delay)
      }
    }
    justRemoved.forEach((id, i) => {
      if (!shownIds.has(id) && existingIds.has(id)) {
        renderedIds.add(id)
        stateOf.set(id, 'closing')
        delayOf.set(id, Math.min(i * THREAD_STAGGER_STEP_MS, THREAD_STAGGER_MAX_MS))
      }
    })

    return { renderedIds, stateOf, delayOf }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds, existingIds, entering, closing, keyChanged, addedKey, removedKey])
}
