import ePub, { type Book } from 'epubjs'
import { EMPTY_CHAPTER, sanitizeChapter } from './sanitize'

export type { Book }

/**
 * How chapters are shown: one continuous scroll in sandboxed frames. `allowScriptedContent: false` keeps
 * `allow-scripts` (and popups) out of the frame's sandbox; the default iframe view is used, never epub.js's
 * `inline` view, which would copy book HTML into the app's own page.
 */
export const RENDITION_OPTIONS = {
  flow: 'scrolled',
  manager: 'continuous',
  width: '100%',
  height: '100%',
  spread: 'none',
  allowScriptedContent: false,
} as const

/** Extensions and types that a browser would open as a document (and run) if handed to it as a blob. */
const DOCUMENT_NAME = /\.(x?html?|xht|xml|xsl|xslt|m?js)$/i
const DOCUMENT_TYPE = /(html|xml|javascript|ecmascript)/i

/**
 * epub.js turns every non-chapter file the book lists (pictures, fonts, …) into a blob: URL typed by its
 * file extension. A book can list an `.html` file as a "picture"; its blob would then be an HTML page of
 * this app's origin if opened on its own. Such files are given a neutral type, so a browser only ever
 * downloads them.
 */
function neutralizeDocumentBlobs(book: Book): void {
  const archive = (book as unknown as { archive?: { getBlob?: (url: string, mimeType?: string) => unknown } }).archive
  if (!archive || typeof archive.getBlob !== 'function') return
  const getBlob = archive.getBlob.bind(archive)
  archive.getBlob = (url: string, mimeType?: string) => {
    const path = url.split(/[?#]/)[0] ?? ''
    const risky = DOCUMENT_NAME.test(path) || (mimeType !== undefined && DOCUMENT_TYPE.test(mimeType) && mimeType !== 'image/svg+xml')
    return getBlob(url, risky ? 'application/octet-stream' : mimeType)
  }
}

export function openEpub(data: ArrayBuffer): Book {
  const book = ePub(data.slice(0))
  neutralizeDocumentBlobs(book)
  return book
}

/**
 * Cleans every chapter before it reaches its frame (see sanitize.ts). Registered once the book is ready,
 * after epub.js's own step that swaps resource paths for blob: URLs, so the cleaner sees the final
 * chapter. epub.js swallows errors thrown by these steps, so a failure shows an empty chapter instead of
 * an uncleaned one.
 */
export function sanitizeChapters(book: Book): void {
  const hooks = (book.spine as unknown as { hooks: { serialize: { register(fn: (output: string, section: { output?: string }) => void): void } } }).hooks
  hooks.serialize.register((output, section) => {
    try {
      section.output = sanitizeChapter(typeof section.output === 'string' ? section.output : output)
    } catch {
      section.output = EMPTY_CHAPTER
    }
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/** Title, author and chapter count; best effort, so a slow or odd file still imports with its name. */
export async function readEpubMetadata(data: ArrayBuffer, fallbackTitle: string): Promise<{ title: string; author: string; chapters: number }> {
  let book: Book | null = null
  try {
    book = openEpub(data)
    // Let epub.js finish its own loading before the book is destroyed, or its pending steps throw.
    await withTimeout(book.ready, 5000)
    const meta = await withTimeout(book.loaded.metadata, 5000)
    const spine = await withTimeout(book.loaded.spine as unknown as Promise<{ length?: number }>, 5000)
    const title = (meta?.title ?? '').trim() || fallbackTitle
    const author = (meta?.creator ?? '').trim()
    const chapters = (spine as { length?: number } | null)?.length ?? 0
    return { title, author, chapters }
  } catch {
    return { title: fallbackTitle, author: '', chapters: 0 }
  } finally {
    book?.destroy()
  }
}
