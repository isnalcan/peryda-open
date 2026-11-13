import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18n'
import { LANGUAGE_NAMES } from '../ai/compose'
import type { Lang, Strings } from '../i18n/strings'
import type { YarnCard } from '../ilmek/types'
import { Markdown } from '../ui/Markdown'
import { CloseIcon, RetryIcon, TranslateIcon } from '../ui/icons'

interface Props {
  card: YarnCard
  x: number
  y: number
  onHeight: (id: string, height: number) => void
  onRetranslate: (id: string) => void
  onTranslateNow: (id: string) => void
  onRemove: (id: string) => void
  onOpenSettings: () => void
}

function errorText(t: Strings, code: string): string {
  switch (code) {
    case 'no-key':
      return t.noKeyBody
    case 'expired':
      return t.batchExpired
    case 'batch':
      return t.batchFailed
    case 'network':
      return t.errorNetwork
    case 'key':
      return t.errorKey
    case 'quota':
      return t.errorQuota
    case 'blocked':
      return t.errorBlocked
    case 'browser':
      return t.errorBrowser
    default:
      return t.errorUnknown
  }
}

/**
 * A whole-page translation, drawn as a page of its own beside the PDF page: same size, level with it,
 * paper and ink like a printed page. Its text can be selected to open threads, as on the PDF.
 */
function TranslatedPageViewImpl({ card, x, y, onHeight, onRetranslate, onTranslateNow, onRemove, onOpenSettings }: Props) {
  const { t, lang } = useI18n()
  const ref = useRef<HTMLElement>(null)
  const answer = [...card.messages].reverse().find((m) => m.role === 'assistant')
  const language = LANGUAGE_NAMES[(card.translationLanguage as Lang) ?? lang] ?? ''
  const streaming = answer?.state === 'streaming'
  const height = card.height ?? 980

  useEffect(() => {
    onHeight(card.id, height)
  }, [card.id, height, onHeight])

  return (
    <article
      ref={ref}
      className="translated-page"
      data-card-id={card.id}
      style={{ transform: `translate(${x}px, ${y}px)`, width: card.width, height }}
      aria-label={t.translationOf(language, card.translatedPage ?? 0)}
    >
      <header className="translated-page-header">
        <TranslateIcon size={13} />
        <span className="translated-page-title">{t.translationOf(language, card.translatedPage ?? 0).toLocaleUpperCase(lang)}</span>
        {streaming && !card.batchJob && answer?.content && <span className="translated-page-status">· {t.translating}</span>}
        <span className="translated-page-actions">
          {!streaming && (
            <button type="button" className="icon-button" title={t.retranslate} aria-label={t.retranslate} onClick={() => onRetranslate(card.id)}>
              <RetryIcon size={14} />
            </button>
          )}
          <button type="button" className="icon-button" title={t.close} aria-label={t.close} onClick={() => onRemove(card.id)}>
            <CloseIcon size={14} />
          </button>
        </span>
      </header>
      <div className="translated-page-body">
        {!answer || (streaming && !answer.content) ? (
          <Waiting card={card} t={t} onTranslateNow={onTranslateNow} />
        ) : answer.state === 'error' ? (
          <div className="translated-page-error" role="status">
            <p>{errorText(t, answer.content)}</p>
            {answer.content === 'no-key' || answer.content === 'key' ? (
              <button type="button" className="text-button" onClick={onOpenSettings}>{t.openSettings}</button>
            ) : (
              <button type="button" className="text-button" onClick={() => onRetranslate(card.id)}>
                <RetryIcon size={14} /> {t.retry}
              </button>
            )}
          </div>
        ) : (
          <FittingText cardId={card.id} text={answer.content} />
        )}
      </div>
    </article>
  )
}

/** Waiting for the batch job or the direct answer; after a minute in a batch, the reader may stop waiting. */
function Waiting({ card, t, onTranslateNow }: { card: YarnCard; t: Strings; onTranslateNow: (id: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="translated-page-waiting" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{card.batchJob ? t.batchWaiting : t.translating}</span>
      {card.batchJob && now - card.createdAt > 60_000 && (
        <button type="button" className="text-button" onClick={() => onTranslateNow(card.id)}>{t.translateNow}</button>
      )}
    </div>
  )
}

/** Picks the largest reading size (10–16 px) at which the text fits the page; scrolls only if even the smallest does not. */
function FittingText({ cardId, text }: { cardId: string; text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(16)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fits = (s: number) => {
      el.style.setProperty('--tp-size', `${s}px`)
      return el.scrollHeight <= el.clientHeight + 1
    }
    let lo = 10
    let hi = 16
    if (fits(hi)) {
      setSize(hi)
      return
    }
    while (hi - lo > 0.25) {
      const mid = Math.round(((lo + hi) / 2) * 2) / 2
      if (mid === lo || mid === hi) break
      if (fits(mid)) lo = mid
      else hi = mid
    }
    fits(lo)
    setSize(lo)
  }, [text])

  return (
    <div ref={ref} className="translated-page-text" data-thread-source={cardId} style={{ ['--tp-size' as string]: `${size}px` }}>
      <Markdown text={text} />
    </div>
  )
}

export const TranslatedPageView = memo(TranslatedPageViewImpl)
