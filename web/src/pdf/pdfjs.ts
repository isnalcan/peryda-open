import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { NormalizedRect } from '../ilmek/types'
import { cappedScale } from './canvasLimit'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type { PDFDocumentProxy, PDFPageProxy }
export { pdfjs }

/** Releases a document and its worker resources. */
export function closePdf(doc: PDFDocumentProxy | null | undefined): void {
  void doc?.loadingTask.destroy()
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // pdf.js takes ownership of the buffer it is given, so pass a copy.
  return pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    enableXfa: false,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    iccUrl: '/pdfjs/iccs/',
    wasmUrl: '/pdfjs/wasm/',
  }).promise
}

export interface PageSize {
  /** Unrotated-for-display size in points, after the page's own /Rotate is applied. */
  width: number
  height: number
}

export async function pageSizes(doc: PDFDocumentProxy, onProgress?: (done: number) => void): Promise<PageSize[]> {
  const sizes: PageSize[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    sizes.push({ width: vp.width, height: vp.height })
    if (i % 25 === 0) onProgress?.(i)
  }
  return sizes
}

export interface PdfMetadata {
  title: string
  author: string
  pageCount: number
}

export async function readPdfMetadata(doc: PDFDocumentProxy, fallbackTitle: string): Promise<PdfMetadata> {
  let title = ''
  let author = ''
  try {
    const meta = await doc.getMetadata()
    const info = (meta.info ?? {}) as Record<string, unknown>
    title = typeof info.Title === 'string' ? info.Title.trim() : ''
    author = typeof info.Author === 'string' ? info.Author.trim() : ''
  } catch {
    /* metadata is optional */
  }
  // Many PDFs carry a meaningless title such as "Microsoft Word - draft.docx".
  if (!title || /^(untitled|microsoft word|document\d*$)/i.test(title)) title = fallbackTitle
  return { title, author, pageCount: doc.numPages }
}

/** Counts characters in a page's text layer; scanned pages have none or almost none. */
export async function pageCharacterCount(page: PDFPageProxy): Promise<number> {
  const content = await page.getTextContent()
  let count = 0
  for (const item of content.items) if ('str' in item) count += item.str.trim().length
  return count
}

/** Text whose glyph boxes fall inside a normalized rectangle of the page. */
export async function textInRect(page: PDFPageProxy, rect: NormalizedRect): Promise<string> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const parts: string[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue
    const [, , , d, e, f] = pdfjs.Util.transform(viewport.transform, item.transform) as number[]
    const fontHeight = Math.abs(d ?? 0)
    const left = (e ?? 0) / viewport.width
    const top = ((f ?? 0) - fontHeight) / viewport.height
    const width = item.width / viewport.width
    const height = fontHeight / viewport.height
    const cx = left + width / 2
    const cy = top + height / 2
    if (cx >= rect.x && cx <= rect.x + rect.width && cy >= rect.y && cy <= rect.y + rect.height) {
      parts.push(item.str + (item.hasEOL ? '\n' : ' '))
    }
  }
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

/**
 * Renders a normalized region of a page to a PNG data URL. The region is drawn at twice the base world
 * scale, and larger when the region is small, so small indices and axis labels stay legible.
 */
export async function cropPageRegion(page: PDFPageProxy, rect: NormalizedRect, baseWorldWidth: number): Promise<string> {
  const unit = page.getViewport({ scale: 1 })
  const minRegionPixels = 1024
  const wanted = Math.max((2 * baseWorldWidth) / unit.width, minRegionPixels / Math.max(rect.width * unit.width, 1))
  // The canvas is the region only, so the pixel cap applies to the region's size.
  const scale = cappedScale(rect.width * unit.width, rect.height * unit.height, Math.min(wanted, 4096 / unit.width))
  const viewport = page.getViewport({ scale })
  const sx = Math.round(rect.x * viewport.width)
  const sy = Math.round(rect.y * viewport.height)
  const sw = Math.max(1, Math.round(rect.width * viewport.width))
  const sh = Math.max(1, Math.round(rect.height * viewport.height))
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, sw, sh)
  await page.render({ canvas, canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -sx, -sy] }).promise
  return canvas.toDataURL('image/png')
}
