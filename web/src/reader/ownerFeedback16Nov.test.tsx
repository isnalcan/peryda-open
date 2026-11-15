import 'fake-indexeddb/auto'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { I18nProvider } from '../i18n/I18n'
import { db, getPref, PER_BOOK_PREFS, setPref } from '../data/db'
import { validPref } from '../data/backupValidate'
import { DEFAULT_SETTINGS } from '../ai/provider'
import { YarnCardView } from '../ilmek/YarnCardView'
import type { PdfYarnAnchor, YarnCard } from '../ilmek/types'
import { JournalPanel } from '../journal/JournalPanel'
import type { PageReading, PageReadingsStore } from '../reading/pageReadings'
import { TranslateMenu } from './ReaderControls'
import { ExtractTextDialog } from './ReaderDialogs'
import { cameraForTranslation } from './useCamera'

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
const buttons = () => Array.from(host.querySelectorAll('button'))
const byLabel = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)))

const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.02 }
function anchor(sourceType: PdfYarnAnchor['sourceType'], extra: Partial<PdfYarnAnchor> = {}): PdfYarnAnchor {
  return { id: `a-${sourceType}`, sourceType, bookId: 'b', pageNumber: 3, selectedText: 'Kavramlar sınırlarda netleşir.', lineRects: [rect], boundingRect: rect, ...extra }
}
function card(anchors: PdfYarnAnchor[]): YarnCard {
  return {
    id: 'c1', bookId: 'b', color: 'coral', kind: 'coral', anchors, x: 0, y: 0, width: 400, isPinned: false, collapsed: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: 'm1', role: 'user', content: 'ÖRNEK', createdAt: 1 }, { id: 'm2', role: 'assistant', content: 'Pery yanıtı burada.', createdAt: 2 }],
  } as YarnCard
}
const noop = () => {}
function cardView(c: YarnCard, extra: Partial<React.ComponentProps<typeof YarnCardView>> = {}) {
  return (
    <YarnCardView card={c} x={0} y={0} scale={() => 1} onHeight={noop} onAsk={noop} onRetry={noop} onStop={noop} onRemove={noop} onMove={noop} onUnpin={noop}
      onCollapse={noop} onOpenSettings={noop} onFocusCard={noop} onSaveToJournal={noop} {...extra} />
  )
}

// (1) A card is the conversation alone: the passage is already marked where it was chosen.
describe('Thread cards', () => {
  it('do not quote the passage, but an area keeps its picture', async () => {
    await render(cardView(card([anchor('pdf_text'), { ...anchor('card'), id: 'a2', selectedText: 'İkinci pasaj.' }])))
    expect(host.textContent).toContain('Pery yanıtı burada.')
    expect(host.textContent).not.toContain('Kavramlar sınırlarda netleşir.')
    expect(host.textContent).not.toContain('İkinci pasaj.')
    expect(host.textContent).not.toContain('Tamamını göster')
    act(() => root.unmount())
    host.remove()
    await render(cardView(card([anchor('pdf_area', { croppedImage: 'data:image/png;base64,AAAA' })])))
    expect(host.querySelector('img.yarn-card-image')).not.toBeNull()
    expect(host.textContent).not.toContain('Kavramlar sınırlarda netleşir.')
  })

  it('beside an EPUB, lead back to the passage from their title', async () => {
    const onQuoteClick = vi.fn()
    await render(cardView(card([anchor('epub_text', { cfi: 'epubcfi(/6/2!/4/2)' })]), { layout: 'column', onQuoteClick }))
    const title = host.querySelector<HTMLButtonElement>('button.yarn-card-title')
    expect(title).not.toBeNull()
    await act(async () => title!.click())
    expect(onQuoteClick).toHaveBeenCalledWith('c1')
  })
})

// (2) "Explain terms" turns on and off, the tick follows it, and the options stay open.
describe('Translation options', () => {
  it('flip the terms setting both ways without closing', async () => {
    const saved: boolean[] = []
    function Host() {
      const [on, setOn] = useState(true)
      return (
        <TranslateMenu target="tr" pending={0} onStop={noop} onTranslate={noop} onRange={noop} onExtract={noop} explainTerms={on}
          onExplainTerms={(next) => {
            saved.push(next)
            setOn(next)
          }} />
      )
    }
    await render(<Host />)
    await act(async () => host.querySelector<HTMLButtonElement>('.split-more')!.click())
    const terms = () => host.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')
    expect(terms()!.getAttribute('aria-checked')).toBe('true')
    await act(async () => terms()!.click())
    expect(terms()!.getAttribute('aria-checked')).toBe('false')
    expect(terms()!.querySelector('svg')).toBeNull()
    await act(async () => terms()!.click())
    expect(terms()!.getAttribute('aria-checked')).toBe('true')
    expect(terms()!.querySelector('svg')).not.toBeNull()
    expect(saved).toEqual([false, true])
    // A press inside the menu does not close it; one outside does.
    await act(async () => terms()!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(terms()).not.toBeNull()
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(terms()).toBeNull()
  })
})

// (3) Translating keeps the reader's zoom and height; only sideways does the view move.
describe('The camera for a new translation', () => {
  const c = { x: 100, y: -340, s: 0.6 }
  it('keeps the zoom and the height, and centres page and translation when both fit', () => {
    const next = cameraForTranslation(c, 1400, { pageLeft: 0, translationLeft: 820, right: 1580 })
    expect(next.s).toBe(0.6)
    expect(next.y).toBe(-340)
    // 1580 × 0.6 = 948 px fits in 1400 − 48: the span's middle (790) comes to the window's middle.
    expect(700 - next.x).toBeCloseTo(790 * 0.6)
  })
  it('brings the translation\'s left edge to the middle when both do not fit', () => {
    const zoomed = { ...c, s: 1.2 }
    const next = cameraForTranslation(zoomed, 1400, { pageLeft: 0, translationLeft: 820, right: 1580 })
    expect(next.s).toBe(1.2)
    expect(next.y).toBe(-340)
    expect(next.x + 820 * 1.2).toBeCloseTo(700)
  })
})

// (4) "Kopyala" copies the page shown; the extras appear only once Pery has read more than one page.
describe('Extract text', () => {
  const doc = {
    numPages: 3,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Sayfanın kendi metni burada, kırk harften uzun bir satır olarak.', hasEOL: false, transform: [1, 0, 0, 1, 0, 0], width: 300 }] }) }),
  } as unknown as PDFDocumentProxy
  const readings = (list: PageReading[]) =>
    ({ subscribe: () => () => {}, getSnapshot: () => list, read: vi.fn(), readNow: vi.fn(), stop: vi.fn(), isWaitingForBatch: () => false }) as unknown as PageReadingsStore

  it('offers a plain Copy, and the read pages only when there are several', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await render(<ExtractTextDialog doc={doc} page={1} bookTitle="Kitap" readings={readings([])} onOpenSettings={noop} onClose={noop} />)
    await settle()
    expect(buttons().some((b) => b.textContent === 'Tümünü kopyala')).toBe(false)
    const copy = buttons().find((b) => b.textContent === 'Kopyala')!
    expect(copy).toBeDefined()
    await act(async () => copy.click())
    await settle()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Sayfanın kendi metni'))
    expect(buttons().some((b) => b.textContent === 'Kopyalandı')).toBe(true)
    expect(buttons().some((b) => b.textContent === 'Çıkarılan tüm sayfaları kopyala')).toBe(false)
    act(() => root.unmount())
    host.remove()
    const two: PageReading[] = [
      { page: 1, text: 'Birinci sayfa.', state: 'done', createdAt: 1 },
      { page: 2, text: 'İkinci sayfa.', state: 'done', createdAt: 2 },
    ]
    await render(<ExtractTextDialog doc={doc} page={1} bookTitle="Kitap" readings={readings(two)} onOpenSettings={noop} onClose={noop} />)
    await settle()
    // One "Kopyala", now with an arrow; the read pages are in its menu only.
    expect(buttons().filter((b) => b.textContent === 'Kopyala')).toHaveLength(1)
    expect(buttons().some((b) => b.textContent === 'Çıkarılan tüm sayfaları kopyala')).toBe(false)
    const arrow = host.querySelector<HTMLButtonElement>('.copy-split-more')!
    expect(arrow.getAttribute('aria-haspopup')).toBe('menu')
    await act(async () => arrow.click())
    const items = Array.from(host.querySelectorAll('.copy-split [role="menuitem"]')).map((b) => b.textContent)
    expect(items).toEqual(['Çıkarılan tüm sayfaları kopyala', 'Çıkarılan tüm sayfaları kaydet…'])
    writeText.mockClear()
    await act(async () => buttons().find((b) => b.textContent === 'Çıkarılan tüm sayfaları kopyala')!.click())
    await settle()
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/Birinci sayfa\.[\s\S]*İkinci sayfa\./))
    expect(host.querySelector('.copy-split [role="menu"]')).toBeNull()
    // The main part still copies the page shown.
    writeText.mockClear()
    await act(async () => host.querySelector<HTMLButtonElement>('.copy-split-main')!.click())
    await settle()
    expect(writeText).toHaveBeenCalledWith('Birinci sayfa.')
  })
})

// (5) A long question grows the field to about four lines, then scrolls inside it; it never widens the menu.
describe('Question fields', () => {
  it('stop growing at four lines and never widen', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    const rule = /\.yarn-card-footer textarea,\s*\.selection-menu-ask textarea \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toContain('max-height: calc(4lh + 10px)')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('width: 0')
    expect(rule).toContain('overflow-wrap: anywhere')
  })
})

// (6) Pery's summary folds to its title row (kept per book) and can be deleted.
describe('Journal summary', () => {
  it('folds, remembers it, and is deleted after asking', async () => {
    await db.journal.clear()
    await setPref('journalSummary:b', { text: 'Kitabın özeti burada.', createdAt: 1 })
    await setPref('summaryCollapsed:b', false)
    await render(<JournalPanel bookId="b" bookTitle="Kitap" settings={DEFAULT_SETTINGS} onOpenSettings={noop} onClose={noop} />)
    await settle()
    expect(host.textContent).toContain('Kitabın özeti burada.')
    await act(async () => byLabel('Gizle')!.click())
    await settle()
    expect(host.textContent).not.toContain('Kitabın özeti burada.')
    expect(host.textContent).toContain("Pery'nin özeti")
    expect(await getPref('summaryCollapsed:b', false)).toBe(true)
    act(() => root.unmount())
    host.remove()
    await render(<JournalPanel bookId="b" bookTitle="Kitap" settings={DEFAULT_SETTINGS} onOpenSettings={noop} onClose={noop} />)
    await settle()
    expect(host.textContent).not.toContain('Kitabın özeti burada.')
    await act(async () => byLabel('Göster')!.click())
    expect(host.textContent).toContain('Kitabın özeti burada.')

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    await act(async () => byLabel('Özeti sil')!.click())
    expect(confirm).toHaveBeenCalledWith("Pery'nin özeti silinsin mi? Günlükteki kayıtlar kalır.")
    expect(host.textContent).toContain('Kitabın özeti burada.')
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    await act(async () => byLabel('Özeti sil')!.click())
    await settle()
    expect(host.textContent).not.toContain("Pery'nin özeti")
    expect(await getPref('journalSummary:b', null)).toBeNull()
  })

  it('keeps the fold per book, in backups and when the book is deleted', () => {
    expect(PER_BOOK_PREFS).toContain('summaryCollapsed')
    expect(validPref({ key: 'summaryCollapsed:b', value: true }, new Set(['b']))).toEqual({ key: 'summaryCollapsed:b', value: true })
    expect(validPref({ key: 'summaryCollapsed:b', value: 'yes' }, new Set(['b']))).toBeNull()
  })
})
