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

/**
 * The first and last page of a range, typed freely: a number is held as typed and checked against the
 * book (and the per-request limit) only when the reader leaves the field or presses Enter (owner test
 * 15 Nov: typing 150 over 6 snapped back to 6 at the first "1"). `first`/`last` already include what is
 * being typed, so the count and the button always use the range that would be committed.
 */
function usePageRange(pages: number, page: number) {
  const [from, setFrom] = useState(page)
  const [to, setTo] = useState(Math.min(pages, page + 9))
  const [draftFrom, setDraftFrom] = useState<string | null>(null)
  const [draftTo, setDraftTo] = useState<string | null>(null)
  const clampPage = (n: number) => Math.min(pages, Math.max(1, Number.isFinite(n) ? Math.round(n) : 1))
  const read = (draft: string | null, kept: number) => {
    const n = draft === null || draft.trim() === '' ? NaN : Number(draft)
    return Number.isFinite(n) ? n : kept
  }
  const first = clampPage(read(draftFrom, from))
  const last = Math.min(Math.max(clampPage(read(draftTo, to)), first), first + RANGE_LIMIT - 1, pages)
  const commit = () => {
    setFrom(first)
    setTo(last)
    setDraftFrom(null)
    setDraftTo(null)
  }
  const reset = (start: number) => {
    setFrom(start)
    setTo(Math.min(pages, start + 9))
    setDraftFrom(null)
    setDraftTo(null)
  }
  const field = (label: string, draft: string | null, kept: number, setDraft: (v: string) => void, min: number, max: number) => (
    <label>
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft ?? String(kept)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </label>
  )
  return { first, last, count: Math.max(0, last - first + 1), commit, reset, field, from, to, draftFrom, draftTo, setDraftFrom, setDraftTo }
}

function RangeFields({ range, pages, labels }: { range: ReturnType<typeof usePageRange>; pages: number; labels: [string, string] }) {
  return (
    <div className="range-fields">
      {range.field(labels[0], range.draftFrom, range.from, range.setDraftFrom, 1, pages)}
      {range.field(labels[1], range.draftTo, range.to, range.setDraftTo, range.first, Math.min(pages, range.first + RANGE_LIMIT - 1))}
    </div>
  )
}

/** Which pages to translate (at most RANGE_LIMIT at once); more than two go to Gemini as one batch job. */
export function TranslateRangeDialog({ page, pages, onTranslate, onClose }: { page: number; pages: number; onTranslate: (from: number, to: number) => void; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useModal()
  const range = usePageRange(pages, page)
  const count = range.count
  return (
    <dialog ref={ref} className="settings-dialog small-dialog" onClose={onClose} onCancel={onClose}>
      <header className="dialog-header">
        <h2>{t.translateRange.replace(/…$/, '')}</h2>
        <button type="button" className="icon-button" aria-label={t.close} onClick={onClose}>
          <CloseIcon size={18} />
        </button>
      </header>
      <section>
        <RangeFields range={range} pages={pages} labels={[t.fromPage, t.toPage]} />
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
              onTranslate(range.first, range.last)
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
  const range = usePageRange(pages, props.page)
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
  const count = range.count
  const errorText = (code?: string) =>
    code === 'no-key' ? t.noKeyBody : code === 'key' ? t.errorKey : code === 'quota' ? t.errorQuota : code === 'blocked' ? t.errorBlocked : code === 'network' ? t.errorNetwork : code === 'expired' ? t.batchExpired : code === 'key-changed' ? t.batchKeyChanged : code === 'batch' ? t.batchFailed : t.errorUnknown
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
              range.reset(page)
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
          <RangeFields range={range} pages={pages} labels={[t.fromPage, t.toPage]} />
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
                store.read(range.first, range.last, lang)
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
 * A book title as a file name: no path separators, characters Windows refuses, control characters or
 * invisible direction and joining marks (which can make "txt.exe" read as "exe.txt"), no reserved device
 * name even with an extension ("CON.tar" is reserved too), no leading or trailing dots and spaces, at most
 * 120 characters, never cutting a character in half (audit 15 Nov, WW-8).
 */
export function safeFileName(title: string): string {
  let name = title
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  name = Array.from(name).slice(0, 120).join('')
  name = name.replace(/^[.\s]+|[.\s]+$/g, '')
  if (!name) return 'Peryda'
  const base = name.split('.')[0]!.trim()
  if (/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i.test(base)) return `Peryda ${name}`
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
