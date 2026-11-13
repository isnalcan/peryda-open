import { db, type BookFormat, type CoverRecord } from '../data/db'
import { ZIP_LIMITS, ZipLimitError, openZip, readEntry, readText } from '../epub/zipLimits'
import { cappedScale } from '../pdf/canvasLimit'

/**
 * Library covers: a PDF's first page, or an EPUB's own cover picture. Each is made once, kept in the
 * `covers` table (a cache, never backed up) and in memory for this session. A failure only means the
 * tile keeps its placeholder.
 */

/** Width over height of the library's cover frame. */
export const FRAME_RATIO = 3 / 4

/** Covers are drawn this wide: sharp on a 2x screen at the grid's tile size. */
export const COVER_WIDTH = 420

/** A very tall strip is capped so its canvas stays small; it is letterboxed anyway. */
const COVER_MAX_HEIGHT = 840

/** The Mac refuses a cover entry larger than this, and so do we. */
const MAX_COVER_BYTES = ZIP_LIMITS.cover

/** The container and package files are small; anything bigger is not read (and never scanned). */
const MAX_CONTAINER_BYTES = 1_000_000
const MAX_PACKAGE_BYTES = 8_000_000

export type CoverFit = 'fill' | 'letterbox'

/**
 * A picture within 20% of the frame's shape fills it; a very different one (a wide two-page scan, a
 * tall strip) is shown whole on white instead of being cropped hard or spilling over.
 */
export function coverFit(width: number, height: number): CoverFit {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return 'letterbox'
  // One division keeps the 0.8 and 1.25 edges exact (0.6 / 0.75 is 0.7999… in floating point).
  const ratio = width / (height * FRAME_RATIO)
  return ratio >= 0.8 && ratio <= 1.25 ? 'fill' : 'letterbox'
}

// ---------- EPUB cover lookup ----------

/**
 * Resolves an href found in the package file against the package's folder inside the zip. `.` and
 * `..` are walked by hand (on the Mac a `../images/cover.jpg` once missed its picture); a path that
 * climbs out of the book is refused.
 */
export function resolveZipPath(baseDir: string, href: string, decode = true): string | null {
  const clean = href.split('#')[0]!.split('?')[0]!.trim()
  if (!clean) return null
  const parts = clean.startsWith('/') ? [] : baseDir.split('/').filter(Boolean)
  for (const raw of clean.split('/')) {
    let piece = raw
    if (decode) {
      try {
        piece = decodeURIComponent(raw)
      } catch {
        piece = raw
      }
    }
    if (piece === '' || piece === '.') continue
    if (piece === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(piece)
  }
  return parts.length ? parts.join('/') : null
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    const lower = code.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const n = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole
  })
}

/**
 * Removes every `open … close` section in one pass. An unclosed one runs to the end. Done by hand: a lazy
 * regex rescans the rest of the file from every unclosed opener, which stalls on a hostile file.
 */
export function stripSections(text: string, open: string, close: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const start = text.indexOf(open, at)
    if (start === -1) return out + text.slice(at)
    out += text.slice(at, start)
    const end = text.indexOf(close, start + open.length)
    if (end === -1) return out
    at = end + close.length
  }
}

/**
 * Attributes of every `<name …>` tag, matched by local name so `<opf:item>` counts too. The package
 * and container files are plain enough for this, and it needs no DOMParser (tests run without one).
 */
function tagsNamed(xml: string, name: string): Record<string, string>[] {
  const source = stripSections(stripSections(xml, '<!--', '-->'), '<![CDATA[', ']]>')
  const tag = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?=[\\s/>])([^>]*)>`, 'g')
  const attr = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  const found: Record<string, string>[] = []
  for (const match of source.matchAll(tag)) {
    const attrs: Record<string, string> = {}
    for (const a of (match[1] ?? '').matchAll(attr)) {
      const local = a[1]!.includes(':') && !a[1]!.startsWith('xmlns') ? a[1]!.split(':').pop()! : a[1]!
      attrs[local] = decodeEntities(a[2] ?? a[3] ?? '')
    }
    found.push(attrs)
  }
  return found
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
}

export interface EpubCover {
  /** Path of the picture inside the zip. */
  path: string
  mediaType: string
  bytes: Uint8Array
}

/**
 * The EPUB's own cover picture: the manifest item marked `cover-image` (EPUB 3), or the item named by
 * `<meta name="cover">` (EPUB 2). Returns null when the book names no cover or the entry is missing;
 * throws when the file is not a readable zip.
 */
export async function findEpubCover(data: ArrayBuffer | Uint8Array): Promise<EpubCover | null> {
  const zip = await openZip(data)
  const containerFile = zip.file('META-INF/container.xml')
  const container = containerFile ? await readText(containerFile, MAX_CONTAINER_BYTES) : null
  if (!container) return null
  const rootfiles = tagsNamed(container, 'rootfile')
  const opfPath = (rootfiles.find((r) => r['media-type'] === 'application/oebps-package+xml') ?? rootfiles[0])?.['full-path']
  if (!opfPath) return null
  const opfFile = zip.file(resolveZipPath('', opfPath) ?? opfPath)
  const opf = opfFile ? await readText(opfFile, MAX_PACKAGE_BYTES) : null
  if (!opf) return null

  const items = tagsNamed(opf, 'item')
  let item = items.find((i) => (i.properties ?? '').split(/\s+/).includes('cover-image'))
  if (!item) {
    const id = tagsNamed(opf, 'meta').find((m) => m.name === 'cover')?.content?.trim()
    if (id) item = items.find((i) => i.id === id)
  }
  const href = item?.href
  if (!href) return null

  const baseDir = opfFile!.name.includes('/') ? opfFile!.name.slice(0, opfFile!.name.lastIndexOf('/')) : ''
  const decoded = resolveZipPath(baseDir, href)
  const raw = resolveZipPath(baseDir, href, false)
  const entry = (decoded && zip.file(decoded)) || (raw && zip.file(raw)) || null
  if (!entry) return null
  // Checked against the declared size before unpacking, and counted while unpacking.
  let bytes: Uint8Array
  try {
    bytes = (await readEntry(entry, MAX_COVER_BYTES)).bytes
  } catch (error) {
    if (error instanceof ZipLimitError) return null
    throw error
  }
  if (bytes.byteLength === 0) return null
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
  const mediaType = item?.['media-type']?.startsWith('image/') ? item['media-type'] : (IMAGE_TYPES[ext] ?? 'application/octet-stream')
  return { path: entry.name, mediaType, bytes }
}

// ---------- Drawing ----------

interface Picture {
  blob: Blob
  width: number
  height: number
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // JPEG keeps a page-sized cover around 40 KB; the page is drawn on white so nothing is lost.
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('cover encode failed'))), 'image/jpeg', 0.86)
  })
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return { canvas, ctx }
}

interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  release: () => void
}

async function decodeImage(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      /* SVG covers are not decoded by createImageBitmap everywhere; an <img> can. */
    }
  }
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) }
}

/** Scales a picture down to the cover width (never up) on white, so transparent covers stay readable. */
async function downscale(blob: Blob): Promise<Picture> {
  const image = await decodeImage(blob)
  try {
    if (!(image.width > 0) || !(image.height > 0)) throw new Error('empty image')
    const scale = Math.min(1, COVER_WIDTH / image.width, COVER_MAX_HEIGHT / image.height)
    const { canvas, ctx } = makeCanvas(image.width * scale, image.height * scale)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height)
    return { blob: await canvasBlob(canvas), width: canvas.width, height: canvas.height }
  } finally {
    image.release()
  }
}

async function renderPdfCover(data: ArrayBuffer): Promise<Picture> {
  // pdf.js loads only when a PDF cover is actually drawn, like the importer.
  const { openPdf, closePdf } = await import('../pdf/pdfjs')
  const doc = await openPdf(data)
  try {
    const page = await doc.getPage(1)
    const unit = page.getViewport({ scale: 1 })
    const scale = cappedScale(unit.width, unit.height, Math.min(COVER_WIDTH / unit.width, COVER_MAX_HEIGHT / unit.height))
    const viewport = page.getViewport({ scale })
    const { canvas, ctx } = makeCanvas(viewport.width, viewport.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    page.cleanup()
    return { blob: await canvasBlob(canvas), width: canvas.width, height: canvas.height }
  } finally {
    closePdf(doc)
  }
}

/** Draws a cover from the stored file; null means the book has no cover picture of its own. */
async function drawCover(book: CoverBook): Promise<Picture | null> {
  const file = await db.files.get(book.id)
  if (!file) throw new Error('book file missing')
  const data = await file.blob.arrayBuffer()
  if (book.format === 'pdf') return renderPdfCover(data)
  const found = await findEpubCover(data)
  if (!found) return null
  return downscale(new Blob([found.bytes as Uint8Array<ArrayBuffer>], { type: found.mediaType }))
}

// ---------- Cache ----------

export interface CoverBook {
  id: string
  fingerprint: string
  format: BookFormat
}

export interface CoverImage {
  /** Object URL of the cover picture. */
  url: string
  width: number
  height: number
}

/** Covers known this session: a picture, null for "no picture", by book and file fingerprint. */
const memory = new Map<string, CoverImage | null>()
const pending = new Map<string, Promise<CoverImage | null>>()

const keyOf = (book: Pick<CoverBook, 'id' | 'fingerprint'>) => `${book.id}:${book.fingerprint}`

/** What is already known without any work: a picture, null (placeholder), or undefined (not yet). */
export function peekCover(book: Pick<CoverBook, 'id' | 'fingerprint'>): CoverImage | null | undefined {
  return memory.get(keyOf(book))
}

/** Forgets a book's cover for this session (the stored row goes with deleteBook). */
export function forgetCover(bookId: string): void {
  for (const [key, image] of memory) {
    if (!key.startsWith(`${bookId}:`)) continue
    if (image) URL.revokeObjectURL(image.url)
    memory.delete(key)
  }
}

// Drawing a page is heavy, so at most two covers are made at a time.
const MAX_JOBS = 2
let running = 0
const waiting: (() => void)[] = []

async function inTurn<T>(job: () => Promise<T>): Promise<T> {
  if (running < MAX_JOBS) running += 1
  else await new Promise<void>((resolve) => waiting.push(resolve))
  try {
    return await job()
  } finally {
    // The slot passes straight to the next job, so the limit holds.
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
}

function toImage(picture: { blob: Blob; width: number; height: number }): CoverImage {
  return { url: URL.createObjectURL(picture.blob), width: picture.width, height: picture.height }
}

/**
 * A cover is tried at most this often for the same file. The second try covers an app closed while the
 * first was being made; after that a failing (or tab-crashing) cover keeps its placeholder for good.
 */
export const MAX_COVER_ATTEMPTS = 2

async function storeCover(book: CoverBook, picture: Picture | null, attempts?: number): Promise<void> {
  const row: CoverRecord = {
    bookId: book.id,
    fingerprint: book.fingerprint,
    blob: picture?.blob ?? null,
    width: picture?.width ?? 0,
    height: picture?.height ?? 0,
    createdAt: Date.now(),
  }
  if (attempts !== undefined) row.attempts = attempts
  // A book deleted (or replaced) while its cover was drawn must not leave a row behind.
  await db.transaction('rw', db.books, db.covers, async () => {
    const current = await db.books.get(book.id)
    if (current && current.fingerprint === book.fingerprint) await db.covers.put(row)
  })
}

async function resolveCover(book: CoverBook): Promise<CoverImage | null> {
  const stored = await db.covers.get(book.id)
  const tried = stored && stored.fingerprint === book.fingerprint ? stored : undefined
  if (tried?.blob) return toImage({ blob: tried.blob, width: tried.width, height: tried.height })
  // No picture of its own, or tried too often already: the placeholder, without any work.
  if (tried && (!tried.attempts || tried.attempts >= MAX_COVER_ATTEMPTS)) return null
  const picture = await inTurn(async () => {
    // Marked before drawing, so a cover that takes the tab down is not drawn again at every launch.
    await storeCover(book, null, (tried?.attempts ?? 0) + 1)
    try {
      return await drawCover(book)
    } catch (error) {
      await storeCover(book, null, MAX_COVER_ATTEMPTS).catch(() => undefined)
      throw error
    }
  })
  try {
    await storeCover(book, picture)
  } catch {
    /* the cover still shows this session */
  }
  return picture ? toImage(picture) : null
}

/** The book's cover, made on first request. Never rejects: any failure gives null (the placeholder). */
export function loadCover(book: CoverBook): Promise<CoverImage | null> {
  const key = keyOf(book)
  const known = memory.get(key)
  if (known !== undefined) return Promise.resolve(known)
  let job = pending.get(key)
  if (!job) {
    job = resolveCover(book)
      .catch(() => null)
      .then((image) => {
        memory.set(key, image)
        pending.delete(key)
        return image
      })
    pending.set(key, job)
  }
  return job
}
