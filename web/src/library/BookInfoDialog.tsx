import { useEffect, useId, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type BookRecord } from '../data/db'
import { useI18n } from '../i18n/I18n'
import type { Lang } from '../i18n/strings'
import { CloseIcon } from '../ui/icons'
import './library.css'

/**
 * A file's size as people read it (decimal units, as Finder and Explorer's details show): kilobytes
 * without decimals below one megabyte, megabytes with one decimal above, in the interface's numbers.
 */
export function formatSize(bytes: number, lang: Lang): string {
  const size = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  if (size < 1_000_000) {
    const kb = Math.max(1, Math.round(size / 1000))
    return `${new Intl.NumberFormat(lang).format(kb)} KB`
  }
  const mb = size / 1_000_000
  return `${new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(mb)} MB`
}

/** A moment as a date and a time in the interface language. */
export function formatMoment(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(ms))
}

export interface BookCounts {
  threads: number
  journal: number
  highlights: number
}

/** Threads (page translations are not threads), journal entries and highlights of a book. */
export async function bookCounts(bookId: string): Promise<BookCounts> {
  const [cards, entries] = await Promise.all([db.cards.where('bookId').equals(bookId).toArray(), db.journal.where('bookId').equals(bookId).toArray()])
  return {
    threads: cards.filter((c) => c.translatedPage === undefined).length,
    journal: entries.length,
    highlights: entries.filter((e) => e.source === 'highlight').length,
  }
}

interface Props {
  book: BookRecord
  onClose: () => void
}

/** What is known about a book: its file, its pages, when it was added and read, and what was made in it. */
export function BookInfoDialog({ book: initial, onClose }: Props) {
  const { t, lang } = useI18n()
  const headingId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  // The record as it is now (renamed, opened since).
  const book = useLiveQuery(() => db.books.get(initial.id), [initial.id], initial) ?? initial
  const counts = useLiveQuery(() => bookCounts(initial.id), [initial.id])

  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open && typeof d.showModal === 'function') d.showModal()
  }, [])

  const rows: [string, string][] = [
    [t.bookTitleField, book.title],
    ...(book.author ? ([[t.bookAuthorField, book.author]] as [string, string][]) : []),
    [t.infoFormat, book.format === 'pdf' ? 'PDF' : 'EPUB'],
    [t.infoSize, formatSize(book.size, lang)],
    [book.format === 'pdf' ? t.infoPages : t.infoChapters, new Intl.NumberFormat(lang).format(book.pageCount)],
    [t.infoAdded, book.addedAt > 0 ? formatMoment(book.addedAt, lang) : '—'],
    [t.infoOpened, book.openedAt > 0 ? formatMoment(book.openedAt, lang) : t.infoNeverOpened],
  ]
  const countRows: [string, number | undefined][] = [
    [t.infoThreads, counts?.threads],
    [t.infoJournal, counts?.journal],
    [t.infoHighlights, counts?.highlights],
  ]

  return (
    <dialog ref={dialogRef} className="edit-book-dialog book-info-dialog" aria-labelledby={headingId} onClose={onClose}>
      <header className="dialog-header">
        <h2 id={headingId}>{t.bookInfo}</h2>
        <button type="button" className="icon-button" aria-label={t.close} onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </header>
      <dl className="book-info">
        {rows.map(([label, value]) => (
          <div key={label} className="book-info-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <dl className="book-info book-info-counts">
        {countRows.map(([label, value]) => (
          <div key={label} className="book-info-row">
            <dt>{label}</dt>
            <dd>{value === undefined ? '…' : new Intl.NumberFormat(lang).format(value)}</dd>
          </div>
        ))}
      </dl>
      <footer className="edit-book-actions">
        <button type="button" className="primary-button" onClick={onClose}>
          {t.close}
        </button>
      </footer>
    </dialog>
  )
}
