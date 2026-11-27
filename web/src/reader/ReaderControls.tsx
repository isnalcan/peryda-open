import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useI18n } from '../i18n/I18n'
import { LANGS, type Lang } from '../i18n/strings'
import { LANGUAGE_NAMES } from '../ai/compose'
import type { YarnColor } from '../ilmek/types'
import {
  AreaIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CursorIcon,
  PageIcon,
  StopIcon,
  ScrollIcon,
  TextIcon,
  TranslateIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '../ui/icons'
import type { Tool } from './PdfPageView'

/** Select and area: the tool in use is always marked (select when a book opens). */
export function ToolSwitcher({ tool, onTool }: { tool: Tool; onTool: (t: Tool) => void }) {
  const { t } = useI18n()
  const item = (value: Tool, label: string, icon: React.ReactNode) => (
    <button type="button" className="tool-switch" aria-pressed={tool === value} title={label} aria-label={label} onClick={() => onTool(value)}>
      {icon}
    </button>
  )
  return (
    <div className="tool-switcher" role="toolbar" aria-label={t.toolSelect}>
      {item('select', t.toolSelect, <CursorIcon size={16} />)}
      {item('area', t.toolArea, <AreaIcon size={16} />)}
    </div>
  )
}

/** Previous / page number (a click asks which page) / next, and the reading mode. */
export function PageNav(props: {
  page: number
  pages: number
  paged: boolean
  onPaged: (paged: boolean) => void
  onPrevious: () => void
  onNext: () => void
  onGoTo: (page: number) => void
}) {
  const { t } = useI18n()
  const [asking, setAsking] = useState(false)
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!asking) return
    input.current?.select()
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setAsking(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [asking])

  const go = () => {
    const n = Number.parseInt(text.trim(), 10)
    if (Number.isFinite(n) && n >= 1 && n <= props.pages) props.onGoTo(n)
    setAsking(false)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') go()
    if (e.key === 'Escape') setAsking(false)
  }

  return (
    <div className="page-nav">
      <div className="nav-group" ref={box}>
        <button type="button" className="icon-button" title={t.previousPage} aria-label={t.previousPage} disabled={props.page <= 1} onClick={props.onPrevious}>
          <ChevronLeftIcon size={16} />
        </button>
        <button
          type="button"
          className="page-number"
          title={t.goToPage}
          onClick={() => {
            setText(String(props.page))
            setAsking((v) => !v)
          }}
        >
          {t.pageOf(props.page, props.pages)}
        </button>
        <button type="button" className="icon-button" title={t.nextPage} aria-label={t.nextPage} disabled={props.page >= props.pages} onClick={props.onNext}>
          <ChevronRightIcon size={16} />
        </button>
        {asking && (
          <div className="popover go-to-page" role="dialog" aria-label={t.goToPage}>
            <input ref={input} inputMode="numeric" aria-label={t.pageNumber} placeholder={t.pageNumber} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
            <span className="faint">/ {props.pages}</span>
            <button type="button" className="primary-button small" onClick={go}>{t.goToPage}</button>
          </div>
        )}
      </div>
      <div className="segmented compact" role="radiogroup" aria-label={t.readByPage}>
        <button type="button" role="radio" aria-checked={!props.paged} title={t.readScrolling} aria-label={t.readScrolling} onClick={() => props.onPaged(false)}>
          <ScrollIcon size={15} />
        </button>
        <button type="button" role="radio" aria-checked={props.paged} title={t.readByPage} aria-label={t.readByPage} onClick={() => props.onPaged(true)}>
          <PageIcon size={15} />
        </button>
      </div>
    </div>
  )
}

/** "Translate this page" with a menu: the language, explaining terms or not, a range of pages, the page's text. */
export function TranslateMenu(props: {
  target: Lang
  /** Pages still on their way (being prepared, waiting, streaming or in a batch job). */
  pending: number
  onStop: () => void
  onTranslate: (target?: Lang) => void
  /** Hard terms explained in brackets in new translations. */
  explainTerms: boolean
  onExplainTerms: (on: boolean) => void
  onRange: () => void
  onExtract: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <>
    {props.pending > 0 && (
      // While pages are on their way the reader can always see how many, and stop them in one click.
      <div className="translating-pill" role="status">
        <span className="spinner" aria-hidden="true" />
        <span className="translating-count">{t.translationsPending(props.pending)}</span>
        <button type="button" title={t.stopTranslating} aria-label={t.stopTranslating} onClick={props.onStop}>
          <StopIcon size={12} />
        </button>
      </div>
    )}
    <div className="split-button" ref={box}>
      <button type="button" className="split-main" title={t.translateThisPage} onClick={() => props.onTranslate()}>
        <TranslateIcon size={16} /> <span>{t.translatePages}</span>
      </button>
      <button type="button" className="split-more" aria-haspopup="menu" aria-expanded={open} aria-label={t.translateInto} onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="popover menu" role="menu">
          <p className="menu-heading">{t.translateInto}</p>
          {LANGS.map((l) => (
            <button key={l} type="button" role="menuitemradio" aria-checked={l === props.target} onClick={pick(() => props.onTranslate(l))}>
              <span className="menu-check">{l === props.target && <CheckIcon size={14} />}</span>
              {LANGUAGE_NAMES[l].replace(/^./, (c) => c.toLocaleUpperCase(l))}
            </button>
          ))}
          <hr />
          {/* A setting, not an action: the menu stays open so the reader sees it change (owner test 15 Nov). */}
          <button type="button" role="menuitemcheckbox" aria-checked={props.explainTerms} onClick={() => props.onExplainTerms(!props.explainTerms)}>
            <span className="menu-check">{props.explainTerms && <CheckIcon size={14} />}</span>
            {t.explainTerms}
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={pick(props.onRange)}>
            <span className="menu-check" />
            {t.translateRange}
          </button>
          <button type="button" role="menuitem" onClick={pick(props.onExtract)}>
            <span className="menu-check"><TextIcon size={14} /></span>
            {t.extractText}
          </button>
          {props.pending > 0 && (
            <>
              <hr />
              <button type="button" role="menuitem" onClick={pick(props.onStop)}>
                <span className="menu-check"><StopIcon size={13} /></span>
                {t.stopTranslating}
              </button>
            </>
          )}
        </div>
      )}
    </div>
    </>
  )
}

/** The camera controls, floating at the bottom right: faint until the pointer comes near. */
export function CameraBar(props: { scale: number; onFocus: () => void; onMap: () => void; onZoomIn: () => void; onZoomOut: () => void; onActualSize: () => void }) {
  const { t } = useI18n()
  return (
    <div className="camera-bar" role="group" aria-label={t.cameraMap}>
      <button type="button" onClick={props.onFocus}>{t.cameraFocus}</button>
      <button type="button" onClick={props.onMap}>{t.cameraMap}</button>
      <span className="camera-divider" aria-hidden="true" />
      <button type="button" className="icon-only" title={t.zoomOut} aria-label={t.zoomOut} onClick={props.onZoomOut}>
        <ZoomOutIcon size={15} />
      </button>
      <button type="button" className="camera-scale" title="100%" onClick={props.onActualSize}>
        {Math.round(props.scale * 100)}%
      </button>
      <button type="button" className="icon-only" title={t.zoomIn} aria-label={t.zoomIn} onClick={props.onZoomIn}>
        <ZoomInIcon size={15} />
      </button>
    </div>
  )
}

/** A folded thread opened inside a card: a hole punched near the card's edge, a strand of the thread's colour through it, knotted outside. */
export function TiedKnot({
  color,
  right,
  title,
  x,
  y,
  tying,
  onOpen,
}: {
  color: YarnColor
  right: boolean
  title: string
  x: number
  y: number
  tying?: boolean
  onOpen: () => void
}) {
  // The hole sits 13 units inside the card's edge; the knot and its tails hang outside.
  const left = right ? x - 13 : x - 36 + 13
  return (
    <button
      type="button"
      className={tying ? 'tied-knot is-tying' : 'tied-knot'}
      data-yarn={color}
      title={title}
      aria-label={title}
      style={{ transform: `translate(${left}px, ${y - 18}px)` }}
      onClick={onOpen}
    >
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" style={right ? undefined : { transform: 'scaleX(-1)' }}>
        <circle cx="7" cy="15" r="3.4" className="knot-hole" />
        <circle cx="7" cy="15.5" r="2.8" className="knot-hole-shadow" />
        <path d="M8 16 C 11 24, 17 24, 21 16" className="knot-under" />
        <path d="M7 15 C 10 6, 17 7, 21 16" className="knot-over" />
        <circle cx="19.8" cy="15.2" r="3.6" className="knot-turn" />
        <circle cx="22.3" cy="17" r="3.3" className="knot-turn" />
        <path d="M23 19 Q 29 21, 31 30" className="knot-tail" />
        <path d="M21 19.5 Q 20 28, 24 33" className="knot-tail" />
      </svg>
    </button>
  )
}

/** Right-click on a page: translate it, or show its text. */
export function PageMenu(props: { x: number; y: number; onTranslate: () => void; onExtract: () => void; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector('button')?.focus({ preventScroll: true })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  const pick = (fn: () => void) => () => {
    props.onClose()
    fn()
  }
  return (
    <div ref={ref} className="popover menu page-menu" role="menu" style={{ left: props.x, top: props.y }}>
      <button type="button" role="menuitem" onClick={pick(props.onTranslate)}>
        <span className="menu-check"><TranslateIcon size={14} /></span>
        {t.translateThisPage}
      </button>
      <button type="button" role="menuitem" onClick={pick(props.onExtract)}>
        <span className="menu-check"><TextIcon size={14} /></span>
        {t.extractText}
      </button>
    </div>
  )
}
