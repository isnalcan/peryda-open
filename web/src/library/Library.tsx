import { useEffect, useMemo, useRef, useState, type DragEvent, type SVGProps } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, deleteBook, type BookRecord, type ReadingPosition } from '../data/db'
import { useI18n } from '../i18n/I18n'
import { GearIcon, InfoIcon, PlusIcon, TrashIcon } from '../ui/icons'
import { coverFit, forgetCover, loadCover, peekCover, type CoverImage } from './covers'
import { bookDetail, shelf } from './libraryModel'
import { isImageFile } from './imagePdf'
import { EditBookDialog } from './EditBookDialog'
import { BookInfoDialog } from './BookInfoDialog'
import './library.css'
import { LibraryArt } from './LibraryArt'

interface Props {
  onOpen: (book: BookRecord) => void
  onOpenSettings: () => void
  /** The Gemini batch jobs a deleted book was still waiting on, so they can be cancelled. */
  onBookDeleted?: (waitingJobs: string[]) => void
  /** A message to show once when the library opens (for example after a book failed to open). */
  notice?: string | null
}

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function LineIcon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  )
}

const PencilIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </LineIcon>
)

const SearchIcon = (p: IconProps) => (
  <LineIcon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </LineIcon>
)

/** The current time, refreshed every minute so "Last read now" moves on by itself. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

export function Library({ onOpen, onOpenSettings, onBookDeleted, notice }: Props) {
  const { t, lang } = useI18n()
  const books = useLiveQuery(() => db.books.toArray(), [], [] as BookRecord[])
  const positions = useLiveQuery(() => db.positions.toArray(), [], [] as ReadingPosition[])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<BookRecord | null>(null)
  const [info, setInfo] = useState<BookRecord | null>(null)
  const [menu, setMenu] = useState<{ book: BookRecord; x: number; y: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(notice ?? null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const now = useMinuteClock()

  const shown = useMemo(() => shelf(books, query, lang), [books, query, lang])
  const pageOf = useMemo(() => new Map(positions.map((p) => [p.bookId, p.page])), [positions])

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 3200)
    return () => window.clearTimeout(timer)
  }, [message])

  const add = async (files: readonly File[]) => {
    setBusy(true)
    let last: BookRecord | null = null
    // The PDF and EPUB engines load only when a file is added.
    const { ImportError, importBook, importImages } = await import('./importBook')
    const refuse = (error: unknown) => {
      const refused = error instanceof ImportError ? error : null
      if (refused?.kind === 'unsupported') setMessage(t.unsupportedFile)
      else if (refused?.kind === 'tooLarge') setMessage(t.fileTooLarge(refused.limitMb))
      else if (refused?.kind === 'heic') setMessage(t.heicUnsupported)
      else if (refused?.kind === 'tooManyPhotos') setMessage(t.tooManyPhotos(refused.limitPhotos))
      else setMessage(t.importFailed)
    }
    // Photos chosen or dropped together become one book, a page each; PDFs and EPUBs are added one by one.
    const images = files.filter(isImageFile)
    for (const file of files) {
      if (images.includes(file)) continue
      try {
        last = await importBook(file)
      } catch (error) {
        refuse(error)
      }
    }
    if (images.length) {
      try {
        last = await importImages(images)
        if (images.length > 1) setMessage(t.imagesAsBook(images.length))
      } catch (error) {
        refuse(error)
      }
    }
    setBusy(false)
    if (last && files.length === 1) onOpen(last)
  }

  const remove = (book: BookRecord) => {
    if (!window.confirm(t.deleteBookConfirm)) return
    void deleteBook(book.id).then((jobs) => {
      forgetCover(book.id)
      if (jobs.length) onBookDeleted?.(jobs)
    })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) void add(files)
  }

  return (
    <div
      className={`library${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <LibraryArt />
      <header className="library-header">
        <img className="library-logo" src="/brand/peryda-lockup-horizontal-green.svg" alt="Peryda" />
        {books.length > 0 && (
          <label className="library-search">
            <SearchIcon size={16} />
            <input
              type="search"
              value={query}
              placeholder={t.searchBooks}
              aria-label={t.searchBooks}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
        <div className="library-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => inputRef.current?.click()}>
            <PlusIcon size={16} /> {busy ? t.importing : t.addBook}
          </button>
          <button type="button" className="icon-button" aria-label={t.settings} title={t.settings} onClick={onOpenSettings}>
            <GearIcon size={18} />
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.epub,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,application/epub+zip,image/jpeg,image/png,image/webp,image/heic,image/heif"
          multiple
          hidden
          onChange={(e) => {
            // Copy the files first: in Chromium/WebView2 clearing the input also empties this FileList,
            // and add() reads the files only after the importer has loaded.
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length) void add(files)
          }}
        />
      </header>

      <h1 className="library-title">{t.libraryTitle}</h1>
      {books.length === 0 ? (
        <p className="library-empty">{t.libraryEmpty}</p>
      ) : (
        <ul className="book-grid">
          {shown.map((book) => (
            <BookTile
              key={book.id}
              book={book}
              detail={bookDetail(book, pageOf.get(book.id), t, lang, now)}
              onOpen={onOpen}
              onEdit={setEditing}
              onInfo={setInfo}
              onDelete={remove}
              onMenu={(x, y) => setMenu({ book, x, y })}
            />
          ))}
        </ul>
      )}
      {editing && <EditBookDialog key={editing.id} book={editing} onClose={() => setEditing(null)} />}
      {info && <BookInfoDialog key={info.id} book={info} onClose={() => setInfo(null)} />}
      {menu && (
        <BookMenu
          x={menu.x}
          y={menu.y}
          onInfo={() => setInfo(menu.book)}
          onEdit={() => setEditing(menu.book)}
          onDelete={() => remove(menu.book)}
          onClose={() => setMenu(null)}
        />
      )}
      {dragging && <div className="drop-overlay">{t.dropHere}</div>}
      {message && <div className="toast" role="status">{message}</div>}
    </div>
  )
}

interface TileProps {
  book: BookRecord
  detail: string
  onOpen: (book: BookRecord) => void
  onEdit: (book: BookRecord) => void
  onInfo: (book: BookRecord) => void
  onDelete: (book: BookRecord) => void
  /** A right-click: the book's menu at that point of the window. */
  onMenu: (x: number, y: number) => void
}

/** A right-click on a book: its info, its title and author, deleting it. */
function BookMenu(props: { x: number; y: number; onInfo: () => void; onEdit: () => void; onDelete: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector('button')?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  const pick = (fn: () => void) => () => {
    props.onClose()
    fn()
  }
  // Kept inside the window.
  const left = Math.min(props.x, window.innerWidth - 230)
  const top = Math.min(props.y, window.innerHeight - 140)
  return (
    <div ref={ref} className="popover menu book-menu" role="menu" style={{ left: Math.max(8, left), top: Math.max(8, top) }}>
      <button type="button" role="menuitem" onClick={pick(props.onInfo)}>
        <span className="menu-check"><InfoIcon size={14} /></span>
        {t.bookInfo}
      </button>
      <button type="button" role="menuitem" onClick={pick(props.onEdit)}>
        <span className="menu-check"><PencilIcon size={14} /></span>
        {t.editInfo}
      </button>
      <button type="button" role="menuitem" onClick={pick(props.onDelete)}>
        <span className="menu-check"><TrashIcon size={14} /></span>
        {t.deleteBook}
      </button>
    </div>
  )
}

function BookTile({ book, detail, onOpen, onEdit, onInfo, onDelete, onMenu }: TileProps) {
  const { t } = useI18n()
  return (
    <li
      className="book-tile"
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <button type="button" className="book-open" onClick={() => onOpen(book)}>
        <CoverArt id={book.id} fingerprint={book.fingerprint} format={book.format} title={book.title} />
        <span className="book-meta">
          <span className="book-title">{book.title}</span>
          <span className="book-sub">{detail}</span>
        </span>
      </button>
      <div className="book-tools">
        <button type="button" className="icon-button book-tool" aria-label={t.bookInfo} title={t.bookInfo} onClick={() => onInfo(book)}>
          <InfoIcon size={15} />
        </button>
        <button type="button" className="icon-button book-tool" aria-label={t.editInfo} title={t.editInfo} onClick={() => onEdit(book)}>
          <PencilIcon size={15} />
        </button>
        <button type="button" className="icon-button book-tool" aria-label={t.deleteBook} title={t.deleteBook} onClick={() => onDelete(book)}>
          <TrashIcon size={15} />
        </button>
      </div>
    </li>
  )
}

interface CoverProps {
  id: string
  fingerprint: string
  format: BookRecord['format']
  title: string
}

/**
 * A fixed 3:4 frame. The picture is laid over the frame and never sizes it, so a wide scan cannot
 * spill over its neighbour. The cover is made only when the tile comes near the screen.
 */
function CoverArt({ id, fingerprint, format, title }: CoverProps) {
  const frameRef = useRef<HTMLSpanElement>(null)
  const [cover, setCover] = useState<CoverImage | null | undefined>(() => peekCover({ id, fingerprint }))
  // Only a cover that arrives while the tile is on screen fades in; a cached one just appears.
  const [arrived, setArrived] = useState(false)

  useEffect(() => {
    const known = peekCover({ id, fingerprint })
    setCover(known)
    if (known !== undefined) return
    let alive = true
    const start = () => {
      loadCover({ id, fingerprint, format }).then(
        (image) => {
          if (!alive) return
          setCover(image)
          setArrived(true)
        },
        () => alive && setCover(null),
      )
    }
    const frame = frameRef.current
    if (!frame || typeof IntersectionObserver === 'undefined') {
      start()
      return () => {
        alive = false
      }
    }
    const watcher = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        watcher.disconnect()
        start()
      },
      { rootMargin: '600px 0px' },
    )
    watcher.observe(frame)
    return () => {
      alive = false
      watcher.disconnect()
    }
  }, [id, fingerprint, format])

  return (
    <span ref={frameRef} className="cover-frame" data-format={format} aria-hidden="true">
      {cover ? (
        <img
          className="cover-picture"
          data-fit={coverFit(cover.width, cover.height)}
          data-arrived={arrived || undefined}
          src={cover.url}
          alt=""
          draggable={false}
          decoding="async"
          onError={() => setCover(null)}
        />
      ) : (
        <span className="cover-placeholder">
          <span className="cover-placeholder-title">{title}</span>
        </span>
      )}
    </span>
  )
}
