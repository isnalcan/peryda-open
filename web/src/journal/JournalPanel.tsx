import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getPref, newId, setPref, type JournalRecord } from '../data/db'
import { useI18n } from '../i18n/I18n'
import { highlightColorOf } from '../reader/highlightColors'
import { Markdown } from '../ui/Markdown'
import { journalSummarySystem, pageTitle } from '../ai/compose'
import { AiError, streamAnswer } from '../ai/client'
import { fakeStream, useFakeAi } from '../ai/fake'
import { ModelAdvice, effortFor, keyFor, modelFor, resolveActiveProvider, type ByokSettings } from '../ai/provider'
import { AsterismIcon, ChevronDownIcon, ChevronUpIcon, CloseIcon, PlusIcon, StopIcon, TrashIcon } from '../ui/icons'
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
  const collapsedKey = `summaryCollapsed:${bookId}`
  // Pery's summary can be folded to its title row, and deleted (owner test 16 Nov: it took too much room
  // and could not be taken away). The fold is kept per book.
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    void getPref<Summary | null>(prefKey, null).then(setSummary)
    void getPref<boolean>(collapsedKey, false).then((v) => setCollapsed(v === true))
    return () => controller.current?.abort()
  }, [prefKey, collapsedKey])

  const fold = (next: boolean) => {
    setCollapsed(next)
    void setPref(collapsedKey, next)
  }
  const deleteSummary = () => {
    if (!window.confirm(t.deleteSummaryConfirm)) return
    controller.current?.abort()
    controller.current = null
    setStreaming(false)
    setSummary(null)
    void db.prefs.delete(prefKey)
  }

  const date = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const sourceLabel = (s: JournalRecord['source']) =>
    s === 'clip' ? t.sourceClip : s === 'thread' ? t.sourceThread : s === 'highlight' ? t.sourceHighlight : t.sourceNote
  // Saved threads show their passage; Pery's answer opens on a click (owner test 15 Nov: passage and
  // answer together took too much room).
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
    if (collapsed) fold(false)
    let text = ''
    try {
      const stream = fake
        ? fakeStream(ac.signal)
        : streamAnswer({
            provider: provider!,
            apiKey: keyFor(settings, provider!),
            model: modelFor(settings, provider!, 'summary'),
            // One pass with fill(): `$&` and the like in a title stay as written.
            system: journalSummarySystem(lang, bookTitle),
            turns: [{ role: 'user', parts: [{ type: 'text', text: body }] }],
            maxOutputTokens: ModelAdvice.maxOutputTokens(provider!, 'summary'),
            temperature: ModelAdvice.temperature('summary'),
            effort: effortFor(settings, provider!, 'summary'),
            candidates: provider === 'gemini' ? ModelAdvice.geminiChain(modelFor(settings, 'gemini', 'summary'), effortFor(settings, 'gemini', 'summary') ?? 'high') : undefined,
            signal: ac.signal,
          })
      for await (const piece of stream) {
        // Deleted while it was being written: nothing more of it is shown or kept.
        if (ac.signal.aborted) break
        text += piece
        setSummary({ text, createdAt: Date.now() })
      }
      if (ac.signal.aborted) return
      const done = { text, createdAt: Date.now() }
      setSummary(done)
      await setPref(prefKey, done)
    } catch (e) {
      const kind = e instanceof AiError ? e.kind : 'unknown'
      if (kind !== 'aborted') setError(kind === 'key' ? t.errorKey : kind === 'quota' ? t.errorQuota : kind === 'browser' ? t.errorBrowser : t.errorNetwork)
    } finally {
      if (controller.current === ac) setStreaming(false)
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
        <section className={`journal-summary${collapsed ? ' is-collapsed' : ''}`} aria-live={streaming ? 'polite' : undefined}>
          <h3>
            <AsterismIcon size={14} /> {t.summaryTitle}
            <span>{date.format(summary.createdAt)}</span>
            <button
              type="button"
              className="icon-button journal-summary-button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? t.show : t.hide}
              title={collapsed ? t.show : t.hide}
              onClick={() => fold(!collapsed)}
            >
              {collapsed ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
            </button>
            <button type="button" className="icon-button journal-summary-button" aria-label={t.deleteSummary} title={t.deleteSummary} onClick={deleteSummary}>
              <TrashIcon size={14} />
            </button>
          </h3>
          {!collapsed && <Markdown text={summary.text} />}
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
                  onClick={() => {
                    // Deleting cannot be undone (and takes a highlight off its page), so it asks first, as on the Mac.
                    if (window.confirm(t.deleteEntryConfirm)) void db.journal.delete(e.id)
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
              {e.source === 'note' ? (
                e.text && (
                  <div className="journal-text">
                    <Markdown text={e.text} />
                  </div>
                )
              ) : e.source === 'thread' && e.text ? (
                <>
                  {e.quote && (
                    <button type="button" className="journal-quote is-toggle" aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
                      {e.quote}
                    </button>
                  )}
                  <button type="button" className="journal-answer-toggle" aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
                    {open.has(e.id) ? <ChevronUpIcon size={13} /> : <ChevronDownIcon size={13} />}
                    {open.has(e.id) ? t.hideAnswer : t.showAnswer}
                  </button>
                  {open.has(e.id) && (
                    <div className="journal-text">
                      <Markdown text={e.text} />
                    </div>
                  )}
                </>
              ) : (
                e.quote && (
                  <blockquote className={`journal-quote${e.source === 'highlight' ? ' is-highlight' : ''}`} data-hl={e.source === 'highlight' ? highlightColorOf(e) : undefined}>
                    {e.source === 'highlight' ? <mark>{e.quote}</mark> : e.quote}
                  </blockquote>
                )
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
