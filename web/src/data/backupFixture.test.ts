// @vitest-environment node
// Cross-platform backup fixture. With WRITE_FIXTURE=1 it writes shared/fixtures/web-backup.zip from the web
// engine; otherwise it checks that the committed fixture still restores here. The Mac tests restore the
// same file, so a backup made in the browser keeps opening in the Mac app.
import 'fake-indexeddb/auto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { db } from './db'
import { exportBackup, importBackup } from './backup'

const fixture = new URL('../../../shared/fixtures/web-backup.zip', import.meta.url)

describe('web backup fixture', () => {
  it('restores (or is written)', async () => {
    await db.delete()
    await db.open()
    if (process.env.WRITE_FIXTURE === '1') {
      await db.books.add({ id: 'fixture-book', title: 'Kenar Notları', author: 'Peryda', format: 'pdf', pageCount: 2, size: 9, fingerprint: 'fixture-fp', addedAt: 1700000000000, openedAt: 0 })
      await db.files.add({ bookId: 'fixture-book', blob: new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }) })
      await db.cards.add({
        id: 'fixture-card', bookId: 'fixture-book', color: 'lavender', kind: 'lavender',
        anchors: [{ id: 'a1', sourceType: 'pdf_text', bookId: 'fixture-book', pageNumber: 1, selectedText: 'Kavramlar sınırlarda netleşir.', lineRects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.02 }], boundingRect: { x: 0.1, y: 0.2, width: 0.5, height: 0.02 } }],
        x: 0, y: 0, width: 390, isPinned: false, collapsed: true,
        messages: [
          { id: 'm1', role: 'user', content: 'Derinleş', createdAt: 1700000000001 },
          { id: 'm2', role: 'assistant', content: 'Sınır, kavramı komşularından ayırır.', createdAt: 1700000000002, provider: 'gemini', model: 'gemini-3.1-flash-lite' },
        ],
        archiveLinks: [{ bookId: 'other', bookTitle: 'Bilgi Kuramı', sourceId: 'journal:x', snippet: 'Bilgi ile inanç…' }],
        createdAt: 1700000000000, updatedAt: 1700000000003,
      })
      await db.journal.add({ id: 'fixture-journal', bookId: 'fixture-book', source: 'thread', quote: 'Kavramlar sınırlarda netleşir.', text: 'Sınır, kavramı komşularından ayırır.', pageNumber: 1, cardId: 'fixture-card', createdAt: 1700000000004 })
      await db.positions.put({ bookId: 'fixture-book', panX: 24, panY: -10, scale: 0.8, page: 1, updatedAt: 1700000000005 })
      await db.prefs.put({ key: 'lang', value: 'tr' })
      const blob = await exportBackup()
      mkdirSync(new URL('.', fixture), { recursive: true })
      writeFileSync(fixture, Buffer.from(await blob.arrayBuffer()))
      return
    }
    const result = await importBackup(new Blob([readFileSync(fixture)]))
    expect(result.books).toBe(1)
    expect((await db.cards.get('fixture-card'))?.collapsed).toBe(true)
  })
})
