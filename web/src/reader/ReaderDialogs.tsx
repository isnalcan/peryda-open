import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n/I18n'
import { getPref, setPref } from '../data/db'
import { pageTitle } from '../ai/compose'
import type { PDFDocumentProxy } from '../pdf/pdfjs'
import { AsterismIcon, CloseIcon, StopIcon } from '../ui/icons'
import { RANGE_LIMIT } from '../ilmek/cardsStore'
import type { PageReading, PageReadingsStore } from '../reading/pageReadings'
import { cleanPageText, rawPageText } from './pageText'

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
 * "Extract page text": the page's text in a clean, selectable view, with copy, text size and page by page.
 * When the text reads badly (or a scanned page has none), Pery can read the page's picture with the
 * reader's own key: this page, or a range of pages (more than two go to Gemini as a batch job at half the
 * price). What Pery read is kept with the book, so a batch that finishes later still lands (owner test
 * 14 Nov). Same as the Mac app's ExtractedTextSheet.
 */
export function ExtractTextDialog(props: { doc: PDFDocumentProxy; page: number; bookTitle: string; readings: PageReadingsStore | null; onOpenSettings: () => void; onClose: () => void }) {
  const { t, lang } = useI18n()
  const ref = useModal()
  const pages = props.doc.numPages
  const [page, setPage] = useState(props.page)
  const [own, setOwn] = useState<string | null>(null)
  const [size, setSize] = useState(18)
  const [copied, setCopied] = useState(false)
  const [asking, setAsking] = useState(false)
  const [from, setFrom] = useState(props.page)
  const [to, setTo] = useState(Math.min(pages, props.page + 9))
  const store = props.readings
  const noop = useCallback(() => () => {}, [])
  const snapshot = useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => EMPTY_READINGS))
  const reading = snapshot.find((r) => r.page === page)
  const pending = snapshot.filter((r) => r.state === 'waiting' || r.state === 'reading').length
  const inBatch = snapshot.filter((r) => r.state === 'waiting' && r.job).length
  const done = snapshot.filter((r) => r.state === 'done' && r.text)

  useEffect(() => {
    void getPref<number>('extractedTextSize', 18).then(setSize)
  }, [])

  useEffect(() => {
    let cancelled = false
    setOwn(null)
    setCopied(false)
    void (async () => {
      const p = await props.doc.getPage(page)
      const text = cleanPageText(await rawPageText(p))
      if (!cancelled) setOwn(text)
    })()
    return () => {
      cancelled = true
    }
  }, [props.doc, page])

  const resize = (next: number) => {
    const s = Math.min(28, Math.max(14, next))
    setSize(s)
    void setPref('extractedTextSize', s)
  }

  /** What is shown and copied: Pery's reading once done, else the page's own text. */
  const shown = reading?.state === 'done' ? reading.text : own
  const streaming = reading && (reading.state === 'waiting' || reading.state === 'reading')
  const allRead = done.map((r) => `${pageTitle(lang, r.page).toLocaleUpperCase(lang)}\n\n${r.text}`).join('\n\n\n')
  const copy = (text: string | null | undefined) => {
    if (!text) return
    void navigator.clipboard?.writeText(text).then(() => setCopied(true))
  }
  const saveAllRead = () => {
    const url = URL.createObjectURL(new Blob([allRead], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeFileName(props.bookTitle)}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const clampPage = (n: number) => Math.min(pages, Math.max(1, Number.isFinite(n) ? Math.round(n) : 1))
  const clampTo = (first: number, last: number) => Math.min(Math.max(last, first), first + RANGE_LIMIT - 1, pages)
  const count = Math.max(0, to - from + 1)
  const errorText = (code?: string) =>
    code === 'no-key' ? t.noKeyBody : code === 'key' ? t.errorKey : code === 'quota' ? t.errorQuota : code === 'blocked' ? t.errorBlocked : code === 'network' ? t.errorNetwork : code === 'expired' ? t.batchExpired : code === 'batch' ? t.batchFailed : t.errorUnknown
  const empty = !streaming && reading?.state !== 'done' && own !== null && own.trim().length < 40

  return (
    <dialog ref={ref} className="settings-dialog extract-dialog" onClose={props.onClose} onCancel={props.onClose}>
      <header className="dialog-header">
        <div className="extract-pager">
          <button type="button" className="icon-button" aria-label={t.previousPage} title={t.previousPage} disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
          <button type="button" className="icon-button" aria-label={t.nextPage} title={t.nextPage} disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button>
          <div>
            <h2>{t.extractedText}</h2>
            <p className="faint">
              {pageTitle(lang, page)}
              {shown ? ` · ${t.characters(shown.length)}` : ''}
              {reading?.state === 'done' ? ` · ${t.readByPery}` : ''}
            </p>
          </div>
        </div>
        <div className="extract-actions">
          <button type="button" className="icon-button" aria-label={t.zoomOut} title={t.zoomOut} onClick={() => resize(size - 2)}>A−</button>
          <button type="button" className="icon-button" aria-label={t.zoomIn} title={t.zoomIn} onClick={() => resize(size + 2)}>A+</button>
          <button type="button" className="ghost-button" title={t.readWithPeryHint} disabled={!store || reading?.state === 'reading'} onClick={() => store?.read(page, page, lang)}>
            <AsterismIcon size={14} /> {t.readWithPery}
          </button>
          <button
            type="button"
            className="ghost-button"
            aria-expanded={asking}
            disabled={!store}
            onClick={() => {
              setFrom(page)
              setTo(Math.min(pages, page + 9))
              setAsking(!asking)
            }}
          >
            {t.readRange}
          </button>
          <button type="button" className="ghost-button" disabled={!shown?.trim()} onClick={() => copy(shown)}>
            {copied ? t.copied : t.copyAll}
          </button>
          <button type="button" className="icon-button" aria-label={t.close} onClick={props.onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
      </header>
      {asking && store && (
        <section className="extract-range">
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
              <input type="number" min={from} max={Math.min(pages, from + RANGE_LIMIT - 1)} value={to} onChange={(e) => setTo(clampTo(from, clampPage(e.target.valueAsNumber)))} />
            </label>
          </div>
          <p className="range-count">{t.pagesToRead(count)}</p>
          {pages > RANGE_LIMIT && <p className="dialog-intro">{t.rangeLimit(RANGE_LIMIT)}</p>}
          <p className="dialog-intro">{t.readRangeNote}</p>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={() => setAsking(false)}>{t.cancel}</button>
            <button
              type="button"
              className="primary-button"
              disabled={count === 0}
              onClick={() => {
                store.read(from, to, lang)
                setAsking(false)
              }}
            >
              {t.read}
            </button>
          </div>
        </section>
      )}
      {pending > 0 && (
        <p className="extract-progress">
          <span className="spinner" aria-hidden="true" /> {t.readingPages(pending)}
          {inBatch > 0 && <span className="faint"> · {t.readingInBatch}</span>}
          <button type="button" className="text-button" onClick={() => store?.stop()}>
            <StopIcon size={13} /> {t.stop}
          </button>
        </p>
      )}
      {done.length > 1 && (
        <p className="extract-progress">
          <button type="button" className="text-button" onClick={() => copy(allRead)}>{t.copyAllRead}</button>
          <button type="button" className="text-button" onClick={saveAllRead}>{t.saveAllRead}</button>
        </p>
      )}
      {reading?.state === 'failed' && (
        <p className="field-error extract-failed">
          {t.readFailed} {errorText(reading.error)}{' '}
          {(reading.error === 'no-key' || reading.error === 'key') && <button type="button" className="text-button" onClick={props.onOpenSettings}>{t.openSettings}</button>}
        </p>
      )}
      <div className="extract-body">
        {streaming && !reading.text ? (
          <p className="faint extract-status">
            <span className="spinner" aria-hidden="true" /> {reading.job ? t.readingInBatch : t.readingText}
          </p>
        ) : streaming || reading?.state === 'done' ? (
          <ExtractedText text={reading!.text} size={size} />
        ) : own === null ? (
          <p className="faint extract-status">
            <span className="spinner" aria-hidden="true" /> {t.readingText}
          </p>
        ) : empty ? (
          <div className="extract-status">
            <p>{t.noTextFound}</p>
            <p className="faint">{t.readWithPeryNote}</p>
            <button type="button" className="primary-button" disabled={!store} onClick={() => store?.read(page, page, lang)}>
              <AsterismIcon size={14} /> {t.readWithPery}
            </button>
          </div>
        ) : (
          <ExtractedText text={own} size={size} />
        )}
      </div>
    </dialog>
  )
}

const EMPTY_READINGS: PageReading[] = []

/**
 * A book title as a file name: no path separators, characters Windows refuses or control characters, no
 * reserved device name, no leading or trailing dots and spaces, at most 120 characters (audit 15 Nov, WW-8).
 */
export function safeFileName(title: string): string {
  let name = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120)
  name = name.replace(/^[.\s]+|[.\s]+$/g, '')
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return 'Peryda'
  return name
}

function ExtractedText({ text, size }: { text: string; size: number }) {
  return (
    <article className="extract-text" style={{ fontSize: size, lineHeight: 1.6 }}>
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </article>
  )
}
