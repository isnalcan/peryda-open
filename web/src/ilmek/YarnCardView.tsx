import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useI18n } from '../i18n/I18n'
import { kindTitle } from '../ai/compose'
import { Markdown } from '../ui/Markdown'
import { AsterismIcon, ClipIcon, ClipSavedIcon, CloseIcon, MagnetIcon, MinimizeIcon, RetryIcon, SendIcon, StopIcon, TextLargerIcon, TextSmallerIcon } from '../ui/icons'
import type { Strings } from '../i18n/strings'
import { CARD_HEIGHT_RANGE, CARD_WIDTH_RANGE } from './cardsStore'
import { GEOMETRY } from './geometry'
import type { YarnCard } from './types'
import { CARD_TEXT_SCALES, type JournalState } from './useThreadActions'
import type { PresenceState } from './useThreadPresence'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

interface Props {
  /** 'world' cards float on the reading surface; 'column' cards sit in a list beside an EPUB. */
  layout?: 'world' | 'column'
  card: YarnCard
  x: number
  y: number
  /** The camera's current zoom (read during a drag or resize, so zooming never re-renders cards). */
  scale: () => number
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
  /** Resizing from the left edge: the right edge stays, so the card is placed with its new left edge at `y`. */
  onResizeFrom?: (id: string, width: number, right: number, y: number) => void
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
  /** When given (cards in a column beside an EPUB), the card's title is a link back to its passage. */
  onQuoteClick?: (id: string) => void
  /** Presence state for smooth enter / unravel exit transitions. */
  presence?: PresenceState
  /** True when the card sits left of the page (yarn attaches on its right edge). */
  onLeftSide?: boolean
  /** Optional stagger delay (ms) when revealing/hiding threads together. */
  delayMs?: number
}

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

/** How long a card keeps its delayed entrance transition after it turns 'open' (delay + slide). */
export const CARD_SETTLE_MS = 600

/**
 * True for a moment after a card goes from 'entering' to 'open'. Only then does the card wait for its
 * yarn to draw out before sliding in (`.is-settling`); any later move (a reflow, a streaming answer
 * pushing it down) follows its yarn at once.
 */
function useSettling(presence: PresenceState, delayMs = 0): boolean {
  const prev = useRef(presence)
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    const was = prev.current
    prev.current = presence
    if (presence !== 'open') {
      setSettling(presence === 'entering')
      return
    }
    if (was !== 'entering') return
    setSettling(true)
    const timer = window.setTimeout(() => setSettling(false), CARD_SETTLE_MS + delayMs)
    return () => window.clearTimeout(timer)
  }, [presence, delayMs])
  return settling
}

function YarnCardViewImpl(props: Props) {
  const { card } = props
  const { t, lang } = useI18n()
  const ref = useRef<HTMLElement>(null)
  const middleRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const smoothScrollUntilRef = useRef(0)
  const userSentRef = useRef(false)
  const prevMsgCountRef = useRef(card.messages.length)
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
  const [size, setSizeState] = useState<{ w: number; h?: number } | null>(null)
  const sizeRef = useRef<{ w: number; h?: number } | null>(null)
  const setSize = (v: { w: number; h?: number } | null) => {
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

  // Side edges change only the width (owner, 16 Nov). From the right edge the card grows to the right;
  // from the left edge its right edge stays, so the card is placed where its new left edge is.
  const edgeStart = useRef<{ px: number; w: number; x: number; side: 'left' | 'right' } | null>(null)
  const onEdgeDown = (side: 'left' | 'right') => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    capture(e)
    props.onFocusCard(card.id)
    edgeStart.current = { px: e.clientX, w: card.width, x: props.x, side }
  }
  const onEdgeMove = (e: PointerEvent<HTMLElement>) => {
    const s = edgeStart.current
    if (!s) return
    const dx = (e.clientX - s.px) / props.scale()
    const w = clamp(s.side === 'right' ? s.w + dx : s.w - dx, CARD_WIDTH_RANGE)
    setSize({ w, h: card.height })
    if (s.side === 'left') {
      const at = { x: s.x + s.w - w, y: props.y }
      setDrag(at)
      props.onDragLive?.(card.id, at)
    }
  }
  const onEdgeUp = () => {
    const s = edgeStart.current
    edgeStart.current = null
    const end = sizeRef.current
    if (s && end) {
      if (s.side === 'right') props.onResize?.(card.id, end.w, card.height)
      else props.onResizeFrom?.(card.id, end.w, s.x + s.w, props.y)
    }
    setSize(null)
    if (s?.side === 'left') {
      setDrag(null)
      props.onDragLive?.(card.id, null)
    }
  }
  const edge = (side: 'left' | 'right') => (
    <span
      className={`yarn-card-edge is-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t.resizeCardWidth}
      title={t.resizeCardWidth}
      onPointerDown={onEdgeDown(side)}
      onPointerMove={onEdgeMove}
      onPointerUp={onEdgeUp}
      onPointerCancel={onEdgeUp}
      onDoubleClick={() => props.onResize?.(card.id, GEOMETRY.cardWidth, card.height)}
    />
  )

  const submit = () => {
    const body = draft.trim()
    if (!body || streaming) return
    userSentRef.current = true
    stickToBottomRef.current = true
    props.onAsk(card.id, body)
    setDraft('')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const lastMessage = card.messages[card.messages.length - 1]
  useEffect(() => {
    const prevCount = prevMsgCountRef.current
    const countGrew = card.messages.length > prevCount
    prevMsgCountRef.current = card.messages.length

    const el = middleRef.current
    if (!el) return

    const isFollowUp = userSentRef.current || (prevCount >= 2 && countGrew)
    if (column) {
      if (isFollowUp) {
        userSentRef.current = false
        requestAnimationFrame(() => {
          el.lastElementChild?.scrollIntoView?.({ block: 'end', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
        })
      }
      return
    }

    if (isFollowUp) {
      userSentRef.current = false
      stickToBottomRef.current = true
      smoothScrollUntilRef.current = performance.now() + 450
      requestAnimationFrame(() => {
        const target = el.scrollHeight
        if (typeof el.scrollTo === 'function') {
          el.scrollTo({ top: target, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
        } else {
          el.scrollTop = target
        }
        lastScrollTopRef.current = el.scrollTop
      })
      return
    }

    // Follow streaming tokens on follow-up turns unless the reader scrolled up to read earlier parts.
    if (card.messages.length > 2 && streaming && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    }
  }, [card.messages.length, lastMessage?.content, lastMessage?.state, column, streaming])

  const onMiddleScroll = () => {
    const el = middleRef.current
    if (!el) return
    const top = el.scrollTop
    const prevTop = lastScrollTopRef.current
    lastScrollTopRef.current = top
    if (top < prevTop - 2) {
      smoothScrollUntilRef.current = 0
      stickToBottomRef.current = false
      return
    }
    if (performance.now() < smoothScrollUntilRef.current) {
      stickToBottomRef.current = true
      return
    }
    stickToBottomRef.current = el.scrollHeight - top - el.clientHeight <= 56
  }

  // A page area shows its picture only (owner test 15 Nov). A passage of text is not quoted in the card:
  // it is marked where it was chosen (on the page, in a card or a translation), so the card is the
  // conversation alone (owner test 16 Nov).
  const image = card.anchors.find((a) => a.croppedImage)?.croppedImage
  const x = drag?.x ?? props.x
  const y = drag?.y ?? props.y
  const width = size?.w ?? card.width
  const height = size?.h ?? card.height
  const fixedHeight = !column && height !== undefined
  const presence = props.presence ?? 'open'
  const settling = useSettling(presence, props.delayMs)
  const shiftedX = !column && presence !== 'open' ? x + (props.onLeftSide ? 10 : -10) : x
  const scaleSuffix = !column && presence !== 'open' ? ' scale(0.96)' : ''

  return (
    <article
      ref={ref}
      className={`yarn-card${column ? ' is-column' : ''}${card.isPinned ? ' is-pinned' : ''}${drag || size ? ' is-dragging' : ''}${fixedHeight ? ' has-height' : ''}${settling ? ' is-settling' : ''}`}
      data-yarn={card.color}
      data-card-id={card.id}
      data-state={presence}
      style={
        column
          ? props.delayMs
            ? { ['--card-delay' as string]: `${props.delayMs}ms` }
            : undefined
          : {
              transform: `translate(${shiftedX}px, ${y}px)${scaleSuffix}`,
              transformOrigin: props.onLeftSide ? `100% ${GEOMETRY.cardAttachY}px` : `0px ${GEOMETRY.cardAttachY}px`,
              width,
              height: fixedHeight ? height : undefined,
              ...(props.delayMs ? { ['--card-delay' as string]: `${props.delayMs}ms` } : {}),
            }
      }
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
        {props.onQuoteClick ? (
          <button type="button" className="yarn-card-title is-link" onPointerDown={(e) => e.stopPropagation()} onClick={() => props.onQuoteClick!(card.id)}>
            {kindTitle(lang, card)}
          </button>
        ) : (
          <span className="yarn-card-title">{kindTitle(lang, card)}</span>
        )}
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

      <div ref={middleRef} className="yarn-card-middle" onScroll={onMiddleScroll}>
        {image && <img className="yarn-card-image" src={image} alt={t.areaSelection} draggable={false} />}

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
      {props.onResizeFrom && !column && edge('left')}
      {props.onResize && !column && edge('right')}
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
