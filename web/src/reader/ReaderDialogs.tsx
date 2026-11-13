import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18n'
import { getPref, setPref } from '../data/db'
import { AiError, streamAnswer } from '../ai/client'
import { fakeStream, useFakeAi } from '../ai/fake'
import { pageTitle, pageTranscriptionSystem, pageTranscriptionTurns } from '../ai/compose'
import { ModelAdvice, keyFor, modelFor, resolveActiveProvider, type ByokSettings } from '../ai/provider'
import type { PDFDocumentProxy } from '../pdf/pdfjs'
import { AsterismIcon, CloseIcon, StopIcon } from '../ui/icons'
import { RANGE_LIMIT } from '../ilmek/cardsStore'
import { cleanPageText, rawPageText, renderPageJpeg } from './pageText'

function useModal() {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return ref
}

/** Which pages to translate (at most RANGE_LIMIT at once); more than two go to Gemini as one batch job. */
export function TranslateRangeDialog({ page, pages, onTranslate, onClose }: { page: number; pages: number; onTranslate: (from: number, to: number) => void; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useModal()
  const [from, setFrom] = useState(page)
  const [to, setTo] = useState(Math.min(pages, page + 9))
  const clampPage = (n: number) => Math.min(pages, Math.max(1, Number.isFinite(n) ? Math.round(n) : 1))
  /** The last page keeps within the first page and the per-request limit. */
  const clampTo = (first: number, last: number) => Math.min(Math.max(last, first), first + RANGE_LIMIT - 1)
  const count = Math.max(0, to - from + 1)
  return (
    <dialog ref={ref} className="settings-dialog small-dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-header">
        <h2>{t.translateRange.replace(/…$/, '')}</h2>
        <button type="button" className="icon-button" aria-label={t.close} onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </header>
      <section>
        <div className="range-fields">
          <label>
            {t.fromPage}
            <input
              type="number"
              min={1}
              max={pages}
              value={from}
              onChange={(e) => {
                const v = clampPage(e.target.valueAsNumber)
                setFrom(v)
                setTo(clampTo(v, to))
              }}
            />
          </label>
          <label>
            {t.toPage}
            <input
              type="number"
              min={from}
              max={Math.min(pages, from + RANGE_LIMIT - 1)}
              value={to}
              onChange={(e) => setTo(clampTo(from, clampPage(e.target.valueAsNumber)))}
            />
          </label>
        </div>
        <p className="range-count">{t.pagesToTranslate(count)}</p>
        {pages > RANGE_LIMIT && <p className={`dialog-intro${count >= RANGE_LIMIT ? ' is-at-limit' : ''}`}>{t.rangeLimit(RANGE_LIMIT)}</p>}
        <p className="dialog-intro">{t.rangeBatchNote}</p>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>{t.cancel}</button>
          <button
            type="button"
            className="primary-button"
            disabled={count === 0}
            onClick={() => {
              onTranslate(from, Math.min(to, from + RANGE_LIMIT - 1))
              onClose()
            }}
          >
            {t.translate}
          </button>
        </div>
      </section>
    </dialog>
  )
}

/**
 * "Extract page text": the page's text in a clean, selectable view, with copy and text size. A scanned
 * page has no text layer; Pery can read its picture with the reader's own key.
 */
export function ExtractTextDialog(props: { doc: PDFDocumentProxy; page: number; bookTitle: string; settings: ByokSettings; onOpenSettings: () => void; onClose: () => void }) {
  const { t, lang } = useI18n()
  const ref = useModal()
  const fake = useFakeAi()
  const [text, setText] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState(18)
  const [copied, setCopied] = useState(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    void getPref<number>('extractedTextSize', 18).then(setSize)
    let cancelled = false
    void (async () => {
      const page = await props.doc.getPage(props.page)
      const own = cleanPageText(await rawPageText(page))
      if (!cancelled) setText(own)
    })()
    return () => {
      cancelled = true
      controller.current?.abort()
    }
  }, [props.doc, props.page])

  const resize = (next: number) => {
    const s = Math.min(28, Math.max(14, next))
    setSize(s)
    void setPref('extractedTextSize', s)
  }

  const readWithPery = async () => {
    setError(null)
    const provider = resolveActiveProvider(props.settings)
    if (!provider && !fake) {
      setError(t.noKeyBody)
      return
    }
    controller.current?.abort()
    const ac = new AbortController()
    controller.current = ac
    setReading(true)
    let out = ''
    try {
      const page = await props.doc.getPage(props.page)
      const image = await renderPageJpeg(page, 2, 0.88)
      const p = provider ?? 'gemini'
      const model = modelFor(props.settings, p, 'translation')
      const stream = fake
        ? fakeStream(ac.signal, true)
        : streamAnswer({
            provider: p,
            apiKey: keyFor(props.settings, p),
            model: p === 'deepseek' ? 'deepseek-flash' : model,
            system: pageTranscriptionSystem(lang),
            turns: pageTranscriptionTurns(lang, props.bookTitle, props.page, props.doc.numPages, image),
            maxOutputTokens: ModelAdvice.maxOutputTokens(p, 'translation'),
            candidates: p === 'gemini' ? ModelAdvice.geminiChain(model) : undefined,
            signal: ac.signal,
          })
      for await (const piece of stream) {
        out += piece
        setText(out)
      }
    } catch (e) {
      const kind = e instanceof AiError ? e.kind : 'unknown'
      if (kind !== 'aborted') setError(kind === 'key' ? t.errorKey : kind === 'quota' ? t.errorQuota : kind === 'browser' ? t.errorBrowser : t.errorNetwork)
    } finally {
      setReading(false)
    }
  }

  const empty = text !== null && text.trim().length < 40 && !reading
  return (
    <dialog ref={ref} className="settings-dialog extract-dialog" onClose={props.onClose} onCancel={props.onClose}>
      <header className="dialog-header">
        <div>
          <h2>{t.extractedText}</h2>
          <p className="faint">
            {pageTitle(lang, props.page)}
            {text ? ` · ${t.characters(text.length)}` : ''}
          </p>
        </div>
        <div className="extract-actions">
          <button type="button" className="icon-button" aria-label={t.zoomOut} title={t.zoomOut} onClick={() => resize(size - 2)}>A−</button>
          <button type="button" className="icon-button" aria-label={t.zoomIn} title={t.zoomIn} onClick={() => resize(size + 2)}>A+</button>
          <button
            type="button"
            className="ghost-button"
            disabled={!text?.trim()}
            onClick={() => {
              if (!text) return
              void navigator.clipboard?.writeText(text).then(() => setCopied(true))
            }}
          >
            {copied ? t.copied : t.copyAll}
          </button>
          <button type="button" className="icon-button" aria-label={t.close} onClick={props.onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
      </header>
      <div className="extract-body">
        {text === null ? (
          <p className="faint extract-status">
            <span className="spinner" aria-hidden="true" /> {t.readingText}
          </p>
        ) : empty ? (
          <div className="extract-status">
            <p>{t.noTextFound}</p>
            <p className="faint">{t.readWithPeryNote}</p>
            <button type="button" className="primary-button" onClick={() => void readWithPery()}>
              <AsterismIcon size={14} /> {t.readWithPery}
            </button>
            {error && (
              <p className="field-error">
                {error}{' '}
                {error === t.noKeyBody && <button type="button" className="text-button" onClick={props.onOpenSettings}>{t.openSettings}</button>}
              </p>
            )}
          </div>
        ) : (
          <>
            {reading && (
              <p className="faint extract-status">
                <span className="spinner" aria-hidden="true" /> {t.readingText}
                <button type="button" className="text-button" onClick={() => controller.current?.abort()}>
                  <StopIcon size={13} /> {t.stop}
                </button>
              </p>
            )}
            <article className="extract-text" style={{ fontSize: size, lineHeight: 1.6 }}>
              {text.split(/\n{2,}/).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </article>
          </>
        )}
      </div>
    </dialog>
  )
}
