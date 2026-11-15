// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { IMAGE_PAGE_SIDE, MAX_IMAGE_SIDE, drawnSize, isHeic, isImageFile, naturalOrder, pageSizeFor, picturesToPdf, type PdfPicture } from './imagePdf'

// A JPEG's bytes are copied into the PDF as they are; these tests only need a recognisable payload.
const fakeJpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, n, n, 0xff, 0xd9])

function picture(width: number, height: number, n = 1): PdfPicture {
  return { jpeg: fakeJpeg(n), width, height }
}

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('')

describe('photos as a PDF', () => {
  it('knows photos by type or name, and HEIC among them', () => {
    expect(isImageFile({ name: 'IMG_1.JPG', type: '' })).toBe(true)
    expect(isImageFile({ name: 'x', type: 'image/png' })).toBe(true)
    expect(isImageFile({ name: 'sayfa.webp', type: '' })).toBe(true)
    expect(isImageFile({ name: 'IMG_2.heic', type: '' })).toBe(true)
    expect(isImageFile({ name: 'kitap.pdf', type: 'application/pdf' })).toBe(false)
    expect(isImageFile({ name: 'logo.svg', type: 'image/svg+xml' })).toBe(false)
    expect(isHeic({ name: 'IMG_2.HEIF', type: '' })).toBe(true)
    expect(isHeic({ name: 'a.jpg', type: 'image/heic' })).toBe(true)
    expect(isHeic({ name: 'a.jpg', type: 'image/jpeg' })).toBe(false)
  })

  it('orders photos by their names naturally (IMG_2 before IMG_10)', () => {
    const files = ['IMG_10.jpg', 'IMG_2.jpg', 'img_1.jpg'].map((name) => ({ name }))
    expect(naturalOrder(files).map((f) => f.name)).toEqual(['img_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg'])
  })

  it('draws a photo at most 3200 pixels on its longer side, never larger than it is', () => {
    expect(drawnSize(4032, 3024)).toEqual({ width: MAX_IMAGE_SIDE, height: 2400 })
    expect(drawnSize(3024, 4032)).toEqual({ width: 2400, height: MAX_IMAGE_SIDE })
    expect(drawnSize(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('makes each page 842 points on its longer side, in the photo’s proportions', () => {
    expect(pageSizeFor(2400, 3200)).toEqual({ width: 631.5, height: IMAGE_PAGE_SIDE })
    expect(pageSizeFor(3200, 2400)).toEqual({ width: IMAGE_PAGE_SIDE, height: 631.5 })
  })

  it('writes a PDF whose cross-reference table points at every object', () => {
    const pdf = picturesToPdf([picture(2400, 3200, 1), picture(3200, 2400, 2)])
    const text = latin1(pdf)
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const table = text.slice(startxref).split('\n')
    const count = Number(table[1]!.split(' ')[1])
    expect(count).toBe(9)
    for (let id = 1; id < count; id += 1) {
      const offset = Number(table[2 + id]!.slice(0, 10))
      expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`)
    }
    expect(text).toContain('/Count 2')
    expect(text).toContain('/MediaBox [0 0 631.5 842]')
    expect(text).toContain('/MediaBox [0 0 842 631.5]')
    expect(text).toContain('/Filter /DCTDecode')
    // The JPEG bytes are kept unchanged, with the length the dictionary gives.
    expect(text).toContain(`/Length 9 >>\nstream\n${latin1(fakeJpeg(2))}\nendstream`)
  })

  it('opens in pdf.js with a page per photo at the expected size', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdf = picturesToPdf([picture(2400, 3200, 1), picture(3200, 2400, 2), picture(1000, 1000, 3)])
    const doc = await pdfjs.getDocument({ data: pdf }).promise
    expect(doc.numPages).toBe(3)
    const sizes = []
    for (let i = 1; i <= 3; i += 1) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 })
      sizes.push([vp.width, vp.height])
    }
    expect(sizes).toEqual([
      [631.5, 842],
      [842, 631.5],
      [842, 842],
    ])
    await doc.loadingTask.destroy()
  })
})
