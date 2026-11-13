import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { db, type BookRecord } from '../data/db'
import { useI18n } from '../i18n/I18n'
import { CloseIcon } from '../ui/icons'
import './library.css'

interface Props {
  book: BookRecord
  onClose: () => void
}

/** The reader's own title and author for a book. */
export function EditBookDialog({ book, onClose }: Props) {
  const { t } = useI18n()
  const headingId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author)
  const [saving, setSaving] = useState(false)
  const blank = !title.trim()

  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open && typeof d.showModal === 'function') d.showModal()
    // Renaming usually replaces the whole title, so it starts selected.
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (blank || saving) return
    setSaving(true)
    try {
      await db.books.update(book.id, { title: title.trim(), author: author.trim() })
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <dialog ref={dialogRef} className="edit-book-dialog" aria-labelledby={headingId} onClose={onClose}>
      <form onSubmit={(e) => void save(e)}>
        <header className="dialog-header">
          <h2 id={headingId}>{t.editInfo}</h2>
          <button type="button" className="icon-button" aria-label={t.close} onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="edit-book-fields">
          <label>
            {t.bookTitleField}
            <input ref={titleRef} type="text" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            {t.bookAuthorField}
            <input type="text" value={author} autoComplete="off" onChange={(e) => setAuthor(e.target.value)} />
          </label>
        </div>
        <footer className="edit-book-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            {t.cancel}
          </button>
          <button type="submit" className="primary-button" disabled={blank || saving}>
            {t.save}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
