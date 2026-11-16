import { db, newId, sha256Hex, type BookRecord } from '../data/db'
import { closePdf, openPdf, readPdfMetadata } from '../pdf/pdfjs'
import { readEpubMetadata } from '../epub/epub'
import { checkEpubArchive } from '../epub/zipLimits'
import { MAX_IMPORT_MB } from './importLimits'
import { MAX_PHOTOS_PER_BOOK, PictureDecodeError, isHeic, isImageFile, naturalOrder, pictureFromFile, picturesToPdf, type PdfPicture } from './imagePdf'

export { MAX_IMPORT_MB }
const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1_000_000

export class ImportError extends Error {
  /** 'heic': a HEIC/HEIF photo this browser cannot decode. */
  readonly kind: 'unsupported' | 'unreadable' | 'tooLarge' | 'heic' | 'tooManyPhotos'
  readonly limitMb = MAX_IMPORT_MB
  readonly limitPhotos = MAX_PHOTOS_PER_BOOK
  constructor(kind: 'unsupported' | 'unreadable' | 'tooLarge' | 'heic' | 'tooManyPhotos') {
    super(kind)
    this.kind = kind
  }
}

/** Asks the browser once to keep the library when storage runs low; best effort, a refusal changes nothing. */
let persistAsked = false
function askToPersist(): void {
  if (persistAsked) return
  persistAsked = true
  try {
    void navigator.storage?.persist?.().catch(() => undefined)
  } catch {
    /* not offered here */
  }
}

function formatOf(file: File): 'pdf' | 'epub' | null {
  const name = file.name.toLowerCase()
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type === 'application/epub+zip' || name.endsWith('.epub')) return 'epub'
  return null
}

function titleFromName(name: string): string {
  return name.replace(/\.(pdf|epub|jpe?g|png|webp|heic|heif)$/i, '').replace(/[_]+/g, ' ').trim() || name
}

/** Adds a book and its file, unless a book with the same fingerprint is already there (then that one). */
async function addBook(book: BookRecord, blob: Blob): Promise<BookRecord> {
  // Check again inside the write transaction: two imports of the same file can race past the first check.
  const added = await db.transaction('rw', db.books, db.files, async () => {
    const raced = await db.books.where('fingerprint').equals(book.fingerprint).first()
    if (raced) return raced
    await db.books.add(book)
    await db.files.add({ bookId: book.id, blob })
    return book
  })
  askToPersist()
  return added
}

/**
 * Photos of pages become one PDF book, a page per photo in the files' natural name order (IMG_2 before
 * IMG_10). Its fingerprint comes from the photos (the SHA-256 of their SHA-256s, in page order), so the
 * same photos added again find the book already there.
 */
export async function importImages(files: readonly File[], picture: (file: File) => Promise<PdfPicture> = pictureFromFile): Promise<BookRecord> {
  if (!files.length) throw new ImportError('unsupported')
  if (files.some((f) => !isImageFile(f))) throw new ImportError('unsupported')
  if (files.length > MAX_PHOTOS_PER_BOOK) throw new ImportError('tooManyPhotos')
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_IMPORT_BYTES) throw new ImportError('tooLarge')
  const ordered = naturalOrder(files)
  const hashes: string[] = []
  for (const file of ordered) hashes.push(await sha256Hex(new Uint8Array(await file.arrayBuffer())))
  const fingerprint = await sha256Hex(new TextEncoder().encode(hashes.join('')))
  const existing = await db.books.where('fingerprint').equals(fingerprint).first()
  if (existing) return existing

  const pictures: PdfPicture[] = []
  for (const file of ordered) {
    try {
      pictures.push(await picture(file))
    } catch (error) {
      if (error instanceof PictureDecodeError && isHeic(file)) throw new ImportError('heic')
      throw new ImportError('unreadable')
    }
  }
  const pdf = picturesToPdf(pictures)
  if (pdf.length > MAX_IMPORT_BYTES) throw new ImportError('tooLarge')
  const book: BookRecord = {
    id: newId(),
    title: titleFromName(ordered[0]!.name),
    author: '',
    format: 'pdf',
    pageCount: pictures.length,
    size: pdf.length,
    fingerprint,
    addedAt: Date.now(),
    openedAt: 0,
  }
  return addBook(book, new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }))
}

/** Adds a file to the library, or returns the existing book when the same file was added before. */
export async function importBook(file: File): Promise<BookRecord> {
  if (isImageFile(file)) return importImages([file])
  const format = formatOf(file)
  if (!format) throw new ImportError('unsupported')
  if (file.size > MAX_IMPORT_BYTES) throw new ImportError('tooLarge')
  const buffer = await file.arrayBuffer()
  const fingerprint = await sha256Hex(buffer)
  const existing = await db.books.where('fingerprint').equals(fingerprint).first()
  if (existing) return existing

  let title = titleFromName(file.name)
  let author = ''
  let pageCount = 0
  if (format === 'pdf') {
    try {
      const doc = await openPdf(buffer)
      const meta = await readPdfMetadata(doc, title)
      title = meta.title
      author = meta.author
      pageCount = meta.pageCount
      closePdf(doc)
    } catch {
      throw new ImportError('unreadable')
    }
  } else {
    // A zip bomb (or a file that is not a zip) is refused here, before epub.js or the cover maker unpack it.
    try {
      await checkEpubArchive(buffer)
    } catch {
      throw new ImportError('unreadable')
    }
  }
  if (format === 'epub' && typeof window !== 'undefined' && typeof DOMParser !== 'undefined') {
    const meta = await readEpubMetadata(buffer, title)
    title = meta.title
    author = meta.author
    pageCount = meta.chapters
  }

  const now = Date.now()
  const book: BookRecord = { id: newId(), title, author, format, pageCount, size: file.size, fingerprint, addedAt: now, openedAt: 0 }
  const blob = new Blob([buffer], { type: format === 'pdf' ? 'application/pdf' : 'application/epub+zip' })
  return addBook(book, blob)
}
