import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18n'
import { BackIcon, BookIcon, GearIcon, InfoIcon } from '../ui/icons'

/** The reader's bar: back to the library, the tools, the title, the reader's controls, journal and settings. */
export function ReaderTopBar({
  title,
  onBack,
  onOpenSettings,
  onOpenJournal,
  journalOpen,
  onBookInfo,
  leading,
  children,
}: {
  title: string
  onBack: () => void
  onOpenSettings: () => void
  onOpenJournal?: () => void
  journalOpen?: boolean
  /** The book's info (owner, 16 Nov). */
  onBookInfo?: () => void
  leading?: ReactNode
  children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <header className="reader-topbar">
      <button type="button" className="ghost-button" aria-label={t.back} title={t.back} onClick={onBack}>
        <BackIcon size={16} /> <span className="back-label">{t.back}</span>
      </button>
      {leading}
      <h1 className="reader-title" title={title}>{title}</h1>
      <div className="reader-controls">{children}</div>
      {onBookInfo && (
        <button type="button" className="icon-button" aria-label={t.bookInfo} title={t.bookInfo} onClick={onBookInfo}>
          <InfoIcon size={18} />
        </button>
      )}
      {onOpenJournal && (
        <button type="button" className="icon-button" aria-pressed={journalOpen} aria-label={t.journal} title={t.journal} onClick={onOpenJournal}>
          <BookIcon size={18} />
        </button>
      )}
      <button type="button" className="icon-button" aria-label={t.settings} title={t.settings} onClick={onOpenSettings}>
        <GearIcon size={18} />
      </button>
    </header>
  )
}
