import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import JSZip from 'jszip'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRINGS } from '../i18n/strings'
import { db } from '../data/db'
import { BACKUP_FORMAT, importBackup } from '../data/backup'
import { App } from './App'
import { RootBoundary, resetPreferences } from './RootBoundary'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom's Blob can neither be read as an ArrayBuffer nor stored in (fake) IndexedDB; browsers' can.
beforeAll(() => vi.stubGlobal('Blob', NodeBlob))

async function tinyEpub(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('c.opf', '<package><metadata/><manifest/></package>')
  return zip.generateAsync({ type: 'uint8array' })
}

const card = (id: string, kind: string) => ({
  id, bookId: 'b1', color: 'coral', kind, anchors: [{ id: 'a1', sourceType: 'epub_text', bookId: 'b1', pageNumber: 1, selectedText: 'x', lineRects: [], boundingRect: { x: 0, y: 0, width: 0, height: 0 } }],
  x: 0, y: 0, width: 390, isPinned: false, collapsed: false, messages: [{ id: 'm1', role: 'user', content: 'Soru', createdAt: 1 }], createdAt: 1, updatedAt: 1,
})

/** The backup the audit described: a language that does not exist, a null author, an unknown thread kind. */
async function hostileBackup(): Promise<Blob> {
  const zip = new JSZip()
  zip.file('peryda.json', JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: 1,
    books: [{ id: 'b1', title: 'Kenar', author: null, format: 'epub', pageCount: 3, size: 1, fingerprint: 'not-the-file', addedAt: 1, openedAt: 0 }],
    cards: [card('good', 'coral'), card('bad', 'zz-kind'), { ...card('worse', 'coral'), color: 'neon' }],
    journal: [{ id: 'j1', bookId: 'b1', source: 'clip', quote: 'q', text: 't', pageNumber: 1, createdAt: 1 }, { id: 'j2', bookId: 'b1', source: 'virus', quote: 'q', text: 't', pageNumber: 1, createdAt: 1 }],
    positions: [{ bookId: 'b1', cfi: 'epubcfi(/6/2)', panX: 'x', panY: 0, scale: -1, page: 0, updatedAt: 1 }],
    prefs: [
      { key: 'lang', value: 'zz' },
      { key: 'theme', value: 'neon' },
      { key: 'rememberKeys', value: false },
      { key: 'welcomed', value: true },
      { key: 'epubFontScale', value: 9000 },
      { key: 'pagedReading', value: true },
      { key: 'explainTerms', value: false },
      { key: 'translateLang:b1', value: 'de' },
      { key: 'translateLang:someone-else', value: 'de' },
      { key: 'journalSummary:b1', value: { text: 42 } },
    ],
  }))
  zip.file('books/b1.epub', await tinyEpub())
  return zip.generateAsync({ type: 'blob' })
}

let root: Root | null = null
let host: HTMLElement

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  expect(check()).toBe(true)
}

async function renderApp() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<RootBoundary><App /></RootBoundary>))
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.prefs.put({ key: 'welcomed', value: true })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
})

describe('a hostile backup', () => {
  it('imports only what is valid, and the library still opens', async () => {
    expect(await importBackup(await hostileBackup())).toEqual({ books: 1 })
    const book = await db.books.get('b1')
    expect(book).toMatchObject({ author: '', title: 'Kenar', size: (await tinyEpub()).byteLength })
    expect(book!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect((await db.cards.toArray()).map((c) => c.id)).toEqual(['good'])
    expect((await db.journal.toArray()).map((j) => j.id)).toEqual(['j1'])
    expect(await db.positions.get('b1')).toMatchObject({ panX: 0, scale: 1, page: 1, cfi: 'epubcfi(/6/2)' })
    const prefs = Object.fromEntries((await db.prefs.toArray()).map((p) => [p.key, p.value]))
    expect(prefs).toEqual({ welcomed: true, pagedReading: true, explainTerms: false, 'translateLang:b1': 'de' })

    // Even with bad values already stored (an older version, a broken profile), the app starts.
    await db.prefs.bulkPut([{ key: 'lang', value: 'zz' }, { key: 'theme', value: { x: 1 } }, { key: 'openBookId', value: { id: 'b1' } }])
    await renderApp()
    await waitFor(() => Boolean(host.querySelector('.book-title')))
    expect(host.querySelector('.library-title')?.textContent).toBe('Library')
    expect(host.querySelector('.book-title')?.textContent).toBe('Kenar')
    expect(host.querySelector('.root-error')).toBeNull()
  })

  it('a backup whose ids are malformed is refused as a whole', async () => {
    const zip = new JSZip()
    zip.file('peryda.json', JSON.stringify({ format: BACKUP_FORMAT, version: 1, books: [{ id: '../b1', title: 'x', author: '', format: 'pdf' }], cards: [], journal: [], positions: [], prefs: [{ key: 'theme', value: 'dark' }] }))
    zip.file('books/../b1.pdf', '%PDF')
    await expect(importBackup(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow()
    const ok = new JSZip()
    ok.file('peryda.json', JSON.stringify({ format: BACKUP_FORMAT, version: 1, books: [{ id: 'b2', title: 'x', author: '', format: 'pdf' }], cards: [{ ...card('c', 'coral'), bookId: 'b2"]' }], journal: [], positions: [], prefs: [] }))
    ok.file('books/b2.pdf', '%PDF')
    await expect(importBackup(await ok.generateAsync({ type: 'blob' }))).rejects.toThrow()
    expect(await db.books.count()).toBe(0)
    expect(await db.prefs.get('theme')).toBeUndefined()
  })
})

describe('safe start', () => {
  it('a book that never finished opening is not opened again; the library says so', async () => {
    await db.books.add({ id: 'b1', title: 'Kenar', author: '', format: 'epub', pageCount: 1, size: 1, fingerprint: 'f', addedAt: 1, openedAt: 0 })
    await db.prefs.bulkPut([{ key: 'openBookId', value: 'b1' }, { key: 'openingBookId', value: 'b1' }])
    await renderApp()
    await waitFor(() => Boolean(host.querySelector('.library-title')))
    expect(host.querySelector('.toast')?.textContent).toBe(STRINGS.en.lastOpenFailed)
    expect(await db.prefs.get('openingBookId')).toMatchObject({ value: null })
    expect(await db.prefs.get('openBookId')).toMatchObject({ value: null })
  })
})

describe('the root safety net', () => {
  it('offers a way out instead of a blank page, and resets only preferences', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const Broken = () => {
      throw new Error('broken')
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<RootBoundary><Broken /></RootBoundary>))
    quiet.mockRestore()
    const buttons = [...host.querySelectorAll('button')].map((b) => b.textContent)
    expect(buttons).toEqual(['Export backup · Yedeği dışa aktar', 'Reset preferences · Tercihleri sıfırla', 'Reload · Yeniden yükle'])

    await db.books.add({ id: 'b1', title: 'Kenar', author: '', format: 'epub', pageCount: 1, size: 1, fingerprint: 'f', addedAt: 1, openedAt: 0 })
    await db.prefs.bulkPut([{ key: 'lang', value: 'zz' }, { key: 'rememberKeys', value: false }, { key: 'openBookId', value: 'b1' }])
    await resetPreferences()
    expect((await db.prefs.toArray()).map((p) => p.key).sort()).toEqual(['rememberKeys', 'welcomed'])
    expect(await db.books.count()).toBe(1)
  })
})
