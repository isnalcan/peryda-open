import { useCallback, useEffect, useState } from 'react'
import tokens from '@shared/tokens.json'
import { getPref, setPref } from '../data/db'
import type { Strings } from '../i18n/strings'

/**
 * The reader's highlighter colours (owner, 16 Nov): "Vurgula" uses the current one; holding it for two
 * seconds (or a right-click) offers all four. A journal entry names its colour in `highlightColor`; an
 * entry without one is yellow (every highlight made before the colours were offered). Same on the Mac.
 */
export type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue'

export const HIGHLIGHT_COLORS = tokens.highlighter.order as HighlightColor[]

/** How long "Vurgula" is held before the colours open (the owner's number). */
export const HIGHLIGHT_HOLD_MS = 2000

export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === 'string' && (HIGHLIGHT_COLORS as string[]).includes(value)
}

/** An entry's colour; yellow when it names none (or one this version does not know). */
export function highlightColorOf(entry: { highlightColor?: unknown }): HighlightColor {
  return isHighlightColor(entry.highlightColor) ? entry.highlightColor : 'yellow'
}

/** The colour's name in the interface language. */
export function highlightColorName(color: HighlightColor, t: Strings): string {
  switch (color) {
    case 'green':
      return t.highlightGreen
    case 'pink':
      return t.highlightPink
    case 'blue':
      return t.highlightBlue
    default:
      return t.highlightYellow
  }
}

/** The colour "Vurgula" uses now, kept for the whole app (pref `highlightColor`). */
export function useHighlightColor(): [HighlightColor, (color: HighlightColor) => void] {
  const [color, setColor] = useState<HighlightColor>('yellow')
  useEffect(() => {
    let live = true
    void getPref<unknown>('highlightColor', 'yellow').then((saved) => {
      if (live && isHighlightColor(saved)) setColor(saved)
    })
    return () => {
      live = false
    }
  }, [])
  const choose = useCallback((next: HighlightColor) => {
    setColor(next)
    void setPref('highlightColor', next)
  }, [])
  return [color, choose]
}
