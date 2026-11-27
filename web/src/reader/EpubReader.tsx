import { centeredContext } from '../ai/centeredContext'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EpubCFI, type Contents, type Rendition } from 'epubjs'
import tokens from '@shared/tokens.json'
import { db, getPref, newId, setPref, type BookRecord } from '../data/db'
import { RENDITION_OPTIONS, openEpub, sanitizeChapters, type Book } from '../epub/epub'
import { useI18n } from '../i18n/I18n'
import type { ByokSettings } from '../ai/provider'
import { chapterTitle, kindLabel, kindTitle } from '../ai/compose'
import { useCards } from '../ilmek/useCards'
import { useThreadActions } from '../ilmek/useThreadActions'
import { findCardThreadAtPoint, useThreadMarks } from '../ilmek/threadMarks'
import { useThreadPresence } from '../ilmek/useThreadPresence'
import { YarnCardView } from '../ilmek/YarnCardView'
import { SelectionMenu, type ScreenRect } from '../ilmek/SelectionMenu'
import type { PdfYarnAnchor, YarnCard, YarnColor } from '../ilmek/types'
import { JournalPanel } from '../journal/JournalPanel'
import { normalizeText } from './selection'
import { ReaderTopBar } from './ReaderTopBar'
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, ZoomInIcon, ZoomOutIcon } from '../ui/icons'
import { useThreadSelection } from './useThreadSelection'
import { ignoreStrayDrops } from '../app/drops'
import { BookInfoDialog } from '../library/BookInfoDialog'

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
  const [chapterCount, setChapterCount] = useState(book.pageCount || 0)
  const [tocItems, setTocItems] = useState<{ label: string; href: string; spineIndex: number }[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const tocBoxRef = useRef<HTMLDivElement>(null)
  const [hideThreads, setHideThreads] = useState(false)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [showJournal, setShowJournal] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [fontScale, setFontScale] = useState(100)
  const [bounds, setBounds] = useState({ width: 800, height: 600 })
  const { cards, loaded: cardsLoaded, create, ask, retry, stop, remove, update } = useCards({ bookId: book.id, bookTitle: book.title, lang, settings })
  const actions = useThreadActions({ bookId: book.id, cards, t })
  // Passages threads were opened from inside cards, marked in those threads' colours.
  const laneRef = useRef<HTMLElement>(null)
  useThreadMarks(laneRef, cards)

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
        const nav = await bk.loaded.navigation.catch(() => null)
        if (cancelled || !hostRef.current) return
        const spineItems = ((bk.spine as unknown as { items?: { index: number; href: string; canonical?: string }[] }).items ?? [])
        if (spineItems.length > 0) setChapterCount(spineItems.length)
        const rawToc = nav?.toc ?? []
        const flatToc: { label: string; href: string; spineIndex: number }[] = []
        const walkToc = (list: { label?: string; href?: string; subitems?: unknown[] }[]) => {
          for (const item of list) {
            const href = (item.href ?? '').trim()
            const label = (item.label ?? '').trim()
            if (href && label) {
              const cleanHref = href.split('#')[0] ?? href
              const sec = (bk?.spine.get(href) ?? bk?.spine.get(cleanHref)) as { index?: number } | undefined
              const matched = sec?.index ?? spineItems.findIndex((s) => s.href.endsWith(cleanHref) || cleanHref.endsWith(s.href))
              flatToc.push({ label, href, spineIndex: matched >= 0 ? matched + 1 : flatToc.length + 1 })
            }
            if (Array.isArray(item.subitems) && item.subitems.length) {
              walkToc(item.subitems as { label?: string; href?: string; subitems?: unknown[] }[])
            }
          }
        }
        walkToc(rawToc)
        setTocItems(flatToc)
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
        setChapter((prev) => prev || saved?.page || 1)
        void db.books.update(book.id, { openedAt: Date.now() })
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
            // The chapter's text around the selection travels with it as its context.
            context: centeredContext(contents.document.body?.textContent ?? '', text),
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

  // In continuous scroll mode, epub.js does not always emit `relocated` when scrolling across already-mounted
  // short chapters; track the chapter crossing the reading line directly from scroll events.
  useEffect(() => {
    const el = hostRef.current
    if (!rendition || !el) return
    let raf = 0
    let saveTimer = 0
    const updateActiveChapter = () => {
      raf = 0
      const views = (rendition as unknown as { manager?: { views?: { _views?: { index?: number; element?: HTMLElement }[] } } }).manager?.views?._views
      if (!views?.length) return
      const hostRect = el.getBoundingClientRect()
      const readingY = hostRect.top + Math.min(180, hostRect.height * 0.35)
      let activeIndex: number | undefined
      for (const v of views) {
        if (!v.element || typeof v.index !== 'number') continue
        const vr = v.element.getBoundingClientRect()
        if (vr.height <= 0) continue
        if (vr.top <= readingY) activeIndex = v.index
        else if (activeIndex === undefined) activeIndex = v.index
      }
      if (activeIndex !== undefined) {
        const nextChapter = activeIndex + 1
        setChapter((prev) => {
          if (prev === nextChapter) return prev
          window.clearTimeout(saveTimer)
          saveTimer = window.setTimeout(() => {
            void db.positions.get(book.id).then((existing) =>
              db.positions.put({
                bookId: book.id,
                cfi: existing?.cfi,
                panX: 0,
                panY: 0,
                scale: 1,
                page: nextChapter,
                updatedAt: Date.now(),
              }),
            )
          }, 300)
          return nextChapter
        })
      }
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(updateActiveChapter)
    }
    el.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll, { capture: true })
      cancelAnimationFrame(raf)
      window.clearTimeout(saveTimer)
    }
  }, [rendition, book.id])

  useEffect(() => {
    if (!tocOpen) return
    const onDown = (e: PointerEvent) => {
      if (!tocBoxRef.current?.contains(e.target as Node)) setTocOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTocOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [tocOpen])

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
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const onMarkClicked = (cardId: string) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c]))
    const chainIds: string[] = []
    const seen = new Set<string>()
    let curr = byId.get(cardId)
    while (curr && !seen.has(curr.id)) {
      seen.add(curr.id)
      chainIds.push(curr.id)
      if (curr.collapsed) update(curr.id, { collapsed: false })
      curr = curr.parentCardId ? byId.get(curr.parentCardId) : undefined
    }
    // With threads hidden, a highlight brings back its own card (and any parent card it hangs from).
    setRevealed((r) => {
      if (chainIds.every((id) => r.has(id))) return r
      const next = new Set(r)
      for (const id of chainIds) next.add(id)
      return next
    })
    setFocused(cardId)
    // Escaped: a card id from a backup must not be able to break the selector. Deferred one frame so a card
    // that was folded has mounted into `.epub-lane` before scrolling to it.
    requestAnimationFrame(() => {
      document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }

  // Selections inside a card (answer, question, note) open a thread from that card; a plain click on a
  // marked child-thread phrase opens/reveals that child thread.
  const readCardSelection = useThreadSelection(cards)
  const columnDownRef = useRef<{ x: number; y: number } | null>(null)
  const onColumnPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button === 0) columnDownRef.current = { x: e.clientX, y: e.clientY }
  }
  const onColumnPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const cx = e.clientX
    const cy = e.clientY
    const start = columnDownRef.current
    const movedLittle = !start || Math.hypot(cx - start.x, cy - start.y) <= 8
    const targetEl = e.target instanceof HTMLElement ? e.target : null
    window.setTimeout(() => {
      const source = movedLittle ? targetEl?.closest<HTMLElement>('[data-thread-source]') : null
      const sourceCardId = source?.dataset.threadSource
      if (source && sourceCardId) {
        const hitId = findCardThreadAtPoint(source, source.closest<HTMLElement>('[data-card-id]'), cx, cy, sourceCardId, cardsRef.current)
        if (hitId) {
          const hitCard = cardsRef.current.find((c) => c.id === hitId)
          const isFolded = Boolean(hitCard && (hitCard.collapsed || (hideThreads && !revealed.has(hitId))))
          const sel = window.getSelection()
          const hasSelection = Boolean(sel && !sel.isCollapsed && sel.toString().trim().length > 0)
          if (isFolded || !hasSelection) {
            if (isFolded) sel?.removeAllRanges()
            onMarkClicked(hitId)
            return
          }
        }
      }
      const shell = shellRef.current?.getBoundingClientRect()
      const found = readCardSelection()
      if (found && shell) {
        const { cardId, text, rect: r, context } = found
        const anchor: PdfYarnAnchor = { id: newId(), sourceType: 'card', bookId: book.id, pageNumber: 0, selectedText: text, lineRects: [], boundingRect: EMPTY_RECT, sourceCardId: cardId, context }
        setPending({ anchors: [anchor], rect: { left: r.left - shell.left, top: r.top - shell.top, right: r.right - shell.left, bottom: r.bottom - shell.top }, parentCardId: cardId })
      }
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

  const existingIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards])
  const epubShownIds = useMemo(() => {
    const byId = new Map(cards.map((c) => [c.id, c]))
    const isFolded = (c: YarnCard): boolean => {
      const seen = new Set<string>()
      let cur: YarnCard | undefined = c
      while (cur && !seen.has(cur.id)) {
        if (cur.collapsed) return true
        seen.add(cur.id)
        cur = cur.parentCardId ? byId.get(cur.parentCardId) : undefined
      }
      return false
    }
    return new Set(cards.filter((c) => !isFolded(c) && (!hideThreads || revealed.has(c.id))).map((c) => c.id))
  }, [cards, hideThreads, revealed])
  const presence = useThreadPresence(existingIds, epubShownIds, 'default', cardsLoaded)
  // Folded threads whose parents are open (a fold inside a folded thread stays inside it).
  const foldedKnotIds = useMemo(() => {
    const byId = new Map(cards.map((c) => [c.id, c]))
    const out = new Set<string>()
    for (const c of cards) {
      if (!c.collapsed || (hideThreads && !revealed.has(c.id))) continue
      let parent = c.parentCardId ? byId.get(c.parentCardId) : undefined
      const seen = new Set<string>([c.id])
      let hidden = false
      while (parent && !seen.has(parent.id)) {
        if (parent.collapsed) hidden = true
        seen.add(parent.id)
        parent = parent.parentCardId ? byId.get(parent.parentCardId) : undefined
      }
      if (!hidden) out.add(c.id)
    }
    return out
  }, [cards, hideThreads, revealed])

  const goTo = useCallback(
    (cardId: string) => {
      const target = cards.find((c) => c.id === cardId)?.anchors.find((a) => a.cfi)?.cfi
      if (target) void rendition?.display(target)
    },
    [cards, rendition],
  )

  const goToChapter = useCallback(
    (targetChapter: number) => {
      const bk = epubRef.current
      if (!bk || !rendition) return
      const spineItems = (bk.spine as unknown as { items?: { index: number; href: string }[] }).items ?? []
      if (!spineItems.length) return
      const idx = Math.min(Math.max(0, targetChapter - 1), spineItems.length - 1)
      const sec = spineItems[idx]
      if (!sec) return
      setChapter(idx + 1)
      void rendition.display(sec.href)
    },
    [rendition],
  )
  const noop = useCallback(() => undefined, [])
  const onCollapse = useCallback((id: string) => update(id, { collapsed: true }), [update])
  const one = useCallback(() => 1, [])
  const changeFont = (delta: number) => {
    const next = Math.min(180, Math.max(70, fontScale + delta))
    setFontScale(next)
    void setPref('epubFontScale', next)
  }

  return (
    <div className="reader-shell" style={{ ['--card-text' as string]: actions.cardTextScale }}>
      <ReaderTopBar
        title={book.title}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        onOpenJournal={() => setShowJournal((v) => !v)}
        journalOpen={showJournal}
        onBookInfo={() => setShowInfo(true)}
      >
        {chapter > 0 && (
          <div className="page-nav">
            <div className="nav-group" ref={tocBoxRef}>
              {chapterCount > 1 && (
                <button
                  type="button"
                  className="icon-button"
                  title={t.previousChapter}
                  aria-label={t.previousChapter}
                  disabled={chapter <= 1}
                  onClick={() => goToChapter(chapter - 1)}
                >
                  <ChevronLeftIcon size={16} />
                </button>
              )}
              <button
                type="button"
                className="page-number epub-chapter-button"
                aria-haspopup="menu"
                aria-expanded={tocOpen}
                title={t.toc}
                onClick={() => setTocOpen((v) => !v)}
              >
                <span>{chapterTitle(lang, chapter)}</span>
                {(tocItems.length > 0 || chapterCount > 1) && <ChevronDownIcon size={13} />}
              </button>
              {chapterCount > 1 && (
                <button
                  type="button"
                  className="icon-button"
                  title={t.nextChapter}
                  aria-label={t.nextChapter}
                  disabled={chapter >= chapterCount}
                  onClick={() => goToChapter(chapter + 1)}
                >
                  <ChevronRightIcon size={16} />
                </button>
              )}
              {tocOpen && (tocItems.length > 0 || chapterCount > 1) && (
                <div className="popover menu epub-toc-menu" role="menu" aria-label={t.toc}>
                  <p className="menu-heading">{t.toc}</p>
                  {(tocItems.length > 0
                    ? tocItems
                    : Array.from({ length: chapterCount }, (_, i) => ({
                        label: chapterTitle(lang, i + 1),
                        href: '',
                        spineIndex: i + 1,
                      }))
                  ).map((item, idx) => {
                    const isCurrent = item.spineIndex === chapter
                    return (
                      <button
                        key={`${item.href}-${idx}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isCurrent}
                        onClick={() => {
                          setTocOpen(false)
                          if (item.href && rendition) {
                            setChapter(item.spineIndex)
                            void rendition.display(item.href)
                          } else {
                            goToChapter(item.spineIndex)
                          }
                        }}
                      >
                        <span className="menu-check">{isCurrent && <CheckIcon size={14} />}</span>
                        <span className="epub-toc-label">{item.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
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
          {failed ? (
            <p className="reader-message">{t.importFailed}</p>
          ) : (
            <>
              {!rendition && (
                <p className="reader-message epub-loading" role="status">
                  <span className="spinner" aria-hidden="true" /> {t.openingBook}
                </p>
              )}
              <div ref={hostRef} className="epub-host" />
            </>
          )}
        </div>
        <aside ref={laneRef} className="epub-lane" aria-label={t.threads} onPointerDown={onColumnPointerDown} onPointerUp={onColumnPointerUp}>
          {ordered
            .filter(({ card }) => presence.renderedIds.has(card.id) || foldedKnotIds.has(card.id))
            .map(({ card, depth }) =>
              !presence.renderedIds.has(card.id) ? (
                // A folded thread keeps a knot in the lane, so it can always be found and opened again.
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
              <div
                key={card.id}
                className={`epub-card-slot${focused === card.id ? ' is-focused' : ''}`}
                data-state={presence.stateOf.get(card.id) ?? 'open'}
                style={{ marginLeft: depth * 16 }}
              >
                <YarnCardView
                  layout="column"
                  card={card}
                  x={0}
                  y={0}
                  scale={one}
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
                  journal={actions.journalStates.get(card.id)}
                  textScale={actions.cardTextScale}
                  onTextSize={actions.stepCardText}
                  onQuoteClick={goTo}
                  presence={presence.stateOf.get(card.id) ?? 'open'}
                  delayMs={presence.delayOf.get(card.id)}
                />
              </div>
              ),
            )}
        </aside>
        {showJournal && (
          <JournalPanel
            bookId={book.id}
            bookTitle={book.title}
            settings={settings}
            notePage={chapter}
            isEpub
            onGoToPage={goToChapter}
            onOpenSettings={onOpenSettings}
            onClose={() => setShowJournal(false)}
          />
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
      {showInfo && <BookInfoDialog book={book} onClose={() => setShowInfo(false)} />}
      {actions.toast && <div className="toast" role="status">{actions.toast}</div>}
    </div>
  )
}
