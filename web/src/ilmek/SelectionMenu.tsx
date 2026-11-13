import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import yarnKinds from '@shared/yarn-kinds.json'
import { useI18n } from '../i18n/I18n'
import { ClipIcon, LinkIcon, NoteIcon, SendIcon, TranslateIcon } from '../ui/icons'
import type { YarnColor } from './types'

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

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 12
    let top = props.anchorRect.bottom + 10
    if (top + height > props.bounds.height - margin) top = Math.max(margin, props.anchorRect.top - height - 10)
    const center = (props.anchorRect.left + props.anchorRect.right) / 2
    const left = Math.min(Math.max(margin, center - width / 2), Math.max(margin, props.bounds.width - width - margin))
    setPos({ left, top })
  }, [props.anchorRect, props.bounds, noteMode, props.bridgeHeld])

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
