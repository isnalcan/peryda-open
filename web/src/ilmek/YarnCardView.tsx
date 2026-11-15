import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useI18n } from '../i18n/I18n'
import { kindTitle } from '../ai/compose'
import { Markdown } from '../ui/Markdown'
import { AsterismIcon, ChevronDownIcon, ChevronUpIcon, ClipIcon, ClipSavedIcon, CloseIcon, MagnetIcon, MinimizeIcon, RetryIcon, SendIcon, StopIcon, TextLargerIcon, TextSmallerIcon } from '../ui/icons'
import type { Strings } from '../i18n/strings'
import { CARD_HEIGHT_RANGE, CARD_WIDTH_RANGE } from './cardsStore'
import { GEOMETRY } from './geometry'
import type { YarnCard } from './types'
import { CARD_TEXT_SCALES, isPictureArea, type JournalState } from './useThreadActions'

interface Props {
  /** 'world' cards float on the reading surface; 'column' cards sit in a list beside an EPUB. */
  layout?: 'world' | 'column'
  card: YarnCard
  x: number
  y: number
  /** The camera's current zoom (read during a drag or resize, so zooming never re-renders cards). */
  scale: () => number
  /** The quote is shortened to its first lines. */
  shortQuote: boolean
  onToggleQuote: (id: string) => void
  onHeight: (id: string, height: number) => void
  onAsk: (id: string, text: string) => void
  onRetry: (id: string) => void
  onStop: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  /** The card's live position while its header is dragged, then null; the yarns follow it. */
  onDragLive?: (id: string, at: { x: number; y: number } | null) => void
  /** Corner resizing (world cards); no height lets the card follow its content again. */
  onResize?: (id: string, width: number, height?: number) => void
  onUnpin: (id: string) => void
  onCollapse: (id: string) => void
  onOpenSettings: () => void
  onFocusCard: (id: string) => void
  onSaveToJournal: (id: string) => void
  /** Whether the card is in the journal (lit when it is, plain again when the conversation went on). */
  journal?: JournalState
  /** This book's card text size, and its − and + (every card of the book follows it). */
  textScale?: number
  onTextSize?: (delta: number) => void
  /** When given, the quote is a link back to the passage. */
  onQuoteClick?: (id: string) => void
}

/** About three lines of a card's quote; longer passages get the shorten toggle. */
export const LONG_QUOTE = 160

function errorText(t: Strings, code: string): string {
  switch (code) {
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

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))

/** Keeps the pointer while dragging, even outside the card (a stale pointer cannot be captured). */
function capture(e: PointerEvent<HTMLElement>) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    /* already released */
  }
}

function YarnCardViewImpl(props: Props) {
  const { card } = props
  const { t, lang } = useI18n()
  const ref = useRef<HTMLElement>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [drag, setDragState] = useState<{ x: number; y: number } | null>(null)
  // Kept in refs too: a quick release can arrive before React has drawn the last move.
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const setDrag = (v: { x: number; y: number } | null) => {
    dragRef.current = v
    setDragState(v)
  }
  const dragStart = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null)
  const [size, setSizeState] = useState<{ w: number; h: number } | null>(null)
  const sizeRef = useRef<{ w: number; h: number } | null>(null)
  const setSize = (v: { w: number; h: number } | null) => {
    sizeRef.current = v
    setSizeState(v)
  }
  const sizeStart = useRef<{ px: number; py: number; w: number; h: number } | null>(null)
  const isNote = card.kind === 'cream'
  const streaming = card.messages.some((m) => m.state === 'streaming')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => props.onHeight(card.id, el.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id])

  const column = props.layout === 'column'
  const onHeaderDown = (e: PointerEvent<HTMLElement>) => {
    if (column || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    capture(e)
    dragStart.current = { px: e.clientX, py: e.clientY, x: props.x, y: props.y, moved: false }
  }
  const onHeaderMove = (e: PointerEvent<HTMLElement>) => {
    const s = dragStart.current
    if (!s) return
    const scale = props.scale()
    const dx = (e.clientX - s.px) / scale
    const dy = (e.clientY - s.py) / scale
    if (!s.moved && Math.hypot(dx, dy) * scale < 4) return
    s.moved = true
    setDrag({ x: s.x + dx, y: s.y + dy })
    props.onDragLive?.(card.id, { x: s.x + dx, y: s.y + dy })
  }
  const onHeaderUp = () => {
    const s = dragStart.current
    dragStart.current = null
    const end = dragRef.current
    if (s?.moved && end) props.onMove(card.id, end.x, end.y)
    setDrag(null)
    if (s?.moved) props.onDragLive?.(card.id, null)
  }

  // Corner resizing: width 300–640, height 150–1000 world units; a double click returns to the card's own size.
  const onGripDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !ref.current) return
    e.preventDefault()
    e.stopPropagation()
    capture(e)
    sizeStart.current = { px: e.clientX, py: e.clientY, w: card.width, h: ref.current.offsetHeight }
  }
  const onGripMove = (e: PointerEvent<HTMLElement>) => {
    const s = sizeStart.current
    if (!s) return
    const scale = props.scale()
    setSize({
      w: clamp(s.w + (e.clientX - s.px) / scale, CARD_WIDTH_RANGE),
      h: clamp(s.h + (e.clientY - s.py) / scale, CARD_HEIGHT_RANGE),
    })
  }
  const onGripUp = () => {
    sizeStart.current = null
    const end = sizeRef.current
    if (end) props.onResize?.(card.id, end.w, end.h)
    setSize(null)
  }

  const submit = () => {
    const body = draft.trim()
    if (!body || streaming) return
    props.onAsk(card.id, body)
    setDraft('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const image = card.anchors.find((a) => a.croppedImage)?.croppedImage
  // A page area shows its picture only: the text read from a scan is often garbled, and the picture
  // already says what was chosen (owner test 15 Nov).
  const quote = card.anchors
    .filter((a) => !isPictureArea(a))
    .map((a) => a.selectedText.trim())
    .filter(Boolean)
    .join(' · ')
  const longQuote = quote.length > LONG_QUOTE
  const x = drag?.x ?? props.x
  const y = drag?.y ?? props.y
  const width = size?.w ?? card.width
  const height = size?.h ?? card.height
  const fixedHeight = !column && height !== undefined

  return (
    <article
      ref={ref}
      className={`yarn-card${column ? ' is-column' : ''}${card.isPinned ? ' is-pinned' : ''}${drag || size ? ' is-dragging' : ''}${fixedHeight ? ' has-height' : ''}`}
      data-yarn={card.color}
      data-card-id={card.id}
      style={column ? undefined : { transform: `translate(${x}px, ${y}px)`, width, height: fixedHeight ? height : undefined }}
      onPointerDown={() => props.onFocusCard(card.id)}
    >
      <header
        className="yarn-card-header"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
      >
        <span className="yarn-dot" aria-hidden="true" />
        <span className="yarn-card-title">{kindTitle(lang, card)}</span>
        <span className="yarn-card-actions">
          {props.onTextSize && (
            <>
              <button
                type="button"
                className="icon-button"
                title={t.textSmaller}
                aria-label={t.textSmaller}
                disabled={(props.textScale ?? 1) <= CARD_TEXT_SCALES[0]!}
                onClick={() => props.onTextSize!(-1)}
              >
                <TextSmallerIcon size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                title={t.textLarger}
                aria-label={t.textLarger}
                disabled={(props.textScale ?? 1) >= CARD_TEXT_SCALES[CARD_TEXT_SCALES.length - 1]!}
                onClick={() => props.onTextSize!(1)}
              >
                <TextLargerIcon size={15} />
              </button>
            </>
          )}
          {card.isPinned && (
            <button type="button" className="icon-button" title={t.backToLane} aria-label={t.backToLane} onClick={() => props.onUnpin(card.id)}>
              <MagnetIcon size={15} />
            </button>
          )}
          {/* Saved once, then lit; plain again (and a click updates the one entry) when the conversation went on. */}
          <button
            type="button"
            className={`icon-button journal-button${props.journal === 'saved' ? ' is-saved' : ''}`}
            title={props.journal === 'saved' ? t.inJournal : props.journal === 'outdated' ? t.updateInJournal : t.saveToJournal}
            aria-label={props.journal === 'saved' ? t.inJournal : props.journal === 'outdated' ? t.updateInJournal : t.saveToJournal}
            aria-pressed={props.journal === 'saved'}
            disabled={streaming || card.messages.length === 0}
            onClick={() => {
              if (props.journal !== 'saved') props.onSaveToJournal(card.id)
            }}
          >
            {props.journal === 'saved' ? <ClipSavedIcon size={15} /> : <ClipIcon size={15} />}
          </button>
          <button type="button" className="icon-button" title={t.collapse} aria-label={t.collapse} onClick={() => props.onCollapse(card.id)}>
            <MinimizeIcon size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={t.removeCard}
            aria-label={t.removeCard}
            onClick={() => (card.messages.length <= 1 ? props.onRemove(card.id) : setConfirming(true))}
          >
            <CloseIcon size={15} />
          </button>
        </span>
      </header>

      {confirming && (
        <div className="yarn-confirm" role="alertdialog" aria-label={t.removeCard}>
          <p>{t.removeCardConfirm}</p>
          <div>
            <button type="button" className="text-button" onClick={() => setConfirming(false)}>{t.cancel}</button>
            <button type="button" className="text-button is-danger" onClick={() => props.onRemove(card.id)}>{t.delete}</button>
          </div>
        </div>
      )}

      <div className="yarn-card-middle">
        {image && <img className="yarn-card-image" src={image} alt={t.areaSelection} draggable={false} />}
        {quote && (
          <div className="yarn-card-quote-box">
            {props.onQuoteClick ? (
              <button type="button" className={`yarn-card-quote is-link${props.shortQuote ? ' is-short' : ''}`} onClick={() => props.onQuoteClick!(card.id)}>
                {quote}
              </button>
            ) : (
              <p className={`yarn-card-quote${props.shortQuote ? ' is-short' : ''}`}>{quote}</p>
            )}
            {longQuote && (
              <button type="button" className="quote-toggle" onClick={() => props.onToggleQuote(card.id)}>
                {props.shortQuote ? <ChevronDownIcon size={12} /> : <ChevronUpIcon size={12} />}
                {props.shortQuote ? t.quoteShowAll : t.quoteShorten}
              </button>
            )}
          </div>
        )}

        <div className="yarn-card-body">
          {card.messages.map((m, i) => {
            if (m.role === 'user') {
              if (isNote) return <p key={m.id} className="yarn-note-text" data-thread-source={card.id}>{m.content}</p>
              // The first instruction of a quick action is shown by the card title, not repeated.
              if (i === 0 && card.kind !== 'question') return null
              return <p key={m.id} className="yarn-question" data-thread-source={card.id}>{m.content}</p>
            }
            if (m.state === 'error') {
              const noKey = m.content === 'no-key'
              return (
                <div key={m.id} className="yarn-error" role="status">
                  <p>{noKey ? t.noKeyBody : errorText(t, m.content)}</p>
                  {noKey ? (
                    <button type="button" className="text-button" onClick={props.onOpenSettings}>{t.openSettings}</button>
                  ) : (
                    <button type="button" className="text-button" onClick={() => props.onRetry(card.id)}>
                      <RetryIcon size={14} /> {t.retry}
                    </button>
                  )}
                </div>
              )
            }
            return (
              <div key={m.id} className="yarn-answer" aria-live={m.state === 'streaming' ? 'polite' : undefined}>
                <AsterismIcon size={14} className="yarn-answer-mark" />
                <div className="yarn-answer-text" data-thread-source={card.id}>
                  {m.content ? <Markdown text={m.content} /> : <p className="yarn-thinking">{t.thinking}</p>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <footer className="yarn-card-footer">
        <textarea
          rows={1}
          value={draft}
          placeholder={isNote ? t.notePlaceholder : t.continuePlaceholder}
          aria-label={isNote ? t.notePlaceholder : t.continuePlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // Focusing must never pan the reading surface.
            e.currentTarget.closest<HTMLElement>('.reader-viewport')?.scrollTo(0, 0)
          }}
        />
        {streaming ? (
          <button type="button" className="send-button" aria-label={t.stop} onClick={() => props.onStop(card.id)}>
            <StopIcon size={14} />
          </button>
        ) : (
          <button type="button" className="send-button" aria-label={t.send} disabled={!draft.trim()} onClick={submit}>
            <SendIcon size={16} />
          </button>
        )}
      </footer>
      {props.onResize && !column && (
        <span
          className="yarn-card-grip"
          role="separator"
          aria-label={t.resizeCard}
          title={t.resizeCard}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onDoubleClick={() => props.onResize?.(card.id, GEOMETRY.cardWidth, undefined)}
        />
      )}
    </article>
  )
}

export const YarnCardView = memo(YarnCardViewImpl)
