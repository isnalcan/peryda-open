// @vitest-environment node
import 'fake-indexeddb/auto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { db } from '../data/db'
import { MAX_IMPORT_MB, importBook } from './importBook'

async function tinyEpub(extra: Record<string, string> = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('content.opf', '<package><metadata/><manifest/></package>')
  for (const [name, text] of Object.entries(extra)) zip.file(name, text)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

describe('importBook', () => {
  it('adds the same file only once even when two imports race', async () => {
    const bytes = await tinyEpub()
    const a = new File([bytes as Uint8Array<ArrayBuffer>], 'kitap.epub', { type: 'application/epub+zip' })
    const b = new File([bytes as Uint8Array<ArrayBuffer>], 'kitap-kopya.epub', { type: 'application/epub+zip' })
    const [first, second] = await Promise.all([importBook(a), importBook(b)])
    expect(first.id).toBe(second.id)
    expect(await db.books.count()).toBe(1)
    expect(await db.files.count()).toBe(1)
  })

  it('refuses files that are neither PDF nor EPUB', async () => {
    await expect(importBook(new File(['x'], 'notes.txt', { type: 'text/plain' }))).rejects.toMatchObject({ kind: 'unsupported' })
  })

  it('refuses a file over the size limit before reading it', async () => {
    const huge = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(huge, 'size', { value: MAX_IMPORT_MB * 1_000_000 + 1 })
    Object.defineProperty(huge, 'arrayBuffer', { value: () => Promise.reject(new Error('must not be read')) })
    await expect(importBook(huge)).rejects.toMatchObject({ kind: 'tooLarge', limitMb: 500 })
  })

  it('refuses an EPUB that is not a zip, or that unpacks past the limits', async () => {
    await expect(importBook(new File(['PK not really a zip'], 'x.epub'))).rejects.toMatchObject({ kind: 'unreadable' })
    // 60 MB of one letter packs into a few kB.
    const bomb = await tinyEpub({ 'OEBPS/chapter.xhtml': 'a'.repeat(60_000_000) })
    expect(bomb.byteLength).toBeLessThan(1_000_000)
    const before = await db.books.count()
    await expect(importBook(new File([bomb as Uint8Array<ArrayBuffer>], 'bomb.epub'))).rejects.toMatchObject({ kind: 'unreadable' })
    expect(await db.books.count()).toBe(before)
    // Real work (a large archive is made and unpacked): about 1 s alone, longer when the machine is busy
    // with the whole suite in parallel (audit 15 Nov, WR-4).
  }, 20_000)
})
