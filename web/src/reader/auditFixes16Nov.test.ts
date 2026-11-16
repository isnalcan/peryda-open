import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_FIND_HITS, findInText } from './find'
import { keepThumbnail } from './ThumbnailSidebar'
import { MAX_IMAGE_PIXELS, MAX_PHOTOS_PER_BOOK, PictureTooLargeError, imageDimensions, pageSizeFor, pictureFromFile } from '../library/imagePdf'
import { importImages } from '../library/importBook'
import { BACKUP_FORMAT, BackupError, MAX_BACKUP_BOOKS, importBackup } from '../data/backup'

beforeAll(() => vi.stubGlobal('Blob', NodeBlob))

const png = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

describe('audit 16 Nov: limits', () => {
  it('W16-1: a search keeps at most MAX_FIND_HITS matches, one page included', () => {
    const page = 'a '.repeat(200_000)
    const hits = findInText(page, 'a')
    expect(hits.length).toBe(MAX_FIND_HITS)
    expect(findInText(page, 'a', 3)).toHaveLength(3)
  })

  it('W16-2: a photo is measured from its header and refused above the pixel limit, before decoding', async () => {
    expect(imageDimensions(png(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xc0, 0x0f, 0xc0, 0x03, 0, 0, 0, 0])
    expect(imageDimensions(jpeg)).toEqual({ width: 4032, height: 3008 })
    const webp = new Uint8Array(30)
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8)
    webp.set([0x9f, 0x0f, 0x00, 0xbf, 0x0b, 0x00], 24)
    expect(imageDimensions(webp)).toEqual({ width: 4000, height: 3008 })
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull()
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 10
    await expect(pictureFromFile(new Blob([png(side, side)]))).rejects.toBeInstanceOf(PictureTooLargeError)
  })

  it('W16-2: at most MAX_PHOTOS_PER_BOOK photos become one book', async () => {
    const files = Array.from({ length: MAX_PHOTOS_PER_BOOK + 1 }, (_, i) => new File(['x'], `IMG_${i}.jpg`, { type: 'image/jpeg' }))
    await expect(importImages(files, async () => ({ jpeg: new Uint8Array([1]), width: 1, height: 1 }))).rejects.toMatchObject({ kind: 'tooManyPhotos' })
  })

  it('W16-4: a picture that is a thin strip still makes a page you can see', () => {
    expect(pageSizeFor(10_000, 1)).toEqual({ width: 842, height: 24 })
  })

  it('W16-3: the thumbnail cache drops the oldest past its size', () => {
    const map = new Map<number, string>()
    for (let n = 1; n <= 5; n++) keepThumbnail(map, n, `t${n}`, 3)
    expect([...map.keys()]).toEqual([3, 4, 5])
    keepThumbnail(map, 3, 'again', 3)
    expect([...map.keys()]).toEqual([4, 5, 3])
  })

  it('K16-2: a backup declaring too many books is refused before anything is read', async () => {
    const zip = new JSZip()
    const books = Array.from({ length: MAX_BACKUP_BOOKS + 1 }, (_, i) => ({ id: `b${i}`, title: 't', author: '', format: 'pdf', pageCount: 1, size: 1, fingerprint: 'x', addedAt: 1, openedAt: 0 }))
    zip.file('peryda.json', JSON.stringify({ format: BACKUP_FORMAT, version: 1, createdAt: 1, books, cards: [], journal: [], positions: [], prefs: [] }))
    const file = await zip.generateAsync({ type: 'blob' })
    await expect(importBackup(file)).rejects.toBeInstanceOf(BackupError)
  })
})
