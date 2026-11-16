import JSZip from 'jszip'
import { db, sha256Hex, type BookRecord, type JournalRecord, type PrefRecord, type ReadingPosition } from './db'
import type { YarnCard } from '../ilmek/types'
import { checkEpubArchive, openZip, readEntry, readText } from '../epub/zipLimits'
import { MAX_IMPORT_MB } from '../library/importLimits'
import { requireIds, validBook, validCard, validJournal, validPosition, validPref } from './backupValidate'

/**
 * One-file backup of the library: book files, threads, journal, reading positions and preferences.
 * The AI keys and the vault's encryption key are never included.
 */

export const BACKUP_FORMAT = 'peryda-backup'
export const BACKUP_VERSION = 1

interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: number
  createdAt: number
  books: BookRecord[]
  cards: YarnCard[]
  journal: JournalRecord[]
  positions: ReadingPosition[]
  prefs: PrefRecord[]
}


export async function exportBackup(): Promise<Blob> {
  const [books, cards, journal, positions, prefs, files] = await Promise.all([
    db.books.toArray(),
    db.cards.toArray(),
    db.journal.toArray(),
    db.positions.toArray(),
    db.prefs.toArray(),
    db.files.toArray(),
  ])
  const bookIds = new Set(books.map((b) => b.id))
  // A library a restore would refuse (or trim) is refused here, so export and restore agree (recheck
  // R16-3): the number of books, the bytes of book files, and highlights per book (the Mac keeps 5,000).
  const highlights = new Map<string, number>()
  for (const j of journal) if (j.source === 'highlight') highlights.set(j.bookId, (highlights.get(j.bookId) ?? 0) + 1)
  const fileBytes = files.reduce((sum, f) => sum + f.blob.size, 0)
  if (books.length > MAX_BACKUP_BOOKS || fileBytes > MAX_BACKUP_TOTAL_BYTES || [...highlights.values()].some((n) => n > MAX_HIGHLIGHTS_PER_BOOK)) {
    throw new BackupError('too large')
  }
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    books,
    cards,
    journal,
    positions,
    // Only what a restore accepts goes into the file (reading preferences, and per book the translation
    // language, journal summary, card text size and the pages Pery read, without job names); device state
    // such as the open book, update choices or launch counts stays on this device (audit 15 Nov, WW-11).
    prefs: prefs.flatMap((p) => {
      const kept = validPref(p, bookIds)
      return kept ? [kept] : []
    }),
  }
  const zip = new JSZip()
  zip.file('peryda.json', JSON.stringify(manifest))
  for (const f of files) {
    const book = books.find((b) => b.id === f.bookId)
    if (book) zip.file(`books/${f.bookId}.${book.format}`, f.blob)
  }
  return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' })
}

export class BackupError extends Error {}

/** The manifest is text; a bigger one is not read. Book files keep to the import limit. */
const MAX_MANIFEST_BYTES = 500_000_000
const MAX_BOOK_BYTES = MAX_IMPORT_MB * 1_000_000
/**
 * A whole backup: at most this many books and this many bytes of book files, read into memory before
 * anything is written. A crafted file of a few megabytes could otherwise declare thousands of books and
 * exhaust the tab (audit 16 Nov, K16-2). The Mac keeps the same limits.
 */
export const MAX_BACKUP_BOOKS = 5_000
export const MAX_BACKUP_TOTAL_BYTES = 2_000_000_000
/** Highlights per book a Mac restore keeps (Backup.maxHighlights); a backup is refused above it. */
export const MAX_HIGHLIGHTS_PER_BOOK = 5_000

/**
 * Restores what is missing; books already in the library (same id or same file) keep their own data.
 * Every record is checked first (see backupValidate.ts), and nothing is written for a backup that is
 * refused.
 */
export async function importBackup(file: Blob): Promise<{ books: number }> {
  let zip: JSZip
  try {
    zip = await openZip(await file.arrayBuffer())
  } catch {
    throw new BackupError('not a zip')
  }
  const manifestFile = zip.file('peryda.json')
  if (!manifestFile) throw new BackupError('missing manifest')
  let manifest: unknown
  try {
    manifest = JSON.parse(await readText(manifestFile, MAX_MANIFEST_BYTES))
  } catch {
    throw new BackupError('bad manifest')
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new BackupError('bad manifest')
  const m = manifest as Record<string, unknown>
  if (m.format !== BACKUP_FORMAT) throw new BackupError('wrong format')
  if (typeof m.version !== 'number' || !Number.isFinite(m.version)) throw new BackupError('bad manifest')
  if (m.version > BACKUP_VERSION) throw new BackupError('newer backup')

  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const [rawBooks, rawCards, rawJournal] = [list(m.books), list(m.cards), list(m.journal)]
  try {
    requireIds(rawBooks, rawCards, rawJournal)
  } catch {
    throw new BackupError('bad ids')
  }

  // Each book's file, read within the limits; an EPUB is checked like an imported one. A book whose file
  // is missing or refused is skipped, with its threads and journal.
  if (rawBooks.length > MAX_BACKUP_BOOKS) throw new BackupError('too many books')
  const books: { record: BookRecord; blob: Blob }[] = []
  let total = 0
  for (const raw of rawBooks) {
    const book = validBook(raw)
    if (!book) continue
    const entry = zip.file(`books/${book.id}.${book.format}`)
    if (!entry) continue
    let bytes: Awaited<ReturnType<typeof readEntry>>['bytes']
    try {
      bytes = (await readEntry(entry, MAX_BOOK_BYTES)).bytes
    } catch {
      continue
    }
    // Past what a whole backup may hold: refused, and nothing is written.
    total += bytes.length
    if (total > MAX_BACKUP_TOTAL_BYTES) throw new BackupError('too large')
    try {
      if (book.format === 'epub') await checkEpubArchive(bytes)
      const fingerprint = await sha256Hex(bytes)
      const blob = new Blob([bytes], { type: book.format === 'pdf' ? 'application/pdf' : 'application/epub+zip' })
      books.push({ record: { ...book, size: blob.size, fingerprint }, blob })
    } catch {
      /* skipped */
    }
  }
  const cards = rawCards.map(validCard).filter((c): c is YarnCard => c !== null)
  const pageCounts = new Map(books.map((b) => [b.record.id, b.record.pageCount]))
  const journal = rawJournal.map((j) => validJournal(j, pageCounts)).filter((j): j is JournalRecord => j !== null)
  const positions = list(m.positions).map(validPosition).filter((p): p is ReadingPosition => p !== null)
  const rawPrefs = list(m.prefs)

  let added = 0
  await db.transaction('rw', [db.books, db.files, db.cards, db.journal, db.positions, db.prefs], async () => {
    const restoredBooks = new Set<string>()
    for (const { record, blob } of books) {
      const sameId = await db.books.get(record.id)
      const sameFile = await db.books.where('fingerprint').equals(record.fingerprint).first()
      if (sameId || sameFile) continue
      await db.books.add(record)
      await db.files.add({ bookId: record.id, blob })
      restoredBooks.add(record.id)
      added += 1
    }
    for (const c of cards) if (restoredBooks.has(c.bookId) && !(await db.cards.get(c.id))) await db.cards.add(c)
    for (const j of journal) if (restoredBooks.has(j.bookId) && !(await db.journal.get(j.id))) await db.journal.add(j)
    for (const p of positions) if (restoredBooks.has(p.bookId)) await db.positions.put(p)
    for (const raw of rawPrefs) {
      const p = validPref(raw, restoredBooks)
      if (p && !(await db.prefs.get(p.key))) await db.prefs.add(p)
    }
  })
  return { books: added }
}

export function backupFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `peryda-yedek-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`
}
