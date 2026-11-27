import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import yarnKinds from '@shared/yarn-kinds.json'
import { useI18n } from '../i18n/I18n'
import { ClipIcon, HighlighterIcon, LinkIcon, NoteIcon, SendIcon, TranslateIcon } from '../ui/icons'
import type { YarnColor } from './types'
import { HIGHLIGHT_COLORS, HIGHLIGHT_HOLD_MS, highlightColorName, type HighlightColor } from '../reader/highlightColors'

export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Props {
  anchorRect: ScreenRect
  bounds: { width: number; height: number }
  bridgeHeld: boolean
  canClip: boolean
  onQuick: (color: YarnColor) => void
  onAsk: (text: string) => void
  onNote: (text: string) => void
  onBridge: () => void
  onBridgeCompare: () => void
  onClip: () => void
  /** "Vurgula", between "Özete kırp" and "Notum": offered for text on a PDF page or translated page. */
  canHighlight?: boolean
  /** The colour "Vurgula" uses now; holding it (or a right-click) offers the four (owner, 16 Nov). */
  highlightColor?: HighlightColor
  onHighlight?: (color: HighlightColor) => void
  /** Offered when the current selection overlaps an existing highlight ("Vurguyu kaldır"). */
  onRemoveHighlight?: () => void
  onTranslate: () => void
  canBridge?: boolean
  onClose: () => void
}

/** The quick threads offered under a selection, in this order: Deepen · Simplify · Example. */
export const QUICK: YarnColor[] = ['lavender', 'mint', 'coral']

/** Two rows under the selection: quick threads and tools, then an always-open question field. */
export function SelectionMenu(props: Props) {
  const { t, lang } = useI18n()
  const [noteMode, setNoteMode] = useState(false)
  const [text, setText] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [pos, setPos] = useState({ left: props.anchorRect.left, top: props.anchorRect.bottom + 10 })
  const currentColor = props.highlightColor ?? 'yellow'
  // "Vurgula" held for two seconds opens the colours; the press shows how long is left.
  const [holding, setHolding] = useState(false)
  const [swatches, setSwatches] = useState(false)
  const holdTimer = useRef<number | undefined>(undefined)
  const heldOpen = useRef(false)
  const endHold = () => {
    window.clearTimeout(holdTimer.current)
    setHolding(false)
  }
  const startHold = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    heldOpen.current = false
    setHolding(true)
    window.clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      heldOpen.current = true
      setHolding(false)
      setSwatches(true)
    }, HIGHLIGHT_HOLD_MS)
  }
  useEffect(() => () => window.clearTimeout(holdTimer.current), [])

  // Below the selection when it fits, else above it. While a long question makes the field taller, the
  // menu keeps its side: below it grows down (as far as the window allows), above it grows up, so the
  // menu never jumps across the selection while typing (owner test 16 Nov).
  const above = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 12
    const place = (chooseSide: boolean) => {
      const { width, height } = el.getBoundingClientRect()
      const below = props.anchorRect.bottom + 10
      if (chooseSide) above.current = below + height > props.bounds.height - margin
      const top = above.current
        ? Math.max(margin, props.anchorRect.top - height - 10)
        : Math.max(margin, Math.min(below, props.bounds.height - margin - height))
      const center = (props.anchorRect.left + props.anchorRect.right) / 2
      const left = Math.min(Math.max(margin, center - width / 2), Math.max(margin, props.bounds.width - width - margin))
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }))
    }
    place(true)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place(false))
    observer.observe(el)
    return () => observer.disconnect()
  }, [props.anchorRect, props.bounds, noteMode, props.bridgeHeld, swatches])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const submit = () => {
    const body = text.trim()
    if (!body) return
    if (noteMode) props.onNote(body)
    else props.onAsk(body)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      ref={ref}
      className="selection-menu"
      role="dialog"
      aria-label={t.askPlaceholder}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => {
        // Keep the text selection alive while the menu is used.
        if ((e.target as HTMLElement).tagName !== 'TEXTAREA') e.preventDefault()
      }}
    >
      <div className="selection-menu-row">
        {props.bridgeHeld ? (
          <button type="button" className="menu-bridge-compare" onClick={props.onBridgeCompare}>
            <LinkIcon size={16} />
            {t.bridgeCompare}
          </button>
        ) : (
          QUICK.map((color) => (
            <button key={color} type="button" className="menu-quick" data-yarn={color} onClick={() => props.onQuick(color)}>
              <span className="yarn-dot" aria-hidden="true" />
              {yarnKinds.kinds[color].label[lang]}
            </button>
          ))
        )}
        <span className="menu-divider" aria-hidden="true" />
        <button type="button" className="menu-tool" title={yarnKinds.translate.label[lang]} aria-label={yarnKinds.translate.label[lang]} onClick={props.onTranslate}>
          <TranslateIcon size={17} />
        </button>
        {!props.bridgeHeld && props.canBridge !== false && (
          <button type="button" className="menu-tool" title={t.bridge} aria-label={t.bridge} onClick={props.onBridge}>
            <LinkIcon size={17} />
          </button>
        )}
        {props.canClip && (
          <button type="button" className="menu-tool" title={t.clip} aria-label={t.clip} onClick={props.onClip}>
            <ClipIcon size={17} />
          </button>
        )}
        {props.canHighlight && props.onHighlight && (
          <button
            type="button"
            className={`menu-tool menu-highlight${holding ? ' is-holding' : ''}`}
            data-hl={currentColor}
            title={t.highlightHold}
            aria-label={t.highlight}
            aria-haspopup="menu"
            aria-expanded={swatches}
            onPointerDown={startHold}
            onPointerUp={endHold}
            onPointerLeave={endHold}
            onPointerCancel={endHold}
            onContextMenu={(e) => {
              e.preventDefault()
              endHold()
              setSwatches(true)
            }}
            onClick={() => {
              // A press held until the colours opened is not also a click.
              if (heldOpen.current) {
                heldOpen.current = false
                return
              }
              props.onHighlight?.(currentColor)
            }}
          >
            <HighlighterIcon size={17} />
            <span className="highlight-current" aria-hidden="true" />
            <span className="hold-progress" aria-hidden="true" style={{ ['--hold-ms' as string]: `${HIGHLIGHT_HOLD_MS}ms` }} />
          </button>
        )}
        {props.onRemoveHighlight && (
          <button
            type="button"
            className="menu-remove-highlight"
            title={t.removeHighlight}
            aria-label={t.removeHighlight}
            onClick={props.onRemoveHighlight}
          >
            {t.removeHighlight}
          </button>
        )}
        <button
          type="button"
          className="menu-tool"
          data-yarn="cream"
          aria-pressed={noteMode}
          title={t.myNote}
          aria-label={t.myNote}
          onClick={() => {
            setNoteMode((v) => !v)
            requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
          }}
        >
          <NoteIcon size={17} />
        </button>
      </div>
      {swatches && props.onHighlight && (
        <div className="highlight-swatches" role="menu" aria-label={t.highlight}>
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={color === currentColor}
              className="highlight-swatch"
              data-hl={color}
              title={highlightColorName(color, t)}
              aria-label={highlightColorName(color, t)}
              onClick={() => {
                setSwatches(false)
                props.onHighlight?.(color)
              }}
            >
              <span className="highlight-swatch-dot" aria-hidden="true" />
              <span className="highlight-swatch-name">{highlightColorName(color, t)}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`selection-menu-ask${noteMode ? ' is-note' : ''}`}>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={noteMode ? t.notePlaceholder : t.askPlaceholder}
          aria-label={noteMode ? t.notePlaceholder : t.askPlaceholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="send-button" aria-label={t.send} disabled={!text.trim()} onClick={submit}>
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  )
}
