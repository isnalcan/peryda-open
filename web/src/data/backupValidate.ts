import { LANGS } from '../i18n/strings'
import { GEOMETRY } from '../ilmek/geometry'
import { PROVIDERS } from '../ai/provider'
import { isBatchName } from '../ai/batch'
import { isHighlightColor } from '../reader/highlightColors'
import { YARN_COLORS, type AnchorSource, type ArchiveLink, type NormalizedRect, type PdfYarnAnchor, type YarnCard, type YarnMessage } from '../ilmek/types'
import type { BookFormat, BookRecord, JournalRecord, PrefRecord, ReadingPosition } from './db'

/**
 * Checks every record of a backup before anything is written. A backup is a file people share, so it is
 * read like any other untrusted input: one wrong value must not break the library or a book for good.
 * Ids that tie records together must be well formed or the whole backup is refused; other bad records
 * are dropped, and odd fields are put right. Books' sizes and fingerprints are not read from the file:
 * the caller works them out from the book files themselves.
 */

/** Ids made by the app are UUIDs; older and test data use short names. Nothing else is accepted. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export class InvalidBackup extends Error {}

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v)
const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const whole = (v: unknown, fallback: number, min = 0): number => Math.max(min, Math.round(finite(v, fallback)))
const text = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.slice(0, max) : fallback)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v)

const FORMATS: readonly BookFormat[] = ['pdf', 'epub']
const SOURCES: readonly JournalRecord['source'][] = ['clip', 'thread', 'note', 'highlight']

/** Limits for a highlight's marks: per entry, and lines per mark. */
export const MAX_MARKS = 50
export const MAX_MARK_RECTS = 200

/** A line of a highlight: a part of the page (0…1 on both axes). */
function markRect(raw: unknown): NormalizedRect | null {
  const r = validRect(raw)
  if (!r) return null
  const inPage = (v: number) => v >= 0 && v <= 1
  return inPage(r.x) && inPage(r.y) && inPage(r.width) && inPage(r.height) && r.x + r.width <= 1.0001 && r.y + r.height <= 1.0001 ? r : null
}

/**
 * A highlight's marks (audit of 15 Nov's "Vurgula"): at most MAX_MARKS marks of MAX_MARK_RECTS lines, each
 * on a page of the book (when its page count is known) and within the page. A mark left with no line is
 * dropped; an entry left with no mark keeps its quote.
 */
function validMarks(raw: unknown, pageCount?: number): JournalRecord['marks'] {
  const marks = list(raw)
    .slice(0, MAX_MARKS)
    .flatMap((m) => {
      if (!isObject(m)) return []
      const page = whole(m.pageNumber, 0)
      if (page < 1 || (pageCount !== undefined && page > pageCount)) return []
      const lineRects = list(m.lineRects).slice(0, MAX_MARK_RECTS).map(markRect).filter((r): r is NormalizedRect => r !== null)
      return lineRects.length ? [{ pageNumber: page, lineRects }] : []
    })
  return marks.length ? marks : undefined
}
const ANCHOR_SOURCES: readonly AnchorSource[] = ['pdf_text', 'pdf_area', 'epub_text', 'card']
const KINDS: readonly YarnCard['kind'][] = [...YARN_COLORS, 'question', 'bridge', 'translate']
const THEMES = ['system', 'light', 'dark'] as const

const LONG_TEXT = 1_000_000
const SHORT_TEXT = 1_000

/** The ids a backup must get right; one wrong id refuses the whole file. */
export function requireIds(books: unknown[], cards: unknown[], journal: unknown[]): void {
  for (const b of books) if (!isObject(b) || !isId(b.id)) throw new InvalidBackup('book id')
  for (const c of cards) if (isObject(c) && !isId(c.bookId)) throw new InvalidBackup('card book id')
  for (const j of journal) if (isObject(j) && !isId(j.bookId)) throw new InvalidBackup('journal book id')
}

/** A book record without its size and fingerprint (worked out from the file). Null: not importable. */
export function validBook(raw: unknown): Omit<BookRecord, 'size' | 'fingerprint'> | null {
  if (!isObject(raw) || !isId(raw.id) || !oneOf(raw.format, FORMATS)) return null
  return {
    id: raw.id,
    title: text(raw.title, SHORT_TEXT).trim(),
    author: text(raw.author, SHORT_TEXT).trim(),
    format: raw.format,
    pageCount: whole(raw.pageCount, 0),
    addedAt: finite(raw.addedAt, Date.now()),
    openedAt: finite(raw.openedAt, 0),
  }
}

function validRect(raw: unknown): NormalizedRect | null {
  if (!isObject(raw)) return null
  const r = { x: finite(raw.x, NaN), y: finite(raw.y, NaN), width: finite(raw.width, NaN), height: finite(raw.height, NaN) }
  return Object.values(r).every(Number.isFinite) ? r : null
}

function validAnchor(raw: unknown, bookId: string): PdfYarnAnchor | null {
  if (!isObject(raw) || !isId(raw.id) || !oneOf(raw.sourceType, ANCHOR_SOURCES)) return null
  const anchor: PdfYarnAnchor = {
    id: raw.id,
    sourceType: raw.sourceType,
    bookId,
    pageNumber: whole(raw.pageNumber, 0),
    selectedText: text(raw.selectedText, LONG_TEXT),
    lineRects: list(raw.lineRects).slice(0, 1000).map(validRect).filter((r): r is NormalizedRect => r !== null),
    boundingRect: validRect(raw.boundingRect) ?? { x: 0, y: 0, width: 0, height: 0 },
  }
  if (typeof raw.croppedImage === 'string' && raw.croppedImage.startsWith('data:image/')) anchor.croppedImage = raw.croppedImage
  if (isId(raw.sourceCardId)) anchor.sourceCardId = raw.sourceCardId
  if (typeof raw.cfi === 'string') anchor.cfi = text(raw.cfi, 4000)
  if (typeof raw.context === 'string') anchor.context = text(raw.context, 20_000)
  return anchor
}

function validMessage(raw: unknown): YarnMessage | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || !oneOf(raw.role, ['user', 'assistant'] as const) || typeof raw.content !== 'string') return null
  const message: YarnMessage = { id: text(raw.id, 64), role: raw.role, content: text(raw.content, LONG_TEXT), createdAt: finite(raw.createdAt, 0) }
  if (oneOf(raw.state, ['streaming', 'error'] as const)) message.state = raw.state
  if (oneOf(raw.provider, PROVIDERS)) message.provider = raw.provider
  if (typeof raw.model === 'string') message.model = text(raw.model, 200)
  return message
}

function validArchiveLink(raw: unknown): ArchiveLink | null {
  if (!isObject(raw)) return null
  return { bookId: text(raw.bookId, 64), bookTitle: text(raw.bookTitle, SHORT_TEXT), sourceId: text(raw.sourceId, 200), snippet: text(raw.snippet, 10_000) }
}

/** A card with only known kinds, colours and fields; null when it cannot be shown. */
export function validCard(raw: unknown): YarnCard | null {
  if (!isObject(raw) || !isId(raw.id) || !isId(raw.bookId) || !oneOf(raw.color, YARN_COLORS) || !oneOf(raw.kind, KINDS)) return null
  const bookId = raw.bookId
  const card: YarnCard = {
    id: raw.id,
    bookId,
    color: raw.color,
    kind: raw.kind,
    anchors: list(raw.anchors).map((a) => validAnchor(a, bookId)).filter((a): a is PdfYarnAnchor => a !== null),
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    width: Math.min(5000, Math.max(1, finite(raw.width, 390))),
    isPinned: raw.isPinned === true,
    collapsed: raw.collapsed === true,
    messages: list(raw.messages).map(validMessage).filter((m): m is YarnMessage => m !== null),
    createdAt: finite(raw.createdAt, 0),
    updatedAt: finite(raw.updatedAt, 0),
  }
  if (isId(raw.parentCardId)) card.parentCardId = raw.parentCardId
  if (typeof raw.height === 'number' && Number.isFinite(raw.height)) card.height = Math.min(5000, Math.max(1, raw.height))
  if (raw.translatedPage !== undefined) {
    const page = whole(raw.translatedPage, 0)
    if (page < 1) return null
    card.translatedPage = page
    card.translationLanguage = oneOf(raw.translationLanguage, LANGS) ? raw.translationLanguage : 'en'
  }
  // Only a name Google could have given; a page left waiting without one is offered a retry on load.
  if (isBatchName(raw.batchJob)) card.batchJob = raw.batchJob
  if (Array.isArray(raw.archiveLinks)) card.archiveLinks = raw.archiveLinks.map(validArchiveLink).filter((l): l is ArchiveLink => l !== null)
  if (raw.archiveDismissed === true) card.archiveDismissed = true
  return card
}

export function validJournal(raw: unknown, pageCounts?: ReadonlyMap<string, number>): JournalRecord | null {
  if (!isObject(raw) || !isId(raw.id) || !isId(raw.bookId) || !oneOf(raw.source, SOURCES)) return null
  const entry: JournalRecord = {
    id: raw.id,
    bookId: raw.bookId,
    source: raw.source,
    quote: text(raw.quote, LONG_TEXT),
    text: text(raw.text, LONG_TEXT),
    pageNumber: whole(raw.pageNumber, 0),
    createdAt: finite(raw.createdAt, 0),
  }
  if (isId(raw.cardId)) entry.cardId = raw.cardId
  if (entry.source === 'highlight') {
    const marks = validMarks(raw.marks, pageCounts?.get(entry.bookId))
    if (marks) entry.marks = marks
    // One of the four highlighter colours; yellow (and anything unknown) is kept as no colour.
    if (isHighlightColor(raw.highlightColor) && raw.highlightColor !== 'yellow') entry.highlightColor = raw.highlightColor
  }
  return entry
}

export function validPosition(raw: unknown): ReadingPosition | null {
  if (!isObject(raw) || !isId(raw.bookId)) return null
  const position: ReadingPosition = {
    bookId: raw.bookId,
    panX: finite(raw.panX, 0),
    panY: finite(raw.panY, 0),
    scale: finite(raw.scale, 0) > 0 ? finite(raw.scale, 1) : 1,
    page: whole(raw.page, 1, 1),
    updatedAt: finite(raw.updatedAt, 0),
  }
  if (typeof raw.cfi === 'string') position.cfi = text(raw.cfi, 4000)
  return position
}

/**
 * The preferences a backup may bring, each with its type. Device settings (remembering keys, the
 * welcome, the open book) are never imported. Per-book ones count only for books this import restores.
 */
export function validPref(raw: unknown, restoredBooks: ReadonlySet<string>): PrefRecord | null {
  if (!isObject(raw) || typeof raw.key !== 'string') return null
  const { key, value } = raw
  switch (key) {
    case 'lang':
      return oneOf(value, LANGS) ? { key, value } : null
    case 'theme':
      return oneOf(value, THEMES) ? { key, value } : null
    case 'pagedReading':
    case 'explainTerms':
      return typeof value === 'boolean' ? { key, value } : null
    case 'highlightColor':
      return isHighlightColor(value) ? { key, value } : null
    case 'epubFontScale':
      return typeof value === 'number' && value >= 70 && value <= 180 ? { key, value } : null
    case 'extractedTextSize':
      return typeof value === 'number' && value >= 14 && value <= 28 ? { key, value } : null
  }
  const perBook = /^(translateLang|journalSummary|summaryCollapsed|cardTextScale|translationTextScale|readings|pageScale):(.+)$/.exec(key)
  if (!perBook || !restoredBooks.has(perBook[2]!)) return null
  if (perBook[1] === 'translateLang') return oneOf(value, LANGS) ? { key, value } : null
  // Pery's summary folded to its title row (owner test 16 Nov).
  if (perBook[1] === 'summaryCollapsed') return typeof value === 'boolean' ? { key, value } : null
  if (perBook[1] === 'readings') {
    // Pages Pery read: only finished text comes back, never a job name (audit 15 Nov, WW-11).
    const pages = new Set<number>()
    const done = list(value)
      .filter((r): r is Raw => isObject(r) && Number.isInteger(r.page) && (r.page as number) >= 1 && (r.page as number) <= 100_000 && r.state === 'done' && typeof r.text === 'string' && r.text.length > 0)
      .filter((r) => !pages.has(r.page as number) && Boolean(pages.add(r.page as number)))
      .slice(0, 2_000)
      .map((r) => ({ page: r.page as number, text: text(r.text, LONG_TEXT), state: 'done', createdAt: finite(r.createdAt, 0) }))
    return done.length ? { key, value: done } : null
  }
  if (perBook[1] === 'cardTextScale' || perBook[1] === 'translationTextScale') return typeof value === 'number' && value >= 0.85 && value <= 1.75 ? { key, value } : null
  // The pages' size: cards the reader placed were moved with it, so it comes back with them.
  if (perBook[1] === 'pageScale') return typeof value === 'number' && Number.isFinite(value) && value >= GEOMETRY.pageScaleMin && value <= GEOMETRY.pageScaleMax ? { key, value } : null
  if (isObject(value) && typeof value.text === 'string' && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)) {
    return { key, value: { text: text(value.text, LONG_TEXT), createdAt: value.createdAt } }
  }
  return null
}
