// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { db } from './db'
import { saveSettings, DEFAULT_SETTINGS } from './keyVault'
import { exportBackup, importBackup } from './backup'

const book = {
  id: 'book-1',
  title: 'Deneme',
  author: '',
  format: 'pdf' as const,
  pageCount: 3,
  size: 4,
  fingerprint: 'fp-1',
  addedAt: 1,
  openedAt: 1,
}

async function seed() {
  await db.books.add(book)
  await db.files.add({ bookId: book.id, blob: new Blob(['%PDF'], { type: 'application/pdf' }) })
  await db.journal.add({ id: 'j1', bookId: book.id, source: 'clip', quote: 'alıntı', text: '', pageNumber: 2, createdAt: 2 })
  await db.prefs.put({ key: 'lang', value: 'tr' })
  await db.prefs.put({ key: 'openBookId', value: book.id })
  await saveSettings({ ...DEFAULT_SETTINGS, openaiApiKey: 'sk-placeholder-not-real-123' })
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('backup', () => {
  it('never puts keys or the vault in the file', async () => {
    await seed()
    const blob = await exportBackup()
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const manifest = await zip.file('peryda.json')!.async('string')
    expect(manifest).not.toContain('sk-placeholder')
    expect(manifest).not.toContain('openBookId')
    expect(Object.keys(zip.files)).toContain('books/book-1.pdf')
  })

  it('restores a library into an empty device, and skips books already there', async () => {
    await seed()
    const blob = await exportBackup()
    await db.delete()
    await db.open()
    expect(await importBackup(blob)).toEqual({ books: 1 })
    expect(await db.journal.count()).toBe(1)
    expect((await db.files.get('book-1'))?.blob.size).toBe(4)
    expect(await importBackup(blob)).toEqual({ books: 0 })
  })

  // Audit 15 Nov (WW-11): only what a restore accepts is written, and the pages Pery read come back.
  it('writes only restorable preferences, and brings back finished page readings without job names', async () => {
    await seed()
    await db.prefs.put({ key: 'launches', value: 7 })
    await db.prefs.put({ key: 'rememberKeys', value: true })
    await db.prefs.put({ key: `cardTextScale:${book.id}`, value: 1.3 })
    await db.prefs.put({ key: `pageScale:${book.id}`, value: 1.6 })
    await db.prefs.put({
      key: `readings:${book.id}`,
      value: [
        { page: 1, text: 'Bir', state: 'done', createdAt: 5 },
        { page: 2, text: '', state: 'waiting', job: 'batches/abc', createdAt: 6 },
      ],
    })
    const blob = await exportBackup()
    const manifest = await (await JSZip.loadAsync(await blob.arrayBuffer())).file('peryda.json')!.async('string')
    expect(manifest).not.toContain('launches')
    expect(manifest).not.toContain('rememberKeys')
    expect(manifest).not.toContain('batches/abc')
    await db.delete()
    await db.open()
    await importBackup(blob)
    expect((await db.prefs.get(`readings:${book.id}`))?.value).toEqual([{ page: 1, text: 'Bir', state: 'done', createdAt: 5 }])
    expect((await db.prefs.get(`cardTextScale:${book.id}`))?.value).toBe(1.3)
    // The pages' size comes back with the cards that were placed beside them at that size.
    expect((await db.prefs.get(`pageScale:${book.id}`))?.value).toBe(1.6)
    expect(await db.prefs.get('launches')).toBeUndefined()
  })

  it('refuses files that are not Peryda backups', async () => {
    await expect(importBackup(new Blob(['nope']))).rejects.toThrow()
  })
})
