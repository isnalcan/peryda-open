import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18n'
import { detectLang, LANGS, STRINGS, type Lang } from '../i18n/strings'
import { AsterismIcon, BookIcon, KeyIcon } from '../ui/icons'

interface Props {
  lang: Lang
  /** The reader chose a language: the whole app goes on in it (and remembers it). */
  onLang: (lang: Lang) => void
  onAddKey: () => void
  onLater: () => void
}

/** Each language's name in that language. */
export const LANG_NAMES: Record<Lang, string> = { tr: 'Türkçe', en: 'English', de: 'Deutsch', es: 'Español' }

/** The four languages, the browser's own first. */
export function languageOrder(first: Lang = detectLang()): Lang[] {
  return [first, ...LANGS.filter((l) => l !== first)]
}

/**
 * First run: the language first, asked in all four languages (owner, 16 Nov: the app goes on in the
 * language chosen), then what Peryda does here and where the reader's text goes. The browser's
 * language is offered first; it can be changed later in Settings.
 */
export function WelcomeDialog({ lang, onLang, onAddKey, onLater }: Props) {
  const { t } = useI18n()
  const ref = useRef<HTMLDialogElement>(null)
  const [languageChosen, setLanguageChosen] = useState(false)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])

  if (!languageChosen) {
    return (
      <dialog ref={ref} className="welcome-dialog" onCancel={(e) => e.preventDefault()} aria-labelledby="welcome-title">
        <img className="welcome-logo" src="/brand/peryda-appicon.svg" alt="" width={56} height={56} />
        <h2 id="welcome-title">{STRINGS[lang].chooseLanguage}</h2>
        <p className="welcome-languages-hint">
          {LANGS.filter((l) => l !== lang)
            .map((l) => STRINGS[l].chooseLanguage)
            .join(' · ')}
        </p>
        <div className="welcome-languages" role="radiogroup" aria-labelledby="welcome-title">
          {languageOrder().map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === lang}
              lang={l}
              className={`welcome-language${l === lang ? ' is-current' : ''}`}
              onClick={() => {
                onLang(l)
              }}
            >
              <span>{LANG_NAMES[l]}</span>
              {l === lang && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
        <div className="welcome-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              onLang(lang)
              setLanguageChosen(true)
            }}
          >
            {STRINGS[lang].next}
          </button>
        </div>
      </dialog>
    )
  }

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
        {/* Back to the language, should the wrong one have been chosen. */}
        <button type="button" className="ghost-button welcome-back" title={t.language} onClick={() => setLanguageChosen(false)}>
          🌐 {LANG_NAMES[lang]}
        </button>
        <button type="button" className="ghost-button" onClick={onLater}>{t.welcomeLater}</button>
        <button type="button" className="primary-button" onClick={onAddKey}>{t.welcomeAddKey}</button>
      </div>
    </dialog>
  )
}
