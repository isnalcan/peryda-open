import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18n'
import { LANGUAGE_NAMES } from '../ai/compose'
import type { Lang, Strings } from '../i18n/strings'
import type { YarnCard } from '../ilmek/types'
import { Markdown } from '../ui/Markdown'
import { CloseIcon, RetryIcon, TextLargerIcon, TextSmallerIcon, TranslateIcon } from '../ui/icons'
import { CARD_TEXT_SCALES } from '../ilmek/useThreadActions'

interface Props {
  card: YarnCard
  x: number
  y: number
  onHeight: (id: string, height: number) => void
  onRetranslate: (id: string) => void
  onTranslateNow: (id: string) => void
  /** The page waits on a Gemini batch job: "Translate now" is offered at once (owner, 15 Nov). */
  inBatch?: boolean
  onRemove: (id: string) => void
  onOpenSettings: () => void
  /** This book's translated-text size (×1 = the size the page fits to), and a step smaller or larger. */
  textScale?: number
  onTextScale?: (delta: number) => void
  /** Offered when threads sit between the PDF page and its translation: hides/shows threads to read side by side. */
  onSideBySide?: () => void
  sideBySideActive?: boolean
}

function errorText(t: Strings, code: string): string {
  switch (code) {
    case 'no-key':
      return t.noKeyBody
    case 'expired':
      return t.batchExpired
    case 'key-changed':
      return t.batchKeyChanged
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
function TranslatedPageViewImpl({
  card,
  x,
  y,
  onHeight,
  onRetranslate,
  onTranslateNow,
  inBatch = false,
  onRemove,
  onOpenSettings,
  textScale = 1,
  onTextScale,
  onSideBySide,
  sideBySideActive = false,
}: Props) {
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
          {onSideBySide && (
            <button
              type="button"
              className="translated-side-button"
              aria-pressed={sideBySideActive}
              title={t.focusLane}
              onClick={onSideBySide}
            >
              {t.focusLane}
            </button>
          )}
          {/* Text size for every translated page of this book, left of Retranslate (owner test 15 Nov). */}
          {onTextScale && (
            <>
              <button type="button" className="icon-button" title={t.textSmaller} aria-label={t.textSmaller} disabled={textScale <= CARD_TEXT_SCALES[0]!} onClick={() => onTextScale(-1)}>
                <TextSmallerIcon size={14} />
              </button>
              <button type="button" className="icon-button" title={t.textLarger} aria-label={t.textLarger} disabled={textScale >= CARD_TEXT_SCALES[CARD_TEXT_SCALES.length - 1]!} onClick={() => onTextScale(1)}>
                <TextLargerIcon size={14} />
              </button>
            </>
          )}
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
          <Waiting card={card} t={t} inBatch={inBatch || !!card.batchJob} onTranslateNow={onTranslateNow} />
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
          <FittingText cardId={card.id} text={answer.content} scale={textScale} />
        )}
      </div>
    </article>
  )
}

/**
 * Waiting for the batch job or the direct answer. A page in a batch can be translated now at once, at the
 * normal price, while the others stay in the queue (owner, 15 Nov: batches can take long; the button used to
 * appear only after a minute).
 */
function Waiting({ card, t, inBatch, onTranslateNow }: { card: YarnCard; t: Strings; inBatch: boolean; onTranslateNow: (id: string) => void }) {
  return (
    <div className="translated-page-waiting" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{inBatch ? t.batchWaiting : t.translating}</span>
      {inBatch && (
        <>
          <button type="button" className="text-button" onClick={() => onTranslateNow(card.id)}>{t.translateNow}</button>
          <span className="translated-page-note">{t.batchNowNote}</span>
        </>
      )}
    </div>
  )
}

/**
 * Picks the largest reading size (10–16 px) at which the text fits the page; scrolls only if even the
 * smallest does not. The reader's size (`scale`) multiplies that size; larger than fits, the text scrolls
 * inside the page.
 */
function FittingText({ cardId, text, scale }: { cardId: string; text: string; scale: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fitted, setSize] = useState(16)
  const size = Math.round(fitted * scale * 2) / 2

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fits = (s: number) => {
      el.style.setProperty('--tp-size', `${s}px`)
      return el.scrollHeight <= el.clientHeight + 1
    }
    // Measured at the fitting sizes, then shown at the reader's size (measuring writes the size directly).
    const show = (s: number) => {
      el.style.setProperty('--tp-size', `${Math.round(s * scale * 2) / 2}px`)
      setSize(s)
    }
    let lo = 10
    let hi = 16
    if (fits(hi)) {
      show(hi)
      return
    }
    while (hi - lo > 0.25) {
      const mid = Math.round(((lo + hi) / 2) * 2) / 2
      if (mid === lo || mid === hi) break
      if (fits(mid)) lo = mid
      else hi = mid
    }
    show(lo)
  }, [text, scale])

  return (
    <div ref={ref} className="translated-page-text" data-thread-source={cardId} style={{ ['--tp-size' as string]: `${size}px` }}>
      <Markdown text={text} />
    </div>
  )
}

export const TranslatedPageView = memo(TranslatedPageViewImpl)
