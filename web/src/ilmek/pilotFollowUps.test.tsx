import { act, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { escapeClosesJournal } from '../journal/JournalPanel'
import type { JournalRecord } from '../data/db'
import { LEFT_LANE_SINCE, MAX_BALANCED_ROOTS, layoutCards, type CardForLayout } from './lane'
import { matchingTranslationHighlights } from './threadMarks'
import { useThreadPresence, type ThreadPresence } from './useThreadPresence'

/** Follow-ups to the pilot UX changes (27 Nov 2026): the problems its review found, fixed. */

let host: HTMLDivElement | null = null
let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
})

describe('Escape in the Book Journal', () => {
  const key = (target: EventTarget | null, defaultPrevented = false) => ({ key: 'Escape', defaultPrevented, target })

  it('closes the panel from the page, and from inside it (even with an entry expanded)', () => {
    document.body.innerHTML = '<aside class="journal-panel"><button aria-expanded="true">entry</button></aside>'
    expect(escapeClosesJournal(key(document.body))).toBe(true)
    expect(escapeClosesJournal(key(document.querySelector('button')))).toBe(true)
  })

  it('never closes while typing, so a draft note is not thrown away', () => {
    document.body.innerHTML = '<aside class="journal-panel"><textarea></textarea><input /></aside><div contenteditable="true"><span>x</span></div>'
    expect(escapeClosesJournal(key(document.querySelector('textarea')))).toBe(false)
    expect(escapeClosesJournal(key(document.querySelector('input')))).toBe(false)
    expect(escapeClosesJournal(key(document.querySelector('span')))).toBe(false)
  })

  it('lets a menu, popover or dialog close first, and respects a handler that already used Escape', () => {
    document.body.innerHTML = '<div class="selection-menu"></div>'
    expect(escapeClosesJournal(key(document.body))).toBe(false)
    document.body.innerHTML = '<button aria-haspopup="menu" aria-expanded="true"></button>'
    expect(escapeClosesJournal(key(document.body))).toBe(false)
    document.body.innerHTML = '<div role="menu"></div>'
    expect(escapeClosesJournal(key(document.body))).toBe(false)
    document.body.innerHTML = ''
    expect(escapeClosesJournal(key(document.body, true))).toBe(false)
    expect(escapeClosesJournal({ key: 'Enter', defaultPrevented: false, target: document.body })).toBe(false)
  })
})

describe('"Remove highlight" on a translated page', () => {
  it('offers only highlights painted on the page now, never one whose text is gone', () => {
    const source = document.createElement('div')
    source.textContent = 'Aydınlanma, insanın kendi suçu ile düşmüş olduğu bir ergin olmama durumundan kurtulmasıdır.'
    document.body.append(source)
    const entry = (id: string, quote: string): JournalRecord =>
      ({ id, bookId: 'b', source: 'highlight', quote, text: '', pageNumber: 1, cardId: 'tp', createdAt: 1 }) as JournalRecord
    // "ergin" also appears inside the old quote, which is no longer in the (re-translated) text.
    const stored = [entry('visible', 'ergin olmama'), entry('gone', 'eski çeviride ergin kalmamak')]
    const range = document.createRange()
    const text = source.firstChild as Text
    range.setStart(text, 53)
    range.setEnd(text, 58)
    expect(matchingTranslationHighlights(source, null, range, 'ergin', 'tp', stored)).toEqual(['visible'])
    expect(matchingTranslationHighlights(source, null, null, 'ergin', 'tp', stored)).toEqual([])
  })
})

describe('Right and left margin lanes', () => {
  const PAGE = 760
  const LANE = PAGE + 75
  const card = (id: string, anchorY: number, createdAt: number, extra: Partial<CardForLayout> = {}): CardForLayout => ({
    id,
    isPinned: false,
    collapsed: false,
    x: 0,
    y: 0,
    width: 390,
    anchorY,
    height: 300,
    page: 1,
    createdAt,
    ...extra,
  })
  const sides = (cards: CardForLayout[]) => {
    const placed = layoutCards(cards, LANE, { pageWidth: PAGE })
    return Object.fromEntries([...placed].map(([id, p]) => [id, p.x < 0 ? 'left' : 'right']))
  }
  const NEW = LEFT_LANE_SINCE + 1000

  it('opens a new thread on the left when the right is crowded beside it', () => {
    expect(sides([card('a', 250, NEW), card('b', 280, NEW + 1)])).toEqual({ a: 'right', b: 'left' })
  })

  it('never moves threads from before the update: an older book opens as the reader left it', () => {
    const old = LEFT_LANE_SINCE - 10_000
    expect(sides([card('a', 250, old), card('b', 280, old + 1), card('c', 300, old + 2)])).toEqual({ a: 'right', b: 'right', c: 'right' })
  })

  it('stays fast with a huge (say crafted) number of threads: beyond the cap all open on the right', () => {
    const many = Array.from({ length: 5000 }, (_, i) => card(`m${i}`, 100 + (i % 50), NEW + i))
    const started = performance.now()
    const placed = layoutCards(many, LANE, { pageWidth: PAGE })
    expect(performance.now() - started).toBeLessThan(2000)
    expect([...placed.values()].every((p) => p.x === LANE)).toBe(true)
    expect(MAX_BALANCED_ROOTS).toBeLessThan(5000)
  })

  it('keeps every card on its side when an earlier thread is folded or its answer grows', () => {
    const cards = [card('a', 250, NEW), card('b', 280, NEW + 1), card('c', 310, NEW + 2), card('d', 340, NEW + 3)]
    const before = sides(cards)
    const folded = sides(cards.map((c) => (c.id === 'a' ? { ...c, collapsed: true } : c)))
    delete before.a
    expect(folded).toEqual(before)
    const grown = sides(cards.map((c) => (c.id === 'b' ? { ...c, height: 1400 } : c)))
    expect(grown).toEqual({ ...before, a: 'right' })
  })
})

describe('Threads already in a book do not replay their opening animation', () => {
  it('starts every saved thread open once the cards have loaded, and still animates a new one', async () => {
    let latest!: ThreadPresence
    let load!: () => void
    let add!: () => void
    function Harness() {
      const [ids, setIds] = useState<string[]>([])
      const [ready, setReady] = useState(false)
      load = () => {
        setIds(['x', 'y'])
        setReady(true)
      }
      add = () => setIds(['x', 'y', 'z'])
      const set = useMemo(() => new Set(ids), [ids])
      latest = useThreadPresence(set, set, 'default', ready)
      return null
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<Harness />))
    await act(async () => load())
    expect([...latest.stateOf.values()]).toEqual(['open', 'open'])
    await act(async () => add())
    expect(latest.stateOf.get('z')).toBe('entering')
    expect(latest.stateOf.get('x')).toBe('open')
  })
})

describe('Cards follow their yarns', () => {
  it('waits for the yarn only while a card is opening, not on every move', () => {
    const css = readFileSync(resolve(__dirname, '../styles/app.css'), 'utf8')
    const base = css.match(/\n\.yarn-card \{[^}]*\}/)?.[0] ?? ''
    const settling = css.match(/\n\.yarn-card\.is-settling \{[^}]*\}/)?.[0] ?? ''
    expect(base).toMatch(/transform 260ms/)
    expect(base).not.toMatch(/210ms/)
    expect(settling).toContain('transform 300ms var(--ease-out-strong) calc(var(--card-delay, 0ms) + 210ms)')
  })
})
