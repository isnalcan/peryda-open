import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EpubCFI, type Contents, type Rendition } from 'epubjs'
import tokens from '@shared/tokens.json'
import { db, getPref, newId, setPref, type BookRecord } from '../data/db'
import { RENDITION_OPTIONS, openEpub, sanitizeChapters, type Book } from '../epub/epub'
import { useI18n } from '../i18n/I18n'
import type { ByokSettings } from '../ai/provider'
import { CONTEXT_LENGTH, chapterTitle, kindLabel, kindTitle } from '../ai/compose'
import { useCards } from '../ilmek/useCards'
import { useThreadActions } from '../ilmek/useThreadActions'
import { YarnCardView } from '../ilmek/YarnCardView'
import { SelectionMenu, type ScreenRect } from '../ilmek/SelectionMenu'
import type { PdfYarnAnchor, YarnCard, YarnColor } from '../ilmek/types'
import { JournalPanel } from '../journal/JournalPanel'
import { normalizeText } from './selection'
import { ReaderTopBar } from './ReaderTopBar'
import { EyeIcon, EyeOffIcon, ZoomInIcon, ZoomOutIcon } from '../ui/icons'
import { useThreadSelection } from './useThreadSelection'
import { ignoreStrayDrops } from '../app/drops'

interface Props {
  book: BookRecord
  settings: ByokSettings
  /** Called once, when the first chapter has been shown (the book opened safely). */
  onOpened?: (bookId: string) => void
  onBack: () => void
  onOpenSettings: () => void
}

interface Pending {
  anchors: PdfYarnAnchor[]
  rect: ScreenRect
  parentCardId?: string
}

const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0 }

function resolvedTheme(): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'light' || forced === 'dark') return forced
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function EpubReader({ book, settings, onOpened, onBack, onOpenSettings }: Props) {
  const { t, lang } = useI18n()
  const shellRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const epubRef = useRef<Book | null>(null)
  const [rendition, setRendition] = useState<Rendition | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [bridgeHeld, setBridgeHeld] = useState<PdfYarnAnchor[] | null>(null)
  const [chapter, setChapter] = useState(0)
  const [hideThreads, setHideThreads] = useState(false)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [shortQuotes, setShortQuotes] = useState<ReadonlySet<string>>(() => new Set())
  const [showJournal, setShowJournal] = useState(false)
  const [fontScale, setFontScale] = useState(100)
  const [bounds, setBounds] = useState({ width: 800, height: 600 })
  const { cards, create, ask, retry, stop, remove, update } = useCards({ bookId: book.id, bookTitle: book.title, lang, settings })
  const actions = useThreadActions({ bookId: book.id, cards, t })

  useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setBounds({ width: r.width, height: r.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    void getPref<number>('epubFontScale', 100).then(setFontScale)
  }, [])

  // Open the book and render it as one continuous scroll.
  useEffect(() => {
    let rend: Rendition | null = null
    let bk: Book | null = null
    let cancelled = false
    void (async () => {
      try {
        const file = await db.files.get(book.id)
        if (!file || !hostRef.current) throw new Error('missing file')
        bk = openEpub(await file.blob.arrayBuffer())
        epubRef.current = bk
        await bk.ready
        if (cancelled || !hostRef.current) return
        sanitizeChapters(bk)
        rend = bk.renderTo(hostRef.current, { ...RENDITION_OPTIONS })
        rend.hooks.content.register((contents: Contents) => {
          contents.addStylesheet(`${location.origin}/fonts/fonts.css`)
          // A file dropped on the book's frame is ignored too (it would navigate away).
          ignoreStrayDrops(contents.document)
        })
        const saved = await db.positions.get(book.id)
        await rend.display(saved?.cfi || undefined)
        if (cancelled) return
        onOpened?.(book.id)
        rend.on('relocated', (loc: { start: { cfi: string; index: number } }) => {
          setChapter(loc.start.index + 1)
          void db.positions.put({ bookId: book.id, cfi: loc.start.cfi, panX: 0, panY: 0, scale: 1, page: loc.start.index + 1, updatedAt: Date.now() })
        })
        rend.on('selected', (cfiRange: string, contents: Contents) => {
          const range = contents.range(cfiRange)
          const text = normalizeText(contents.window?.getSelection()?.toString() || range.toString())
          const frame = (contents.document.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
          const shell = shellRef.current?.getBoundingClientRect()
          if (!text || !frame || !shell) return
          const r = range.getBoundingClientRect()
          const section = bk?.spine.get(cfiRange) as { index?: number } | undefined
          const anchor: PdfYarnAnchor = {
            id: newId(),
            sourceType: 'epub_text',
            bookId: book.id,
            pageNumber: (section?.index ?? 0) + 1,
            selectedText: text,
            lineRects: [],
            boundingRect: EMPTY_RECT,
            cfi: cfiRange,
            // The chapter's opening travels with the selection as its context.
            context: (contents.document.body?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_LENGTH) || undefined,
          }
          setPending({
            anchors: [anchor],
            rect: {
              left: frame.left + r.left - shell.left,
              top: frame.top + r.top - shell.top,
              right: frame.left + r.right - shell.left,
              bottom: frame.top + r.bottom - shell.top,
            },
          })
        })
        rend.on('click', () => setPending(null))
        rend.on('markClicked', (_cfi: string, data: { cardId?: string }) => {
          if (data?.cardId) onMarkClicked(data.cardId)
        })
        setRendition(rend)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      rend?.destroy()
      bk?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  // The book reflows when its column changes size (window, journal, lane).
  useEffect(() => {
    const el = hostRef.current
    if (!rendition || !el) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) rendition.resize(r.width, r.height)
      })
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [rendition])

  // Reading theme follows the app theme and the chosen text size.
  useEffect(() => {
    if (!rendition) return
    const apply = () => {
      const theme = resolvedTheme()
      const p = tokens.palette[theme]
      rendition.themes.default({
        body: {
          background: `${p.paper} !important`,
          color: `${p.ink} !important`,
          'font-family': "'Literata', Georgia, serif !important",
          'line-height': '1.65 !important',
          padding: '0 8px !important',
        },
        a: { color: `${p.accent} !important` },
        '::selection': { background: 'rgba(51, 96, 79, 0.28)' },
      })
      rendition.themes.fontSize(`${fontScale}%`)
    }
    apply()
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media.removeEventListener('change', apply)
      observer.disconnect()
    }
  }, [rendition, fontScale])

  // Keep the highlights in the book in step with the cards.
  const marked = useRef(new Map<string, string>())
  useEffect(() => {
    if (!rendition) return
    const dark = resolvedTheme() === 'dark'
    const wanted = new Map<string, { cfi: string; color: YarnColor; cardId: string }>()
    for (const card of cards) {
      for (const a of card.anchors) if (a.sourceType === 'epub_text' && a.cfi) wanted.set(`${card.id}|${a.cfi}|${card.color}`, { cfi: a.cfi, color: card.color, cardId: card.id })
    }
    for (const [key, cfi] of marked.current) {
      if (!wanted.has(key)) {
        rendition.annotations.remove(cfi, 'highlight')
        marked.current.delete(key)
      }
    }
    for (const [key, w] of wanted) {
      if (marked.current.has(key)) continue
      try {
        // epub.js accepts a single class name for a mark; the colour is passed as SVG styles.
        rendition.annotations.highlight(w.cfi, { cardId: w.cardId }, () => undefined, 'peryda-hl', {
          fill: tokens.yarn[w.color][dark ? 'dark' : 'light'],
          'fill-opacity': dark ? '0.3' : '0.22',
          'mix-blend-mode': dark ? 'normal' : 'multiply',
        })
        marked.current.set(key, w.cfi)
      } catch {
        /* a CFI that no longer resolves (edited book) is skipped */
      }
    }
  }, [rendition, cards])

  const [focused, setFocused] = useState<string | null>(null)
  const onMarkClicked = (cardId: string) => {
    const card = cards.find((c) => c.id === cardId)
    if (card?.collapsed) update(cardId, { collapsed: false })
    // With threads hidden, a highlight brings back just its own card.
    setRevealed((r) => (r.has(cardId) ? r : new Set(r).add(cardId)))
    setFocused(cardId)
    // Escaped: a card id from a backup must not be able to break the selector.
    document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  // Selections inside a card (answer, question, note) open a thread from that card.
  const readCardSelection = useThreadSelection(cards)
  const onColumnPointerUp = () => {
    window.setTimeout(() => {
      const shell = shellRef.current?.getBoundingClientRect()
      const found = readCardSelection()
      if (!found || !shell) return
      const { cardId, text, rect: r, context } = found
      const anchor: PdfYarnAnchor = { id: newId(), sourceType: 'card', bookId: book.id, pageNumber: 0, selectedText: text, lineRects: [], boundingRect: EMPTY_RECT, sourceCardId: cardId, context }
      setPending({ anchors: [anchor], rect: { left: r.left - shell.left, top: r.top - shell.top, right: r.right - shell.left, bottom: r.bottom - shell.top }, parentCardId: cardId })
    }, 0)
  }

  const finish = () => {
    setPending(null)
    window.getSelection()?.removeAllRanges()
    const contents = rendition?.getContents() as unknown as Contents | Contents[] | undefined
    for (const c of Array.isArray(contents) ? contents : contents ? [contents] : []) c.window?.getSelection()?.removeAllRanges()
  }
  const createFromPending = (color: YarnColor, kind: YarnCard['kind'], text?: string) => {
    if (!pending) return
    const card = create({ color, kind, anchors: pending.anchors, parentCardId: pending.parentCardId, text })
    setFocused(card.id)
    if (hideThreads) setRevealed((r) => new Set(r).add(card.id))
    finish()
  }

  // Cards in reading order; a thread opened from a card follows its parent.
  const ordered = useMemo(() => {
    const cfi = new EpubCFI()
    const firstCfi = (c: YarnCard) => c.anchors.find((a) => a.cfi)?.cfi
    const roots = cards.filter((c) => !c.parentCardId || !cards.some((p) => p.id === c.parentCardId))
    roots.sort((a, b) => {
      const ca = firstCfi(a)
      const cb = firstCfi(b)
      if (ca && cb) return cfi.compare(ca, cb)
      return a.createdAt - b.createdAt
    })
    const out: { card: YarnCard; depth: number }[] = []
    const visit = (card: YarnCard, depth: number) => {
      out.push({ card, depth })
      for (const child of cards.filter((c) => c.parentCardId === card.id)) visit(child, depth + 1)
    }
    for (const r of roots) visit(r, 0)
    return out
  }, [cards])

  const goTo = useCallback(
    (cardId: string) => {
      const target = cards.find((c) => c.id === cardId)?.anchors.find((a) => a.cfi)?.cfi
      if (target) void rendition?.display(target)
    },
    [cards, rendition],
  )
  const noop = useCallback(() => undefined, [])
  const onCollapse = useCallback((id: string) => update(id, { collapsed: true }), [update])
  const onToggleQuote = useCallback((id: string) => {
    setShortQuotes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const one = useCallback(() => 1, [])
  const changeFont = (delta: number) => {
    const next = Math.min(180, Math.max(70, fontScale + delta))
    setFontScale(next)
    void setPref('epubFontScale', next)
  }

  return (
    <div className="reader-shell">
      <ReaderTopBar
        title={book.title}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        onOpenJournal={() => setShowJournal((v) => !v)}
        journalOpen={showJournal}
      >
        <span className="reader-page-label">{chapter ? chapterTitle(lang, chapter) : ''}</span>
        <div className="camera-capsule" role="group">
          <button type="button" className="icon-only" aria-label={t.zoomOut} title={t.zoomOut} onClick={() => changeFont(-10)}>
            <ZoomOutIcon size={16} />
          </button>
          <button type="button" onClick={() => changeFont(100 - fontScale)}>{fontScale}%</button>
          <button type="button" className="icon-only" aria-label={t.zoomIn} title={t.zoomIn} onClick={() => changeFont(10)}>
            <ZoomInIcon size={16} />
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-pressed={hideThreads}
          title={hideThreads ? t.showThreads : t.hideThreads}
          aria-label={hideThreads ? t.showThreads : t.hideThreads}
          onClick={() => {
            setHideThreads((v) => !v)
            setRevealed(new Set())
          }}
        >
          {hideThreads ? <EyeIcon size={18} /> : <EyeOffIcon size={18} />}
        </button>
      </ReaderTopBar>
      {bridgeHeld && (
        <div className="bridge-banner" role="status">
          {t.bridgeHeld}
          <button type="button" className="text-button" onClick={() => setBridgeHeld(null)}>{t.cancel}</button>
        </div>
      )}
      <div ref={shellRef} className="epub-shell">
        <div className="epub-reading">
          {failed ? <p className="reader-message">{t.importFailed}</p> : <div ref={hostRef} className="epub-host" />}
        </div>
        <aside className="epub-lane" aria-label={t.journal} onPointerUp={onColumnPointerUp}>
          {ordered.filter(({ card }) => !hideThreads || revealed.has(card.id)).map(({ card, depth }) =>
            card.collapsed ? (
              <button
                key={card.id}
                type="button"
                className="epub-knot"
                data-yarn={card.color}
                style={{ marginLeft: depth * 16 }}
                onClick={() => update(card.id, { collapsed: false })}
              >
                <span className="yarn-dot" />
                {card.kind === 'question' || card.kind === 'bridge' || card.kind === 'translate' ? kindTitle(lang, card) : kindLabel(lang, card.kind)}
                <span className="epub-knot-quote">{card.anchors[0]?.selectedText}</span>
              </button>
            ) : (
              <div key={card.id} className={`epub-card-slot${focused === card.id ? ' is-focused' : ''}`} style={{ marginLeft: depth * 16 }}>
                <YarnCardView
                  layout="column"
                  card={card}
                  x={0}
                  y={0}
                  scale={one}
                  shortQuote={shortQuotes.has(card.id)}
                  onToggleQuote={onToggleQuote}
                  onHeight={noop}
                  onAsk={ask}
                  onRetry={retry}
                  onStop={stop}
                  onRemove={remove}
                  onMove={noop}
                  onUnpin={noop}
                  onCollapse={onCollapse}
                  onOpenSettings={onOpenSettings}
                  onFocusCard={(id) => {
                    setFocused(id)
                  }}
                  onSaveToJournal={actions.saveToJournal}
                  onQuoteClick={goTo}
                />
              </div>
            ),
          )}
        </aside>
        {showJournal && (
          <JournalPanel bookId={book.id} bookTitle={book.title} settings={settings} notePage={chapter} onOpenSettings={onOpenSettings} onClose={() => setShowJournal(false)} />
        )}
        {pending && (
          <SelectionMenu
            anchorRect={pending.rect}
            bounds={bounds}
            bridgeHeld={Boolean(bridgeHeld) && !pending.parentCardId}
            canClip={!pending.parentCardId}
            canBridge={!pending.parentCardId}
            onQuick={(color) => createFromPending(color, color)}
            onAsk={(text) => createFromPending('mint', 'question', text)}
            onNote={(text) => createFromPending('cream', 'cream', text)}
            onTranslate={() => createFromPending('sky', 'translate')}
            onBridge={() => {
              setBridgeHeld(pending.anchors)
              finish()
            }}
            onBridgeCompare={() => {
              if (!bridgeHeld) return
              const card = create({ color: 'sky', kind: 'bridge', anchors: [...bridgeHeld, ...pending.anchors] })
              setFocused(card.id)
              setBridgeHeld(null)
              finish()
            }}
            onClip={() => {
              const anchors = pending.anchors
              finish()
              void actions.clip(anchors)
            }}
            onClose={finish}
          />
        )}
      </div>
      {actions.toast && <div className="toast" role="status">{actions.toast}</div>}
    </div>
  )
}
