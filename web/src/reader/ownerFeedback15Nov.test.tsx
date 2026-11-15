import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { db, type JournalRecord } from '../data/db'
import { DEFAULT_SETTINGS } from '../ai/provider'
import { validJournal, validPref, MAX_MARKS, MAX_MARK_RECTS } from '../data/backupValidate'
import { SelectionMenu } from '../ilmek/SelectionMenu'
import { journalContent, isPictureArea } from '../ilmek/useThreadActions'
import type { PdfYarnAnchor, YarnCard } from '../ilmek/types'
import { JournalPanel } from '../journal/JournalPanel'
import { TranslateMenu } from './ReaderControls'
import { TranslatedPageView } from './TranslatedPageView'

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
})
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
})
const buttons = () => Array.from(host.querySelectorAll('button'))
const byLabel = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label)

const rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.02 }
function anchor(sourceType: PdfYarnAnchor['sourceType'], extra: Partial<PdfYarnAnchor> = {}): PdfYarnAnchor {
  return { id: `a-${sourceType}`, sourceType, bookId: 'b', pageNumber: 3, selectedText: 'takes in the conduct of life … Hfe', lineRects: [rect], boundingRect: rect, ...extra }
}
function card(anchors: PdfYarnAnchor[]): YarnCard {
  return {
    id: 'c1', bookId: 'b', color: 'coral', kind: 'coral', anchors, x: 0, y: 0, width: 400, isPinned: false, collapsed: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: 'm1', role: 'user', content: 'ÖRNEK', createdAt: 1 }, { id: 'm2', role: 'assistant', content: 'Adler bu kapanış cümlesinde…', createdAt: 2 }],
  } as YarnCard
}

// Owner test 15 Nov (A): a page area is shown by its picture; its OCR'd text is not a quote.
describe('Area threads', () => {
  it('use the area label in the journal, not the text read from the scan', () => {
    const area = anchor('pdf_area', { croppedImage: 'data:image/png;base64,AAAA' })
    expect(isPictureArea(area)).toBe(true)
    expect(journalContent(card([area]), 'Sayfadan seçilen alan').quote).toBe('Sayfadan seçilen alan')
    expect(journalContent(card([anchor('pdf_text')]), 'Sayfadan seçilen alan').quote).toContain('takes in the conduct')
  })
})

// (C) Translated pages: A− and A+ left of Retranslate.
describe('Translated page text size', () => {
  it('offers A− and A+ before Retranslate and steps within the limits', async () => {
    const step = vi.fn()
    const translation = { ...card([anchor('pdf_text')]), translatedPage: 1, translationLanguage: 'tr', kind: 'translate', color: 'sky' } as YarnCard
    await render(<TranslatedPageView card={translation} x={0} y={0} onHeight={() => {}} onRetranslate={() => {}} onTranslateNow={() => {}} onRemove={() => {}} onOpenSettings={() => {}} textScale={1} onTextScale={step} />)
    const actions = Array.from(host.querySelectorAll('.translated-page-actions button')).map((b) => b.getAttribute('aria-label'))
    expect(actions).toEqual(['Yazıyı küçült', 'Yazıyı büyüt', 'Yeniden çevir', 'Kapat'])
    await act(async () => byLabel('Yazıyı büyüt')!.click())
    expect(step).toHaveBeenCalledWith(1)
    expect(validPref({ key: 'translationTextScale:b', value: 1.3 }, new Set(['b']))).toEqual({ key: 'translationTextScale:b', value: 1.3 })
    expect(validPref({ key: 'translationTextScale:b', value: 9 }, new Set(['b']))).toBeNull()
  })
})

// (D) "Vurgula" between "Özete kırp" and "Notum", for PDF text only.
describe('Highlight', () => {
  const menu = (canHighlight: boolean, onHighlight = vi.fn()) => (
    <SelectionMenu anchorRect={{ left: 0, top: 0, right: 10, bottom: 10 }} bounds={{ width: 800, height: 600 }} bridgeHeld={false} canClip canHighlight={canHighlight} onHighlight={onHighlight}
      onQuick={() => {}} onAsk={() => {}} onNote={() => {}} onBridge={() => {}} onBridgeCompare={() => {}} onClip={() => {}} onTranslate={() => {}} onClose={() => {}} />
  )

  it('sits between Clip and My note, and only when offered', async () => {
    const onHighlight = vi.fn()
    await render(menu(true, onHighlight))
    const tools = Array.from(host.querySelectorAll('.menu-tool')).map((b) => b.getAttribute('aria-label'))
    const clip = tools.indexOf('Özete kırp')
    expect(tools.slice(clip, clip + 3)).toEqual(['Özete kırp', 'Vurgula', 'Notum'])
    await act(async () => byLabel('Vurgula')!.click())
    expect(onHighlight).toHaveBeenCalledOnce()
    act(() => root.unmount())
    host.remove()
    await render(menu(false))
    expect(byLabel('Vurgula')).toBeUndefined()
  })

  it('keeps valid marks from a backup and refuses bad ones', () => {
    const pages = new Map([['b', 10]])
    const raw = { id: 'j1', bookId: 'b', source: 'highlight', quote: 'Kavramlar', text: '', pageNumber: 2, createdAt: 1 }
    const kept = validJournal({ ...raw, marks: [{ pageNumber: 2, lineRects: [rect, { x: 2, y: 0, width: 1, height: 1 }] }, { pageNumber: 99, lineRects: [rect] }] }, pages)!
    expect(kept.source).toBe('highlight')
    expect(kept.marks).toEqual([{ pageNumber: 2, lineRects: [rect] }])
    const many = validJournal({ ...raw, marks: Array.from({ length: 80 }, () => ({ pageNumber: 2, lineRects: Array.from({ length: 300 }, () => rect) })) }, pages)!
    expect(many.marks).toHaveLength(MAX_MARKS)
    expect(many.marks![0]!.lineRects).toHaveLength(MAX_MARK_RECTS)
    expect(validJournal({ ...raw, marks: 'nonsense' }, pages)!.marks).toBeUndefined()
    // An older entry with no marks stays valid.
    expect(validJournal({ ...raw, source: 'clip' }, pages)!.source).toBe('clip')
  })
})

// (E) The journal shows a thread's passage; Pery's answer opens on a click. (D) Highlights read as highlights.
describe('Book Journal', () => {
  it('collapses answers, opens them on click, and marks highlights', async () => {
    await db.journal.clear()
    const entries: JournalRecord[] = [
      { id: 't', bookId: 'b', source: 'thread', quote: 'Bir metni gerçekten okumak', text: 'Pery yanıtı burada.', pageNumber: 1, createdAt: 3 },
      { id: 'h', bookId: 'b', source: 'highlight', quote: 'Dikkat sınırlı bir kaynaktır.', text: '', pageNumber: 1, marks: [{ pageNumber: 1, lineRects: [rect] }], createdAt: 2 },
      { id: 'n', bookId: 'b', source: 'note', quote: '', text: 'Kendi notum.', pageNumber: 1, createdAt: 1 },
    ]
    await db.journal.bulkPut(entries)
    await render(<JournalPanel bookId="b" bookTitle="Kitap" settings={DEFAULT_SETTINGS} onOpenSettings={() => {}} onClose={() => {}} />)
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(host.textContent).toContain('Bir metni gerçekten okumak')
    expect(host.textContent).not.toContain('Pery yanıtı burada.')
    expect(host.textContent).toContain('Kendi notum.')
    expect(host.querySelector('.journal-quote.is-highlight mark')?.textContent).toBe('Dikkat sınırlı bir kaynaktır.')
    expect(host.textContent).toContain('Vurgu')
    const toggle = buttons().find((b) => b.textContent?.includes("Pery'nin yanıtını göster"))!
    await act(async () => toggle.click())
    expect(host.textContent).toContain('Pery yanıtı burada.')
    await act(async () => buttons().find((b) => b.textContent?.includes('Yanıtı gizle'))!.click())
    expect(host.textContent).not.toContain('Pery yanıtı burada.')
  })
})

// (F) Turning "explain terms" on or off leaves the options menu open.
describe('Translation options', () => {
  it('stay open when the terms setting is changed, and close on an action', async () => {
    const onExplain = vi.fn()
    const onRange = vi.fn()
    await render(<TranslateMenu target="tr" pending={0} onStop={() => {}} onTranslate={() => {}} explainTerms onExplainTerms={onExplain} onRange={onRange} onExtract={() => {}} />)
    await act(async () => host.querySelector<HTMLButtonElement>('.split-more')!.click())
    const terms = () => host.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')
    await act(async () => terms()!.click())
    expect(onExplain).toHaveBeenCalledWith(false)
    expect(terms()).not.toBeNull()
    await act(async () => buttons().find((b) => b.textContent?.startsWith('Sayfa aralığını çevir'))!.click())
    expect(onRange).toHaveBeenCalledOnce()
    expect(terms()).toBeNull()
  })
})
