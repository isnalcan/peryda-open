import Dexie, { type EntityTable } from 'dexie'
import type { YarnCard } from '../ilmek/types'
import type { HighlightColor } from '../reader/highlightColors'

export type BookFormat = 'pdf' | 'epub'

export interface BookRecord {
  id: string
  title: string
  author: string
  format: BookFormat
  pageCount: number
  size: number
  /** SHA-256 of the file, to notice the same book being added twice. */
  fingerprint: string
  addedAt: number
  openedAt: number
}

export interface BookFile {
  bookId: string
  blob: Blob
}

export interface ReadingPosition {
  bookId: string
  /** EPUB books remember a CFI instead of a camera. */
  cfi?: string
  panX: number
  panY: number
  scale: number
  page: number
  updatedAt: number
}

/** Where on a page a highlight lies: its lines, as fractions of the page (0…1). */
export interface HighlightMark {
  pageNumber: number
  lineRects: { x: number; y: number; width: number; height: number }[]
}

export interface JournalRecord {
  id: string
  bookId: string
  /**
   * 'clip' = a passage clipped from the page; 'thread' = saved from an İlmek card; 'note' = the reader's
   * note; 'highlight' = a passage the reader highlighted ("Vurgula"), drawn on its page from `marks`.
   */
  source: 'clip' | 'thread' | 'note' | 'highlight'
  quote: string
  text: string
  pageNumber: number
  cardId?: string
  /** For a highlight: the lines to draw on the page. Deleting the entry removes them. */
  marks?: HighlightMark[]
  /** For a highlight: its colour when not yellow (owner, 16 Nov; absent = yellow). */
  highlightColor?: Exclude<HighlightColor, 'yellow'>
  createdAt: number
}

/**
 * A library cover made from the book file (a PDF's first page, an EPUB's own cover picture). It is a
 * cache: never backed up, made again when missing or when the file's fingerprint changes.
 */
export interface CoverRecord {
  bookId: string
  fingerprint: string
  /** null when the file has no cover picture, so it is not looked for again. */
  blob: Blob | null
  width: number
  height: number
  createdAt: number
  /**
   * Set (with no picture) while a cover is being made and after making it failed: how many times it was
   * tried. A mark left behind means the last try never finished (the tab may have crashed on it).
   */
  attempts?: number
}

export interface PrefRecord {
  key: string
  value: unknown
}

export interface VaultRecord {
  id: string
  /** Non-extractable AES-GCM key (structured-cloned CryptoKey) or the encrypted payload. */
  key?: CryptoKey
  iv?: Uint8Array
  data?: ArrayBuffer
}

export class PerydaDB extends Dexie {
  books!: EntityTable<BookRecord, 'id'>
  files!: EntityTable<BookFile, 'bookId'>
  cards!: EntityTable<YarnCard, 'id'>
  positions!: EntityTable<ReadingPosition, 'bookId'>
  journal!: EntityTable<JournalRecord, 'id'>
  prefs!: EntityTable<PrefRecord, 'key'>
  vault!: EntityTable<VaultRecord, 'id'>
  covers!: EntityTable<CoverRecord, 'bookId'>

  constructor(name = 'peryda') {
    super(name)
    this.version(1).stores({
      books: 'id, fingerprint, openedAt, addedAt',
      files: 'bookId',
      cards: 'id, bookId, parentCardId, createdAt',
      positions: 'bookId',
      journal: 'id, bookId, createdAt, cardId',
      prefs: 'key',
      vault: 'id',
    })
    // Version 2 only adds the cover cache; every version-1 store is kept as it was.
    this.version(2).stores({
      books: 'id, fingerprint, openedAt, addedAt',
      files: 'bookId',
      cards: 'id, bookId, parentCardId, createdAt',
      positions: 'bookId',
      journal: 'id, bookId, createdAt, cardId',
      prefs: 'key',
      vault: 'id',
      covers: 'bookId',
    })
  }
}

export const db = new PerydaDB()

export function newId(): string {
  return crypto.randomUUID()
}

export async function sha256Hex(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function getPref<T>(key: string, fallback: T): Promise<T> {
  const row = await db.prefs.get(key)
  return row === undefined ? fallback : (row.value as T)
}

export async function setPref(key: string, value: unknown): Promise<void> {
  await db.prefs.put({ key, value })
}

/** Preferences kept per book (`<name>:<bookId>`), removed with the book. */
export const PER_BOOK_PREFS = ['translateLang', 'journalSummary', 'summaryCollapsed', 'cardTextScale', 'translationTextScale', 'readings', 'pageScale'] as const

/**
 * Removes a book and everything that belongs to it, in one transaction. Returns the Gemini batch jobs its
 * page translations and page readings were still waiting on, so the caller can cancel them.
 */
export async function deleteBook(bookId: string): Promise<string[]> {
  return db.transaction('rw', [db.books, db.files, db.cards, db.positions, db.journal, db.covers, db.prefs], async () => {
    const cards = await db.cards.where('bookId').equals(bookId).toArray()
    const jobs = cards.filter((c) => c.batchJob).map((c) => c.batchJob!)
    const readings = (await db.prefs.get(`readings:${bookId}`))?.value
    if (Array.isArray(readings)) for (const r of readings) if (r && typeof r.job === 'string') jobs.push(r.job)
    await db.prefs.bulkDelete(PER_BOOK_PREFS.map((name) => `${name}:${bookId}`))
    await db.books.delete(bookId)
    await db.files.delete(bookId)
    await db.covers.delete(bookId)
    await db.cards.where('bookId').equals(bookId).delete()
    await db.positions.delete(bookId)
    await db.journal.where('bookId').equals(bookId).delete()
    return [...new Set(jobs)]
  })
}
