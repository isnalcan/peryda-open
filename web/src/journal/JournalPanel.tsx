import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getPref, newId, setPref, type JournalRecord } from '../data/db'
import { useI18n } from '../i18n/I18n'
import { Markdown } from '../ui/Markdown'
import { journalSummarySystem, pageTitle } from '../ai/compose'
import { AiError, streamAnswer } from '../ai/client'
import { fakeStream, useFakeAi } from '../ai/fake'
import { ModelAdvice, keyFor, modelFor, resolveActiveProvider, type ByokSettings } from '../ai/provider'
import { AsterismIcon, CloseIcon, PlusIcon, StopIcon, TrashIcon } from '../ui/icons'
import './journal.css'

interface Props {
  bookId: string
  bookTitle: string
  settings: ByokSettings
  onOpenSettings: () => void
  onClose: () => void
  /** Page (PDF) or chapter (EPUB) a new note belongs to. */
  notePage?: number
  /** When given, an entry's page label becomes a button that goes there. */
  onGoToPage?: (page: number) => void
}

interface Summary {
  text: string
  createdAt: number
}

/** The Book Journal for the open book: clipped passages, saved threads, notes, and Pery's summary. */
export function JournalPanel({ bookId, bookTitle, settings, onOpenSettings, onClose, notePage, onGoToPage }: Props) {
  const { t, lang } = useI18n()
  const entries = useLiveQuery(
    () => db.journal.where('bookId').equals(bookId).reverse().sortBy('createdAt'),
    [bookId],
    [] as JournalRecord[],
  )
  const [summary, setSummary] = useState<Summary | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const fake = useFakeAi()
  const prefKey = `journalSummary:${bookId}`

  useEffect(() => {
    void getPref<Summary | null>(prefKey, null).then(setSummary)
    return () => controller.current?.abort()
  }, [prefKey])

  const date = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const sourceLabel = (s: JournalRecord['source']) => (s === 'clip' ? t.sourceClip : s === 'thread' ? t.sourceThread : t.sourceNote)

  const summarize = async () => {
    setError(null)
    if (!entries.length) {
      setError(t.summaryEmpty)
      return
    }
    const provider = resolveActiveProvider(settings)
    if (!provider && !fake) {
      setError(t.noKeyBody)
      return
    }
    const body = entries
      .slice()
      .reverse()
      .map((e) => [e.quote && `> ${e.quote}`, e.text].filter(Boolean).join('\n'))
      .join('\n\n---\n\n')
    controller.current?.abort()
    const ac = new AbortController()
    controller.current = ac
    setStreaming(true)
    let text = ''
    try {
      const stream = fake
        ? fakeStream(ac.signal)
        : streamAnswer({
            provider: provider!,
            apiKey: keyFor(settings, provider!),
            model: modelFor(settings, provider!, 'thread'),
            // One pass with fill(): `$&` and the like in a title stay as written.
            system: journalSummarySystem(lang, bookTitle),
            turns: [{ role: 'user', parts: [{ type: 'text', text: body }] }],
            maxOutputTokens: ModelAdvice.maxOutputTokens(provider!, 'thread'),
            temperature: ModelAdvice.temperature('thread'),
            candidates: provider === 'gemini' ? ModelAdvice.geminiChain(modelFor(settings, 'gemini', 'thread')) : undefined,
            signal: ac.signal,
          })
      for await (const piece of stream) {
        text += piece
        setSummary({ text, createdAt: Date.now() })
      }
      const done = { text, createdAt: Date.now() }
      setSummary(done)
      await setPref(prefKey, done)
    } catch (e) {
      const kind = e instanceof AiError ? e.kind : 'unknown'
      if (kind !== 'aborted') setError(kind === 'key' ? t.errorKey : kind === 'quota' ? t.errorQuota : kind === 'browser' ? t.errorBrowser : t.errorNetwork)
    } finally {
      setStreaming(false)
    }
  }

  return (
    <aside className="journal-panel" aria-label={t.journal}>
      <header className="journal-header">
        <h2>{t.journal}</h2>
        <div className="journal-actions">
          {streaming ? (
            <button type="button" className="text-button" onClick={() => controller.current?.abort()}>
              <StopIcon size={14} /> {t.stop}
            </button>
          ) : (
            <button type="button" className="text-button" onClick={() => void summarize()}>
              <AsterismIcon size={14} /> {t.summarize}
            </button>
          )}
          <button type="button" className="icon-button" aria-label={t.close} onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
      </header>
      <NoteField bookId={bookId} page={notePage} />
      {error && (
        <p className="journal-error" role="status">
          {error}{' '}
          {error === t.noKeyBody && (
            <button type="button" className="text-button" onClick={onOpenSettings}>{t.openSettings}</button>
          )}
        </p>
      )}
      {summary?.text && (
        <section className="journal-summary" aria-live={streaming ? 'polite' : undefined}>
          <h3>
            <AsterismIcon size={14} /> {t.summaryTitle}
            <span>{date.format(summary.createdAt)}</span>
          </h3>
          <Markdown text={summary.text} />
        </section>
      )}
      {entries.length === 0 ? (
        <p className="journal-empty">{t.journalEmpty}</p>
      ) : (
        <ol className="journal-list">
          {entries.map((e) => (
            <li key={e.id} className="journal-entry">
              <div className="journal-meta">
                <span>{sourceLabel(e.source)}</span>
                {e.pageNumber > 0 &&
                  (onGoToPage ? (
                    <span>
                      ·{' '}
                      <button type="button" className="journal-page-link" title={t.goToPage} onClick={() => onGoToPage(e.pageNumber)}>
                        {pageTitle(lang, e.pageNumber)}
                      </button>
                    </span>
                  ) : (
                    <span>· {pageTitle(lang, e.pageNumber)}</span>
                  ))}
                <span>· {date.format(e.createdAt)}</span>
                <button
                  type="button"
                  className="icon-button journal-delete"
                  aria-label={t.deleteEntry}
                  title={t.deleteEntry}
                  onClick={() => void db.journal.delete(e.id)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
              {e.quote && <blockquote className="journal-quote">{e.quote}</blockquote>}
              {e.text && (
                <div className="journal-text">
                  <Markdown text={e.text} />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

/** The reader's own note, saved to the journal at the page (or chapter) being read. */
function NoteField({ bookId, page }: { bookId: string; page?: number }) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el || (typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content'))) return
    // Without field-sizing the field grows by hand, up to the same height as the CSS limit.
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])

  const save = async () => {
    const body = text.trim()
    if (!body) return
    setText('')
    const pageNumber = page !== undefined && Number.isFinite(page) && page > 0 ? Math.floor(page) : 0
    try {
      await db.journal.add({ id: newId(), bookId, source: 'note', quote: '', text: body, pageNumber, createdAt: Date.now() })
    } catch {
      // Keep the words when the note could not be saved.
      setText((current) => current || body)
    }
  }

  return (
    <form
      className="journal-note"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <textarea
        ref={fieldRef}
        rows={1}
        value={text}
        placeholder={t.addNote}
        aria-label={t.addNote}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // keyCode 229: Safari's Enter that ends an IME composition must not save the note.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            void save()
          }
        }}
      />
      <button type="submit" className="send-button" aria-label={t.save} title={t.save} disabled={!text.trim()}>
        <PlusIcon size={16} />
      </button>
    </form>
  )
}
