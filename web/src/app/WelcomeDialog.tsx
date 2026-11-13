import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18n'
import { AsterismIcon, BookIcon, KeyIcon } from '../ui/icons'

interface Props {
  onAddKey: () => void
  onLater: () => void
}

/** First run: what Peryda does here and where the reader's text goes. */
export function WelcomeDialog({ onAddKey, onLater }: Props) {
  const { t } = useI18n()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog ref={ref} className="welcome-dialog" onCancel={onLater} aria-labelledby="welcome-title">
      <img className="welcome-logo" src="/brand/peryda-appicon.svg" alt="" width={56} height={56} />
      <h2 id="welcome-title">{t.welcomeTitle}</h2>
      <ul>
        <li>
          <BookIcon size={18} /> <span>{t.welcomeRead}</span>
        </li>
        <li>
          <AsterismIcon size={18} /> <span>{t.welcomeIlmek}</span>
        </li>
        <li>
          <KeyIcon size={18} /> <span>{t.welcomeKey}</span>
        </li>
      </ul>
      <div className="welcome-actions">
        <button type="button" className="ghost-button" onClick={onLater}>{t.welcomeLater}</button>
        <button type="button" className="primary-button" onClick={onAddKey}>{t.welcomeAddKey}</button>
      </div>
    </dialog>
  )
}
