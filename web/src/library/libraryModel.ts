import type { BookRecord } from '../data/db'
import type { Lang, Strings } from '../i18n/strings'

/** When a book last mattered: opened, or added if it has not been opened since. */
export function recency(book: Pick<BookRecord, 'openedAt' | 'addedAt'>): number {
  return Math.max(book.openedAt || 0, book.addedAt || 0)
}

/** Books matching the search (title or author, case-insensitive in the reader's language), most recently read first. */
export function shelf<T extends Pick<BookRecord, 'title' | 'author' | 'openedAt' | 'addedAt'>>(books: readonly T[], query: string, lang: Lang): T[] {
  const q = query.trim().toLocaleLowerCase(lang)
  const matches = (s: string) => s.toLocaleLowerCase(lang).includes(q)
  return books.filter((b) => !q || matches(b.title) || matches(b.author)).sort((a, b) => recency(b) - recency(a))
}

export interface RelativeTime {
  value: number
  unit: Intl.RelativeTimeFormatUnit
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The largest whole unit that fits, as a negative (past) value. Under a minute is 0 seconds, which
 * reads as "now" rather than "0 seconds ago"; a time in the future (another device's clock) counts as now.
 */
export function relativeTime(then: number, now: number): RelativeTime {
  const diff = now - then
  const ago = Number.isFinite(diff) ? Math.max(0, diff) : 0
  if (ago < MINUTE) return { value: 0, unit: 'second' }
  if (ago < HOUR) return { value: -Math.floor(ago / MINUTE), unit: 'minute' }
  if (ago < DAY) return { value: -Math.floor(ago / HOUR), unit: 'hour' }
  const days = Math.floor(ago / DAY)
  if (days < 7) return { value: -days, unit: 'day' }
  if (days < 30) return { value: -Math.floor(days / 7), unit: 'week' }
  if (days < 365) return { value: -Math.max(1, Math.floor(days / 30.44)), unit: 'month' }
  return { value: -Math.floor(days / 365), unit: 'year' }
}

/** "2 days ago", "yesterday", "now" in the reader's language. */
export function formatRelative(then: number, now: number, lang: Lang): string {
  const { value, unit } = relativeTime(then, now)
  return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(value, unit)
}

/**
 * The line under a tile's title: "Author · 12 / 300 · Last read 2 days ago". A PDF shows where the
 * reader is once past the first page, otherwise its length; an EPUB shows its format.
 */
export function bookDetail(
  book: Pick<BookRecord, 'author' | 'format' | 'pageCount' | 'openedAt'>,
  page: number | undefined,
  t: Pick<Strings, 'pages' | 'pageOf' | 'lastRead'>,
  lang: Lang,
  now: number,
): string {
  const parts: string[] = []
  const author = book.author.trim()
  if (author) parts.push(author)
  if (book.format === 'pdf') {
    const at = page !== undefined && book.pageCount > 0 ? Math.min(page, book.pageCount) : page
    parts.push(at !== undefined && at > 1 ? t.pageOf(at, book.pageCount) : t.pages(book.pageCount))
  } else {
    parts.push('EPUB')
  }
  if (book.openedAt > 0) parts.push(t.lastRead(formatRelative(book.openedAt, now, lang)))
  return parts.join(' · ')
}
