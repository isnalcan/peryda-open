// @vitest-environment node
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'
import { PerydaDB, db, deleteBook, type BookRecord } from '../data/db'
import { exportBackup } from '../data/backup'
import { MAX_COVER_ATTEMPTS, forgetCover, loadCover, peekCover } from './covers'

const V1_STORES = {
  books: 'id, fingerprint, openedAt, addedAt',
  files: 'bookId',
  cards: 'id, bookId, parentCardId, createdAt',
  positions: 'bookId',
  journal: 'id, bookId, createdAt, cardId',
  prefs: 'key',
  vault: 'id',
}

const bookRecord = (id: string, fingerprint: string, format: BookRecord['format'] = 'epub'): BookRecord => ({
  id,
  title: 'Kenar',
  author: '',
  format,
  pageCount: 3,
  size: 10,
  fingerprint,
  addedAt: 1,
  openedAt: 0,
})

/** An EPUB that names no cover picture. */
async function coverlessEpub(): Promise<Blob> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('content.opf', '<package><metadata/><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest></package>')
  return new Blob([await zip.generateAsync({ type: 'arraybuffer' })], { type: 'application/epub+zip' })
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('covers table', () => {
  it('upgrades a version-1 library without touching its data', async () => {
    const name = 'peryda-upgrade-test'
    await Dexie.delete(name)
    const old = new Dexie(name)
    old.version(1).stores(V1_STORES)
    await old.open()
    await old.table('books').add(bookRecord('b1', 'fp1', 'pdf'))
    await old.table('files').add({ bookId: 'b1', blob: new Blob(['%PDF'], { type: 'application/pdf' }) })
    await old.table('journal').add({ id: 'j1', bookId: 'b1', source: 'note', quote: '', text: 'not', pageNumber: 2, createdAt: 3 })
    await old.table('positions').put({ bookId: 'b1', panX: 1, panY: 2, scale: 1, page: 7, updatedAt: 4 })
    await old.table('prefs').put({ key: 'lang', value: 'tr' })
    old.close()

    const upgraded = new PerydaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBe(2)
    expect((await upgraded.books.get('b1'))?.fingerprint).toBe('fp1')
    expect((await upgraded.files.get('b1'))?.blob.size).toBe(4)
    expect((await upgraded.journal.get('j1'))?.text).toBe('not')
    expect((await upgraded.positions.get('b1'))?.page).toBe(7)
    expect((await upgraded.prefs.get('lang'))?.value).toBe('tr')
    await upgraded.covers.put({ bookId: 'b1', fingerprint: 'fp1', blob: null, width: 0, height: 0, createdAt: 5 })
    expect(await upgraded.covers.count()).toBe(1)
    upgraded.close()
    await Dexie.delete(name)
  })

  it('goes with the book when the book is deleted', async () => {
    await db.books.add(bookRecord('b2', 'fp2'))
    await db.covers.put({ bookId: 'b2', fingerprint: 'fp2', blob: new Blob(['x'], { type: 'image/jpeg' }), width: 3, height: 4, createdAt: 1 })
    await deleteBook('b2')
    expect(await db.covers.get('b2')).toBeUndefined()
  })

  it('is never part of a backup', async () => {
    await db.books.add(bookRecord('b3', 'fp3'))
    await db.files.add({ bookId: 'b3', blob: await coverlessEpub() })
    await db.covers.put({ bookId: 'b3', fingerprint: 'fp3', blob: new Blob(['cover-bytes'], { type: 'image/jpeg' }), width: 3, height: 4, createdAt: 1 })
    const zip = await JSZip.loadAsync(await (await exportBackup()).arrayBuffer())
    const entries = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name)
    expect(entries.sort()).toEqual(['books/b3.epub', 'peryda.json'])
    expect(await zip.file('peryda.json')!.async('string')).not.toContain('cover')
  })
})

describe('loadCover', () => {
  it('uses a stored cover made from the same file', async () => {
    const book = bookRecord('c1', 'fp-c1')
    await db.books.add(book)
    await db.covers.put({ bookId: 'c1', fingerprint: 'fp-c1', blob: new Blob(['jpeg'], { type: 'image/jpeg' }), width: 420, height: 560, createdAt: 1 })
    const cover = await loadCover(book)
    expect(cover).toMatchObject({ width: 420, height: 560 })
    expect(cover?.url).toMatch(/^blob:/)
    expect(peekCover(book)).toBe(cover)
  })

  it('remembers that a book has no cover, and looks again when the file changes', async () => {
    const book = bookRecord('c2', 'fp-new')
    await db.books.add(book)
    await db.files.add({ bookId: 'c2', blob: await coverlessEpub() })
    await db.covers.put({ bookId: 'c2', fingerprint: 'fp-old', blob: new Blob(['stale'], { type: 'image/jpeg' }), width: 420, height: 560, createdAt: 1 })
    expect(await loadCover(book)).toBeNull()
    expect(await db.covers.get('c2')).toMatchObject({ fingerprint: 'fp-new', blob: null })
  })

  it('never rejects, and remembers a failure so it is not tried at every launch', async () => {
    // No file at all.
    const missing = bookRecord('c3', 'fp-c3', 'pdf')
    await db.books.add(missing)
    await expect(loadCover(missing)).resolves.toBeNull()
    expect(await db.covers.get('c3')).toMatchObject({ blob: null, attempts: MAX_COVER_ATTEMPTS })

    // A file that is not a zip.
    const broken = bookRecord('c4', 'fp-c4')
    await db.books.add(broken)
    await db.files.add({ bookId: 'c4', blob: new Blob(['not a zip']) })
    await expect(loadCover(broken)).resolves.toBeNull()
    const failed = await db.covers.get('c4')
    expect(failed).toMatchObject({ blob: null, attempts: MAX_COVER_ATTEMPTS })

    // Next launch: not tried again, even though the file would now draw.
    forgetCover('c4')
    await db.files.put({ bookId: 'c4', blob: await coverlessEpub() })
    await expect(loadCover(broken)).resolves.toBeNull()
    expect(await db.covers.get('c4')).toEqual(failed)
  })

  it('a try that never finished (the tab went down) is tried once more, then left alone', async () => {
    const book = bookRecord('c7', 'fp-c7')
    await db.books.add(book)
    await db.files.add({ bookId: 'c7', blob: await coverlessEpub() })
    // What a crash while drawing leaves behind: the mark, and nothing else.
    await db.covers.put({ bookId: 'c7', fingerprint: 'fp-c7', blob: null, width: 0, height: 0, createdAt: 1, attempts: 1 })
    expect(await loadCover(book)).toBeNull()
    expect(await db.covers.get('c7')).toMatchObject({ blob: null })
    expect((await db.covers.get('c7'))?.attempts).toBeUndefined()

    forgetCover('c7')
    await db.covers.put({ bookId: 'c7', fingerprint: 'fp-c7', blob: null, width: 0, height: 0, createdAt: 1, attempts: MAX_COVER_ATTEMPTS })
    expect(await loadCover(book)).toBeNull()
    expect((await db.covers.get('c7'))?.createdAt).toBe(1)
  })

  it('leaves no row behind for a book deleted while its cover was made', async () => {
    const gone = bookRecord('c5', 'fp-c5')
    await db.files.add({ bookId: 'c5', blob: await coverlessEpub() })
    expect(await loadCover(gone)).toBeNull()
    expect(await db.covers.get('c5')).toBeUndefined()
  })

  it('asks for each cover only once while it is being made', async () => {
    const book = bookRecord('c6', 'fp-c6')
    await db.books.add(book)
    await db.files.add({ bookId: 'c6', blob: await coverlessEpub() })
    const [a, b] = [loadCover(book), loadCover(book)]
    expect(a).toBe(b)
    await a
  })
})
