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

  it('refuses files that are not Peryda backups', async () => {
    await expect(importBackup(new Blob(['nope']))).rejects.toThrow()
  })
})
