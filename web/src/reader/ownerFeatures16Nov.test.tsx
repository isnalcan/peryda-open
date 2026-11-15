import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS } from '../i18n/strings'
import { db, type BookRecord } from '../data/db'
import { validJournal, validPref } from '../data/backupValidate'
import { SelectionMenu } from '../ilmek/SelectionMenu'
import { BookInfoDialog, bookCounts, formatSize } from '../library/BookInfoDialog'
import { Library } from '../library/Library'
import { fold, findInText, foldQuery, pageTextFrom, rectsFor, searchDocument, type FindHit, type PageText } from './find'
import { FindBar } from './FindBar'
import { HIGHLIGHT_COLORS, HIGHLIGHT_HOLD_MS, highlightColorOf } from './highlightColors'
import { ThumbnailSidebar } from './ThumbnailSidebar'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
async function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<I18nProvider lang="tr">{node}</I18nProvider>))
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom has no pointer events; React reads them as mouse events.
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
const t = STRINGS.tr
const buttons = () => Array.from(host.querySelectorAll('button'))
const byLabel = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)))

// ---- 1. Find in the document ----

/** A pdf.js viewport at scale 1 for a 600 × 800 page (y grows downwards). */
const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }
const item = (str: string, x: number, baseline: number, width: number, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, baseline], width, hasEOL })

describe('Find: matching (Turkish-aware, accents and case ignored)', () => {
  it('folds İ I ı i together, removes accents and joins white space', () => {
    expect(fold('İstanbul ILIK Işık').text).toBe('istanbul ilik isik')
    expect(fold('Özet  \n çiçek').text).toBe('ozet cicek')
    expect(fold('ﬁkir').text).toBe('fikir')
    expect(foldQuery('  Gelişim   Psikolojisi ')).toBe('gelisim psikolojisi')
  })

  it('finds every match in text order, never overlapping, at the original positions', () => {
    const text = 'Işık ve ışık; IŞIK!'
    const found = findInText(text, 'isik')
    expect(found).toEqual([
      [0, 4],
      [8, 12],
      [14, 18],
    ])
    expect(findInText('aaaa', 'aa')).toHaveLength(2)
    expect(findInText('Kavram ilişkisi', '   ')).toEqual([])
    expect(findInText('bir\n\n  kavram', 'Bir Kavram')).toEqual([[0, 13]])
  })

  it('joins a page’s text items: touching pieces form a word, gaps and new lines are spaces', () => {
    const page = pageTextFrom([item('Gel', 100, 700, 15), item('işim', 115, 700, 20), item('kuramı', 140, 700, 30, true), item('Yeni', 100, 680, 20)], viewport)
    expect(page.text).toBe('Gelişim kuramı Yeni')
    const [s, e] = findInText(page.folded, 'gelişim')[0]!
    const rects = rectsFor(page, s, e)
    // Two runs: "Gel" and "işim", from x = 100 to 135 of 600, on the line whose baseline is 100 from the top.
    expect(rects).toHaveLength(2)
    expect(rects[0]!.x).toBeCloseTo(100 / 600)
    expect(rects[1]!.x + rects[1]!.width).toBeCloseTo(135 / 600)
    expect(rects[0]!.y).toBeCloseTo(90 / 800)
    expect(rects[0]!.height).toBeCloseTo(10 / 800)
    // Part of a run: by its share of the characters.
    const [a, b] = findInText(page.folded, 'kura')[0]!
    const part = rectsFor(page, a, b)
    expect(part[0]!.x).toBeCloseTo(140 / 600)
    expect(part[0]!.width).toBeCloseTo(((4 / 6) * 30) / 600)
  })

  it('searches the whole document page by page, keeping each page’s text for the next search', async () => {
    const texts: Record<number, ReturnType<typeof item>[]> = {
      1: [item('Dikkat sınırlı', 100, 700, 70)],
      2: [item('Bir', 100, 700, 15), item('dikkat', 120, 700, 30), item('DİKKAT', 160, 700, 30)],
    }
    const getTextContent = vi.fn(async (n: number) => ({ items: texts[n] }))
    const doc = {
      numPages: 2,
      getPage: async (n: number) => ({ getViewport: () => viewport, getTextContent: () => getTextContent(n) }),
    } as unknown as PDFDocumentProxy
    const cache = new Map<number, PageText>()
    const hits: FindHit[] = []
    await searchDocument(doc, 'dikkat', { signal: new AbortController().signal, cache, onHits: (h) => hits.push(...h) })
    expect(hits.map((h) => h.page)).toEqual([1, 2, 2])
    await searchDocument(doc, 'sınır', { signal: new AbortController().signal, cache, onHits: () => undefined })
    expect(getTextContent).toHaveBeenCalledTimes(2)
    const stopped = new AbortController()
    stopped.abort()
    const none: FindHit[] = []
    await searchDocument(doc, 'dikkat', { signal: stopped.signal, cache, onHits: (h) => none.push(...h) })
    expect(none).toEqual([])
  })
})

describe('Find: the bar', () => {
  it('shows "i / n" or "not found", and Enter, Shift+Enter and Escape act', async () => {
    const onNext = vi.fn()
    const onPrevious = vi.fn()
    const onClose = vi.fn()
    const props = { query: 'dikkat', onQuery: vi.fn(), count: 17, index: 2, searching: false, onNext, onPrevious, onClose }
    await render(<FindBar {...props} />)
    expect(host.querySelector('.find-count')?.textContent).toBe('3 / 17')
    const input = host.querySelector('input')!
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })))
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onNext).toHaveBeenCalledOnce()
    expect(onPrevious).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    await act(async () => root.render(<I18nProvider lang="tr"><FindBar {...props} count={0} index={-1} /></I18nProvider>))
    expect(host.querySelector('.find-count')?.textContent).toBe(t.findNone)
    expect(byLabel(t.findNext)?.disabled).toBe(true)
  })
})

// ---- 2. Book info ----

const book: BookRecord = { id: 'info-book', title: 'Gelişim Psikolojisi', author: 'Berk', format: 'pdf', pageCount: 412, size: 12_345_678, fingerprint: 'f-info', addedAt: Date.UTC(2026, 10, 14, 9, 30), openedAt: 0 }

describe('Book info', () => {
  it('reads sizes as Finder does: KB below one MB, MB with one decimal', () => {
    expect(formatSize(534_200, 'tr')).toBe('534 KB')
    expect(formatSize(12_345_678, 'tr')).toBe('12,3 MB')
    expect(formatSize(12_345_678, 'en')).toBe('12.3 MB')
    expect(formatSize(80, 'en')).toBe('1 KB')
  })

  it('counts threads (not page translations), journal entries and highlights', async () => {
    await db.cards.bulkPut([
      { id: 'i1', bookId: book.id, color: 'mint', kind: 'mint', anchors: [], messages: [], x: 0, y: 0, width: 390, isPinned: false, collapsed: false, createdAt: 1, updatedAt: 1 },
      { id: 'i2', bookId: book.id, color: 'sky', kind: 'translate', anchors: [], messages: [], x: 0, y: 0, width: 390, isPinned: false, collapsed: false, createdAt: 1, updatedAt: 1, translatedPage: 3, translationLanguage: 'tr' },
    ])
    await db.journal.bulkPut([
      { id: 'j1', bookId: book.id, source: 'clip', quote: 'q', text: '', pageNumber: 1, createdAt: 1 },
      { id: 'j2', bookId: book.id, source: 'highlight', quote: 'q', text: '', pageNumber: 1, createdAt: 2 },
    ])
    expect(await bookCounts(book.id)).toEqual({ threads: 1, journal: 2, highlights: 1 })
  })

  it('shows the file, its pages and dates, and the counts', async () => {
    await db.books.put(book)
    await render(<BookInfoDialog book={book} onClose={() => undefined} />)
    await settle()
    const text = host.textContent ?? ''
    for (const piece of [t.bookInfo, 'Gelişim Psikolojisi', 'Berk', 'PDF', '12,3 MB', '412', t.infoNeverOpened, t.infoThreads, t.infoHighlights]) expect(text).toContain(piece)
    expect(text).toContain('2026')
  })

  it('is offered on a book in the library, by its button and by a right-click', async () => {
    await db.books.put(book)
    await render(<Library onOpen={() => undefined} onOpenSettings={() => undefined} />)
    await settle()
    const tile = host.querySelector('.book-tile')!
    await act(async () => tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 60 })))
    const items = Array.from(host.querySelectorAll('.book-menu [role="menuitem"]')).map((b) => b.textContent)
    expect(items).toEqual([t.bookInfo, t.editInfo, t.deleteBook])
    await act(async () => (host.querySelector('.book-menu [role="menuitem"]') as HTMLButtonElement).click())
    expect(host.querySelector('.book-info-dialog')).not.toBeNull()
    expect(byLabel(t.bookInfo)).toBeDefined()
  })
})

// ---- 3. Four highlight colours ----

describe('Highlight colours', () => {
  const menu = (onHighlight = vi.fn(), color: (typeof HIGHLIGHT_COLORS)[number] = 'green') => (
    <SelectionMenu
      anchorRect={{ left: 0, top: 0, right: 10, bottom: 10 }}
      bounds={{ width: 800, height: 600 }}
      bridgeHeld={false}
      canClip
      canHighlight
      highlightColor={color}
      onHighlight={onHighlight}
      onQuick={() => undefined}
      onAsk={() => undefined}
      onNote={() => undefined}
      onBridge={() => undefined}
      onBridgeCompare={() => undefined}
      onClip={() => undefined}
      onTranslate={() => undefined}
      onClose={() => undefined}
    />
  )
  const vurgula = () => host.querySelector<HTMLButtonElement>('.menu-highlight')!

  it('a click highlights in the current colour, which the button shows', async () => {
    const onHighlight = vi.fn()
    await render(menu(onHighlight, 'green'))
    expect(vurgula().dataset.hl).toBe('green')
    expect(vurgula().title).toBe(t.highlightHold)
    await act(async () => vurgula().click())
    expect(onHighlight).toHaveBeenCalledWith('green')
    expect(host.querySelector('.highlight-swatches')).toBeNull()
  })

  it('held for two seconds it offers the four colours, and the press is not also a click', async () => {
    vi.useFakeTimers()
    const onHighlight = vi.fn()
    await render(menu(onHighlight, 'yellow'))
    await act(async () => vurgula().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    expect(vurgula().classList.contains('is-holding')).toBe(true)
    await act(async () => vi.advanceTimersByTime(HIGHLIGHT_HOLD_MS - 100))
    expect(host.querySelector('.highlight-swatches')).toBeNull()
    await act(async () => vi.advanceTimersByTime(150))
    const swatches = Array.from(host.querySelectorAll<HTMLButtonElement>('.highlight-swatch'))
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual([t.highlightYellow, t.highlightGreen, t.highlightPink, t.highlightBlue])
    expect(swatches[0]!.getAttribute('aria-checked')).toBe('true')
    await act(async () => vurgula().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })))
    await act(async () => vurgula().click())
    expect(onHighlight).not.toHaveBeenCalled()
    await act(async () => swatches[2]!.click())
    expect(onHighlight).toHaveBeenCalledWith('pink')
    expect(host.querySelector('.highlight-swatches')).toBeNull()
  })

  it('a short press is a normal click; a right-click opens the colours', async () => {
    vi.useFakeTimers()
    const onHighlight = vi.fn()
    await render(menu(onHighlight, 'blue'))
    await act(async () => vurgula().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    await act(async () => vi.advanceTimersByTime(500))
    await act(async () => vurgula().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })))
    await act(async () => vurgula().click())
    expect(onHighlight).toHaveBeenCalledWith('blue')
    await act(async () => vi.advanceTimersByTime(3000))
    expect(host.querySelector('.highlight-swatches')).toBeNull()
    await act(async () => vurgula().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
    expect(host.querySelectorAll('.highlight-swatch')).toHaveLength(4)
  })

  it('an entry keeps its colour through a backup; yellow is the colour of entries without one', () => {
    const raw = { id: 'h1', bookId: 'b1', source: 'highlight', quote: 'q', text: '', pageNumber: 1, createdAt: 1, marks: [{ pageNumber: 1, lineRects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }] }] }
    expect(validJournal({ ...raw, highlightColor: 'pink' })?.highlightColor).toBe('pink')
    expect(validJournal({ ...raw, highlightColor: 'purple' })?.highlightColor).toBeUndefined()
    expect(validJournal({ ...raw, highlightColor: 'yellow' })?.highlightColor).toBeUndefined()
    expect(highlightColorOf({})).toBe('yellow')
    expect(highlightColorOf({ highlightColor: 'blue' })).toBe('blue')
    expect(validPref({ key: 'highlightColor', value: 'green' }, new Set())).toEqual({ key: 'highlightColor', value: 'green' })
    expect(validPref({ key: 'highlightColor', value: 'red' }, new Set())).toBeNull()
  })
})

// ---- 4. Page thumbnails ----

describe('Page thumbnails', () => {
  it('lists every page, marks the current one and goes to a page on a click', async () => {
    const doc = { numPages: 3, getPage: async () => ({ getViewport: () => viewport, render: () => ({ promise: Promise.resolve() }) }) } as unknown as PDFDocumentProxy
    const onGoTo = vi.fn()
    // No canvas in jsdom: the thumbnails stay blank frames.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await render(<ThumbnailSidebar doc={doc} sizes={[[600, 800], [600, 800], [800, 600]]} current={2} onGoTo={onGoTo} />)
    const thumbs = Array.from(host.querySelectorAll<HTMLButtonElement>('.thumb'))
    expect(thumbs).toHaveLength(3)
    expect(thumbs.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'page', null])
    expect(host.querySelector('.thumbnail-sidebar')?.getAttribute('aria-label')).toBe(t.thumbnails)
    expect((thumbs[2]!.querySelector('.thumb-frame') as HTMLElement).style.aspectRatio).toBe('800 / 600')
    await act(async () => thumbs[2]!.click())
    expect(onGoTo).toHaveBeenCalledWith(3)
  })
})
