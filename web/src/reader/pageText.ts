import type { PDFDocumentProxy, PDFPageProxy } from '../pdf/pdfjs'
import { CONTEXT_LENGTH } from '../ai/compose'
import type { PageSource } from '../ilmek/cardsStore'
import type { PageBox } from '../ilmek/types'
import { cappedScale } from '../pdf/canvasLimit'

/** A page's text for translation, thread context and "extract page text". Same rules as the Mac app. */

/** The page's own text layer as pdf.js reports it, line ends kept. */
export async function rawPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  let out = ''
  for (const item of content.items) {
    if (!('str' in item)) continue
    out += item.str
    if (item.hasEOL) out += '\n'
    else if (item.str && !/\s$/.test(item.str)) out += ' '
  }
  return out
}

/** A page has a text layer when it holds at least 25 characters besides spaces. */
export function hasTextLayer(raw: string): boolean {
  return raw.replace(/\s/g, '').length >= 25
}

/** Soft-wrapped PDF lines joined into paragraphs; hyphenated line ends rejoined. */
export function cleanPageText(raw: string): string {
  const lines = raw.replace(/\r/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
  const paragraphs: string[] = []
  let current = ''
  for (const line of lines) {
    if (!line) {
      if (current) paragraphs.push(current)
      current = ''
      continue
    }
    if (!current) current = line
    else if (current.endsWith('-') && /^\p{Ll}/u.test(line)) current = current.slice(0, -1) + line
    else current += ` ${line}`
  }
  if (current) paragraphs.push(current)
  return paragraphs.join('\n\n').trim()
}

/** Renders a page to a JPEG data URL at `scale` times its size in points (less for a huge page). */
export async function renderPageJpeg(page: PDFPageProxy, scale: number, quality: number): Promise<string> {
  const unit = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: cappedScale(unit.width, unit.height, scale) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * The page as sent for translation: its raw text, or for a page without a text layer, a picture at 1.6×
 * (JPEG, quality 0.86) for the model to read and translate.
 */
export async function pageSource(doc: PDFDocumentProxy, number: number, box: PageBox): Promise<PageSource | null> {
  if (number < 1 || number > doc.numPages) return null
  const page = await doc.getPage(number)
  const raw = await rawPageText(page)
  if (hasTextLayer(raw)) return { page: number, text: raw, width: box.width, height: box.height }
  const image = await renderPageJpeg(page, 1.6, 0.86)
  return { page: number, text: '', imageDataUrl: image || undefined, width: box.width, height: box.height }
}

/** Remembers each page's text once read; threads take the start of it as their context. */
export class PageTextCache {
  private texts = new Map<number, Promise<string>>()
  constructor(private readonly doc: PDFDocumentProxy) {}

  text(number: number): Promise<string> {
    let entry = this.texts.get(number)
    if (!entry) {
      entry = this.doc
        .getPage(number)
        .then(rawPageText)
        .catch(() => '')
      this.texts.set(number, entry)
    }
    return entry
  }

  /** Text that surrounds a selection on a page: the start of the page's text. */
  async context(number: number): Promise<string | undefined> {
    const text = (await this.text(number)).replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, CONTEXT_LENGTH) : undefined
  }
}
