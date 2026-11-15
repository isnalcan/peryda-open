// @vitest-environment node
import 'fake-indexeddb/auto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { db } from '../data/db'
import { MAX_IMPORT_MB, importBook, importImages } from './importBook'
import { PictureDecodeError, type PdfPicture } from './imagePdf'

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

  describe('photos', () => {
    // Decoding needs a browser: the tests stand in for it with a picture per file, named after the file.
    const order: string[] = []
    const picture = async (file: File): Promise<PdfPicture> => {
      order.push(file.name)
      return { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 300, height: 400 }
    }
    const photo = (name: string, body = name) => new File([body], name, { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' })

    it('become one PDF book, a page per photo in name order, and are found again when added again', async () => {
      order.length = 0
      const files = [photo('IMG_10.jpg'), photo('IMG_2.jpg'), photo('IMG_3.png')]
      const book = await importImages(files, picture)
      expect(order).toEqual(['IMG_2.jpg', 'IMG_3.png', 'IMG_10.jpg'])
      expect(book).toMatchObject({ format: 'pdf', pageCount: 3, title: 'IMG 2', author: '' })
      const file = await db.files.get(book.id)
      expect(file?.blob.type).toBe('application/pdf')
      const head = new TextDecoder().decode((await file!.blob.arrayBuffer()).slice(0, 8))
      expect(head).toBe('%PDF-1.4')
      // The same photos (in any order) are the same book.
      const again = await importImages([files[2]!, files[0]!, files[1]!], picture)
      expect(again.id).toBe(book.id)
      // Other photos make another book.
      const other = await importImages([photo('IMG_2.jpg', 'another picture')], picture)
      expect(other.id).not.toBe(book.id)
    })

    it('a photo given to importBook goes the photo way (here no browser can decode it)', async () => {
      await expect(importBook(new File(['h'], 'IMG_7.heic'))).rejects.toMatchObject({ kind: 'heic' })
    })

    it('say when this browser cannot open a HEIC photo, and refuse other files among photos', async () => {
      const undecodable = async (): Promise<PdfPicture> => {
        throw new PictureDecodeError('undecodable')
      }
      await expect(importImages([new File(['h'], 'IMG_9.HEIC')], undecodable)).rejects.toMatchObject({ kind: 'heic' })
      await expect(importImages([photo('bozuk.jpg', 'not a jpeg')], undecodable)).rejects.toMatchObject({ kind: 'unreadable' })
      await expect(importImages([photo('a.jpg'), new File(['x'], 'b.txt')], picture)).rejects.toMatchObject({ kind: 'unsupported' })
    })

    it('count the photos together against the size limit', async () => {
      const big = photo('IMG_1.jpg')
      Object.defineProperty(big, 'size', { value: MAX_IMPORT_MB * 600_000 })
      const big2 = photo('IMG_2.jpg')
      Object.defineProperty(big2, 'size', { value: MAX_IMPORT_MB * 600_000 })
      await expect(importImages([big, big2], picture)).rejects.toMatchObject({ kind: 'tooLarge' })
    })
  })
})
