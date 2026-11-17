import { centeredContext } from '../ai/centeredContext'
import type { PDFDocumentProxy, PDFPageProxy } from '../pdf/pdfjs'
import { CONTEXT_LENGTH } from '../ai/compose'
import type { PageSource } from '../ilmek/cardsStore'
import type { PageBox } from '../ilmek/types'
import { cappedScale } from '../pdf/canvasLimit'

/** A page's text for translation, thread context and "extract page text". Same rules as the Mac app. */

/** The page's own text layer as pdf.js reports it, line ends kept. */
export async function rawPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  const runs: TextRun[] = []
  for (const item of content.items) if ('str' in item) runs.push(item)
  return joinTextItems(runs)
}

/** What `joinTextItems` reads from a pdf.js text item. */
export interface TextRun {
  str: string
  hasEOL: boolean
  /** Text matrix in page units, [a, b, c, d, x, y]; the run starts at (x, y). */
  transform: number[]
  /** Advance of the run along its baseline, in page units. */
  width: number
}

/**
 * Below this gap (in font sizes) two runs on one line belong to the same word. pdf.js splits a word into
 * runs wherever the font changes (a PDF whose ı ş ğ İ come from a separate font subset, for example), and
 * it already reports a real space between runs as a run of its own; a normal space is about 0.25–0.33.
 */
const WORD_GAP = 0.2
/**
 * Runs whose baselines are closer than this (in font sizes) sit on one baseline. A raised or lowered run (a
 * note mark, an author's affiliation letters, a subscript) is set apart with a space, so "Awad" and a
 * superscript "a,b" do not become "Awada,b".
 */
const SAME_LINE = 0.15
/** A run may overlap the one before it by this much (kerning) and still continue it. */
const OVERLAP = 0.2

/**
 * pdf.js text runs joined into the page's text: a line end after a run that ends a line; a space between
 * two runs only when there is a real gap between them, or when they are not side by side on one line.
 */
export function joinTextItems(runs: readonly TextRun[]): string {
  let out = ''
  let open: TextRun | null = null
  for (const run of runs) {
    if (run.str) {
      if (open && !/^\s/.test(run.str) && !continues(open, run)) out += ' '
      out += run.str
      open = /\s$/.test(run.str) ? null : run
    }
    if (run.hasEOL) {
      out += '\n'
      open = null
    }
  }
  return out
}

/** Whether `next` starts where `prev` ends, on the same line, so the two are one piece of text. */
function continues(prev: TextRun, next: TextRun): boolean {
  const a = prev.transform
  const b = next.transform
  if (a.length < 6 || b.length < 6 || !Number.isFinite(prev.width) || prev.width < 0) return false
  const size = Math.max(fontSize(a), fontSize(b))
  const run = Math.hypot(a[0]!, a[1]!)
  if (!(size > 0) || !(run > 0)) return false
  // Measured along prev's baseline, so rotated text works too.
  const ux = a[0]! / run
  const uy = a[1]! / run
  const dx = b[4]! - a[4]!
  const dy = b[5]! - a[5]!
  const along = dx * ux + dy * uy
  const across = dy * ux - dx * uy
  if (!Number.isFinite(along) || !Number.isFinite(across)) return false
  if (Math.abs(across) > SAME_LINE * size) return false
  const gap = along - prev.width
  return gap >= -OVERLAP * size && gap < WORD_GAP * size
}

/** Font size of a run in page units: the height of its text matrix. */
function fontSize(t: number[]): number {
  return Math.hypot(t[2]!, t[3]!)
}

/** A page has a text layer when it holds at least 25 characters besides spaces. */
export function hasTextLayer(raw: string): boolean {
  return raw.replace(/\s/g, '').length >= 25
}

/** A line ending in "-", "‐" (U+2010) or a soft hyphen (U+00AD), where a word may be broken. */
const LINE_END_HYPHEN = /[-‐­]$/

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
    else if (LINE_END_HYPHEN.test(current) && /^\p{Ll}/u.test(line)) current = current.slice(0, -1) + line
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
  const url = canvas.toDataURL('image/jpeg', quality)
  // The canvas's pixels are let go at once: a long range renders one page after another.
  canvas.width = 0
  canvas.height = 0
  return url
}

/**
 * The page as sent for translation: its raw text, or for a page without a text layer, a note that it is
 * scanned. Its picture is drawn only when the translation is sent (`translationPicture`), so a long range
 * never holds every page's picture at once (audit 15 Nov, WW-5).
 */
export async function pageSource(doc: PDFDocumentProxy, number: number, box: PageBox): Promise<PageSource | null> {
  if (number < 1 || number > doc.numPages) return null
  const page = await doc.getPage(number)
  const raw = await rawPageText(page)
  if (hasTextLayer(raw)) return { page: number, text: raw, width: box.width, height: box.height }
  return { page: number, text: '', scanned: true, width: box.width, height: box.height }
}

/** A scanned page's picture for its translation: 1.6× (JPEG, quality 0.86), for the model to read. */
export async function translationPicture(doc: PDFDocumentProxy, number: number): Promise<string | null> {
  if (number < 1 || number > doc.numPages) return null
  return (await renderPageJpeg(await doc.getPage(number), 1.6, 0.86)) || null
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

  /**
   * Text that surrounds a selection on a page: about CONTEXT_LENGTH characters centred on it, reaching
   * into the neighbouring page at an edge; without a selection, the start of the page's text.
   */
  async context(number: number, selected = ''): Promise<string | undefined> {
    const page = await this.text(number)
    if (!selected.trim()) {
      const text = page.replace(/\s+/g, ' ').trim()
      return text ? text.slice(0, CONTEXT_LENGTH) : undefined
    }
    const before = number > 1 ? await this.text(number - 1) : ''
    const after = number < this.doc.numPages ? await this.text(number + 1) : ''
    return centeredContext(page, selected, before, after)
  }
}
