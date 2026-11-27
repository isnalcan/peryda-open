import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS } from '../i18n/strings'
import { db, type BookRecord, type JournalRecord } from '../data/db'
import { DEFAULT_SETTINGS } from '../ai/provider'
import { GEOMETRY, LANE_X, pageLayout } from '../ilmek/geometry'
import { SelectionMenu } from '../ilmek/SelectionMenu'
import { matchingPdfHighlights, matchingTranslationHighlights } from '../ilmek/threadMarks'
import { journalState, useThreadActions } from '../ilmek/useThreadActions'
import { TRANSLATION_GAP, placeCards } from '../ilmek/worldLayout'
import type { PdfYarnAnchor, YarnCard } from '../ilmek/types'
import { JournalPanel } from '../journal/JournalPanel'
import { Library } from '../library/Library'
import { ReaderTopBar } from './ReaderTopBar'
import { TranslatedPageView } from './TranslatedPageView'
import { cameraForFocus, cameraForMap } from './useCamera'

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
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)))

describe('Camera Focus and Map presets', () => {
  it('Focus caps desktop zoom at 100%, fits narrow mobile screens, and clamps vertical position inside the document', () => {
    const desktop = cameraForFocus({ x: 300, y: -900, s: 0.33 }, { width: 1440, height: 900 }, 780, { top: 0, bottom: 1009 })
    expect(desktop.s).toBe(1)
    expect(desktop.x).toBeCloseTo(1440 / 2 - 390)
    // Clamped within [900 - 24 - 1009, 24] = [-133, 24], never flying off-screen.
    expect(desktop.y).toBeGreaterThanOrEqual(-133)
    expect(desktop.y).toBeLessThanOrEqual(24)

    const mobile = cameraForFocus({ x: 0, y: 0, s: 1 }, { width: 390, height: 844 }, 780, { top: 0, bottom: 1009 })
    expect(mobile.s).toBeCloseTo((390 - 20) / 780)
    expect(780 * mobile.s).toBeLessThanOrEqual(370.1)
  })

  it('Map centres the full horizontal span of pages, threads and translations', () => {
    const bounds = { minX: 0, maxX: 2560, minY: 0, maxY: 1000 }
    const map = cameraForMap({ width: 1440, height: 900 }, bounds, { top: 0, bottom: 1000 })
    const midScreenX = map.x + ((bounds.minX + bounds.maxX) / 2) * map.s
    expect(midScreenX).toBeCloseTo(720)
    expect(map.s).toBeLessThanOrEqual(0.85)
  })
})

describe('Side-by-side translation when threads are hidden', () => {
  const pages = pageLayout([[612, 792]])
  const anchor: PdfYarnAnchor = {
    id: 'a1',
    sourceType: 'pdf_text',
    bookId: 'b',
    pageNumber: 1,
    selectedText: 'Sapere aude',
    lineRects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.02 }],
    boundingRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.02 },
  }
  const thread: YarnCard = {
    id: 't1',
    bookId: 'b',
    color: 'coral',
    kind: 'coral',
    anchors: [anchor],
    x: 0,
    y: 0,
    width: GEOMETRY.cardWidth,
    isPinned: false,
    collapsed: false,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }
  const translation: YarnCard = {
    ...thread,
    id: 'tr1',
    kind: 'translate',
    color: 'sky',
    translatedPage: 1,
    translationLanguage: 'tr',
    width: pages[0]!.width,
    height: pages[0]!.height,
    messages: [{ id: 'm1', role: 'assistant', content: 'Çeviri metni burada.', createdAt: 2 }],
  }

  it('moves the translation right beside the PDF page when threads are hidden, and offers the side-by-side toggle', async () => {
    const withThreads = placeCards({
      cards: [thread, translation],
      pages,
      heights: { t1: 240 },
      pagedReading: false,
      currentPage: 1,
      hideThreads: false,
      revealed: new Set(),
    })
    expect(withThreads.get('tr1')!.x).toBe(LANE_X + GEOMETRY.cardWidth + TRANSLATION_GAP)

    const hiddenThreads = placeCards({
      cards: [thread, translation],
      pages,
      heights: { t1: 240 },
      pagedReading: false,
      currentPage: 1,
      hideThreads: true,
      revealed: new Set(),
    })
    expect(hiddenThreads.get('tr1')!.x).toBe(pages[0]!.width + TRANSLATION_GAP)

    const onSideBySide = vi.fn()
    await render(
      <TranslatedPageView
        card={translation}
        x={0}
        y={0}
        onHeight={() => {}}
        onRetranslate={() => {}}
        onTranslateNow={() => {}}
        onRemove={() => {}}
        onOpenSettings={() => {}}
        onSideBySide={onSideBySide}
        sideBySideActive
      />,
    )
    const btn = host.querySelector<HTMLButtonElement>('.translated-side-button')!
    expect(btn.textContent).toBe(STRINGS.tr.focusLane)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    await act(async () => btn.click())
    expect(onSideBySide).toHaveBeenCalledOnce()
  })
})

describe('Highlighting in PDF translations and Remove highlight action', () => {
  it('saves and removes translated-page highlights without colliding with card journal state, and detects overlaps', async () => {
    await db.journal.clear()
    let api: ReturnType<typeof useThreadActions> | null = null
    const translationCard: YarnCard = {
      id: 'tp-card',
      bookId: 'b1',
      color: 'sky',
      kind: 'translate',
      anchors: [],
      x: 0,
      y: 0,
      width: 780,
      isPinned: false,
      collapsed: false,
      translatedPage: 1,
      translationLanguage: 'tr',
      messages: [{ id: 'm1', role: 'assistant', content: 'Aydınlanma, insanın kendi suçu ile düşmüş olduğu bir ergin olmama durumundan kurtulmasıdır.', createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1,
    }
    function Harness() {
      api = useThreadActions({ bookId: 'b1', cards: [translationCard], t: STRINGS.tr })
      return null
    }
    await render(<Harness />)
    await settle()

    const selAnchor: PdfYarnAnchor = {
      id: 'a-sel',
      sourceType: 'card',
      bookId: 'b1',
      pageNumber: 1,
      selectedText: 'ergin olmama durumundan',
      lineRects: [],
      boundingRect: { x: 10, y: 80, width: 120, height: 18 },
      sourceCardId: 'tp-card',
    }
    await act(async () => {
      await api!.highlight([selAnchor], 'green', { pageNumber: 1, cardId: 'tp-card' })
    })
    await settle()

    const stored = await db.journal.where('bookId').equals('b1').toArray()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ source: 'highlight', cardId: 'tp-card', pageNumber: 1, highlightColor: 'green', quote: 'ergin olmama durumundan' })
    expect(journalState(translationCard, stored)).toBe('notSaved')
    expect(api!.highlightMarks).toHaveLength(0)
    // No PDF geometry: the Mac app draws every highlight mark on the PDF page itself.
    expect(stored[0]!.marks).toBeUndefined()

    const sourceDiv = document.createElement('div')
    sourceDiv.textContent = 'Aydınlanma, insanın kendi suçu ile düşmüş olduğu bir ergin olmama durumundan kurtulmasıdır.'
    document.body.append(sourceDiv)
    const range = document.createRange()
    const textNode = sourceDiv.firstChild as Text
    range.setStart(textNode, 53)
    range.setEnd(textNode, 65)
    const matchedTr = matchingTranslationHighlights(sourceDiv, null, range, 'ergin olmama', 'tp-card', stored)
    expect(matchedTr).toEqual([stored[0]!.id])
    sourceDiv.remove()

    await act(async () => {
      await api!.removeHighlights(matchedTr)
    })
    expect(await db.journal.where('bookId').equals('b1').count()).toBe(0)
  })

  it('detects overlapping PDF highlights and offers "Vurguyu kaldır" in SelectionMenu', async () => {
    const entries: JournalRecord[] = [
      {
        id: 'hl-pdf-1',
        bookId: 'b1',
        source: 'highlight',
        quote: 'Sapere aude',
        text: '',
        pageNumber: 2,
        marks: [{ pageNumber: 2, lineRects: [{ x: 0.1, y: 0.3, width: 0.4, height: 0.02 }] }],
        createdAt: 1,
      },
    ]
    const hitAnchor: PdfYarnAnchor = {
      id: 'a1',
      sourceType: 'pdf_text',
      bookId: 'b1',
      pageNumber: 2,
      selectedText: 'aude',
      lineRects: [{ x: 0.25, y: 0.302, width: 0.1, height: 0.02 }],
      boundingRect: { x: 0.25, y: 0.302, width: 0.1, height: 0.02 },
    }
    const missAnchor: PdfYarnAnchor = { ...hitAnchor, lineRects: [{ x: 0.1, y: 0.7, width: 0.2, height: 0.02 }] }
    expect(matchingPdfHighlights([hitAnchor], entries)).toEqual(['hl-pdf-1'])
    expect(matchingPdfHighlights([missAnchor], entries)).toEqual([])

    const onRemove = vi.fn()
    await render(
      <SelectionMenu
        anchorRect={{ left: 0, top: 0, right: 20, bottom: 20 }}
        bounds={{ width: 800, height: 600 }}
        bridgeHeld={false}
        canClip
        canHighlight
        onHighlight={() => {}}
        onRemoveHighlight={onRemove}
        onQuick={() => {}}
        onAsk={() => {}}
        onNote={() => {}}
        onBridge={() => {}}
        onBridgeCompare={() => {}}
        onClip={() => {}}
        onTranslate={() => {}}
        onClose={() => {}}
      />,
    )
    const btn = host.querySelector<HTMLButtonElement>('.menu-remove-highlight')!
    expect(btn.textContent).toBe('Vurguyu kaldır')
    await act(async () => btn.click())
    expect(onRemove).toHaveBeenCalledOnce()
  })
})

describe('EPUB journal labels, Escape handling, accessibility, pluralization and delete modal', () => {
  it('uses "Bölüm N" in EPUB JournalPanel, navigates on click, and closes on Escape', async () => {
    await db.journal.clear()
    await db.journal.put({ id: 'ej1', bookId: 'eb1', source: 'clip', quote: 'Pasaj', text: '', pageNumber: 2, createdAt: 1 })
    const onGoTo = vi.fn()
    const onClose = vi.fn()
    await render(<JournalPanel bookId="eb1" bookTitle="EPUB Kitap" settings={DEFAULT_SETTINGS} isEpub onGoToPage={onGoTo} onOpenSettings={() => {}} onClose={onClose} />)
    await settle()

    const jumpBtn = host.querySelector<HTMLButtonElement>('.journal-page-link')!
    expect(jumpBtn.textContent).toBe('Bölüm 2')
    await act(async () => jumpBtn.click())
    expect(onGoTo).toHaveBeenCalledWith(2)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('gives ReaderTopBar Back button an accessible label and singular/plural page counts across languages', async () => {
    await render(<ReaderTopBar title="Kitap" onBack={() => {}} onOpenSettings={() => {}} />)
    const backBtn = host.querySelector<HTMLButtonElement>('.reader-topbar > .ghost-button')!
    expect(backBtn.getAttribute('aria-label')).toBe('Kitaplık')

    expect(STRINGS.en.pages(1)).toBe('1 page')
    expect(STRINGS.en.pages(2)).toBe('2 pages')
    expect(STRINGS.de.pages(1)).toBe('1 Seite')
    expect(STRINGS.es.pages(1)).toBe('1 página')
  })

  it('uses an in-app alertdialog instead of window.confirm when deleting a book from Library', async () => {
    await db.books.clear()
    const b: BookRecord = { id: 'del-1', title: 'Silinecek Kitap', author: '', format: 'pdf', pageCount: 1, size: 100, fingerprint: 'fp1', addedAt: 1, openedAt: 1 }
    await db.books.put(b)
    const confirmSpy = vi.spyOn(window, 'confirm')
    await render(<Library onOpen={() => {}} onOpenSettings={() => {}} />)
    await settle()

    const delBtn = Array.from(host.querySelectorAll('button')).find((el) => el.getAttribute('aria-label') === STRINGS.tr.deleteBook)!
    await act(async () => delBtn.click())
    expect(confirmSpy).not.toHaveBeenCalled()

    const dialog = host.querySelector('dialog.delete-book-dialog')!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('alertdialog')
    expect(dialog.textContent).toContain('Silinecek Kitap')

    const confirmBtn = dialog.querySelector<HTMLButtonElement>('.is-danger-button')!
    await act(async () => confirmBtn.click())
    await settle()
    expect(await db.books.get('del-1')).toBeUndefined()
  })
})
