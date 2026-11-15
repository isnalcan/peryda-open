import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { db, getPref, newId, setPref, type BookRecord } from '../data/db'
import { closePdf, cropPageRegion, openPdf, pageSizes, textInRect, type PDFDocumentProxy } from '../pdf/pdfjs'
import { useI18n } from '../i18n/I18n'
import type { Lang } from '../i18n/strings'
import type { ByokSettings } from '../ai/provider'
import { kindLabel } from '../ai/compose'
import { GEOMETRY, pageLayout, screenToWorld } from '../ilmek/geometry'
import { useCards } from '../ilmek/useCards'
import { YarnCardView } from '../ilmek/YarnCardView'
import { YarnLayer, type YarnSegment } from '../ilmek/YarnLayer'
import { useRopes } from '../ilmek/rope'
import { SelectionMenu, type ScreenRect } from '../ilmek/SelectionMenu'
import type { NormalizedRect, PageBox, PdfYarnAnchor, Point, YarnCard, YarnColor } from '../ilmek/types'
import { centredContentWidth, clipsFor, contentRect, isShown, pageBand, placeCards, worldRect, yarnSegments, type WorldInput } from '../ilmek/worldLayout'
import { PdfPageView, type PageHighlight, type PageKnot, type Tool } from './PdfPageView'
import { ReaderTopBar } from './ReaderTopBar'
import { anchorsFromSelection, expandToWords, normalizeText, selectionScreenRect, type PageElement } from './selection'
import { constrainToBand, useCamera, type Camera } from './useCamera'
import { EyeIcon, EyeOffIcon, LinkIcon } from '../ui/icons'
import { JournalPanel } from '../journal/JournalPanel'
import { useThreadActions } from '../ilmek/useThreadActions'
import { useThreadMarks } from '../ilmek/threadMarks'
import { CameraBar, PageMenu, PageNav, TiedKnot, ToolSwitcher, TranslateMenu } from './ReaderControls'
import { ExtractTextDialog, TranslateRangeDialog } from './ReaderDialogs'
import { TranslatedPageView } from './TranslatedPageView'
import { RANGE_LIMIT, isUnfinishedTranslation } from '../ilmek/cardsStore'
import { PageTextCache, pageSource, renderPageJpeg, translationPicture } from './pageText'
import { PageReadingsStore } from '../reading/pageReadings'
import { brushCaretAt, lastLineRight } from './brush'
import { useFakeAi } from '../ai/fake'
import { cardText } from './useThreadSelection'
import yarnKinds from '@shared/yarn-kinds.json'

interface Props {
  book: BookRecord
  settings: ByokSettings
  /** Called once, when the first page has been drawn (the book opened safely). */
  onOpened?: (bookId: string) => void
  onBack: () => void
  onOpenSettings: () => void
}

interface Pending {
  anchors: PdfYarnAnchor[]
  rect: ScreenRect
  parentCardId?: string
}

/** How long the reader stays on a translated page before the next page's translation starts. */
/** The first wait before asking Google about a batch job; later waits grow to 30 s. */
const POLL_START_MS = 5000

interface Opened {
  doc: PDFDocumentProxy
  pages: PageBox[]
  camera: Camera | null
  page: number
  paged: boolean
  target: Lang
  /** Translations explain hard terms in brackets (a reader preference, on unless turned off). */
  explainTerms: boolean
}

export function PdfReader({ book, settings, onOpened, onBack, onOpenSettings }: Props) {
  const { t, lang } = useI18n()
  const [opened, setOpened] = useState<Opened | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let doc: PDFDocumentProxy | null = null
    void (async () => {
      try {
        const file = await db.files.get(book.id)
        if (!file) throw new Error('missing file')
        doc = await openPdf(await file.blob.arrayBuffer())
        const sizes = await pageSizes(doc)
        const [saved, paged, target, explainTerms] = await Promise.all([
          db.positions.get(book.id),
          getPref<boolean>('pagedReading', false),
          getPref<Lang | null>(`translateLang:${book.id}`, null),
          getPref<boolean>('explainTerms', true),
        ])
        if (cancelled) return
        setOpened({
          doc,
          pages: pageLayout(sizes.map((s) => [s.width, s.height] as const)),
          camera: saved && saved.scale > 0 ? { x: saved.panX, y: saved.panY, s: saved.scale } : null,
          page: Math.min(Math.max(1, saved?.page ?? 1), doc.numPages),
          paged,
          target: target ?? lang,
          explainTerms,
        })
        void db.books.update(book.id, { openedAt: Date.now() })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      closePdf(doc)
    }
    // The language only sets the first translation target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id])

  if (failed || !opened) {
    return (
      <div className="reader-shell">
        <ReaderTopBar title={book.title} onBack={onBack} onOpenSettings={onOpenSettings} />
        <p className="reader-message">{failed ? t.importFailed : '…'}</p>
      </div>
    )
  }
  return <ReaderSurface book={book} opened={opened} settings={settings} lang={lang} onOpened={onOpened} onBack={onBack} onOpenSettings={onOpenSettings} />
}

interface BrushState {
  startNode: Node
  startOffset: number
  /** Set once the stroke is pulled far enough to the right: the painted text no longer changes. */
  frozen: boolean
  from: Point | null
  pointer: Point
}

const WORD_CHAR = /[\p{L}\p{N}'’-]/u

/** Widens a range so it starts and ends on whole words (inside the text nodes it already touches). */
function snapToWords(range: Range): void {
  const { startContainer: sc, endContainer: ec } = range
  if (sc.nodeType === Node.TEXT_NODE) {
    const text = sc.textContent ?? ''
    let i = range.startOffset
    while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i -= 1
    range.setStart(sc, i)
  }
  if (ec.nodeType === Node.TEXT_NODE) {
    const text = ec.textContent ?? ''
    let j = range.endOffset
    while (j < text.length && WORD_CHAR.test(text[j]!)) j += 1
    range.setEnd(ec, j)
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

interface SurfaceProps {
  book: BookRecord
  opened: Opened
  settings: ByokSettings
  lang: Lang
  onOpened?: (bookId: string) => void
  onBack: () => void
  onOpenSettings: () => void
}

function ReaderSurface({ book, opened, settings, lang, onOpened, onBack, onOpenSettings }: SurfaceProps) {
  const { t } = useI18n()
  const { doc, pages } = opened
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 1200, height: 800 })
  const constrainRef = useRef<((c: Camera) => Camera) | null>(null)
  const { camera, cameraRef, settledScale, setCamera, panBy: rawPanBy, zoomAround: rawZoomAround } = useCamera(opened.camera ?? { x: 24, y: 24, s: 1 }, constrainRef)
  // Until the reader moves the camera, a new book is re-fitted whenever the window resizes.
  const cameraReady = useRef(Boolean(opened.camera))
  const animation = useRef(0)
  const panBy = useCallback(
    (dx: number, dy: number) => {
      cameraReady.current = true
      cancelAnimationFrame(animation.current)
      rawPanBy(dx, dy)
    },
    [rawPanBy],
  )
  const zoomAround = useCallback(
    (cursor: Point, s: number) => {
      cameraReady.current = true
      cancelAnimationFrame(animation.current)
      rawZoomAround(cursor, s)
    },
    [rawZoomAround],
  )
  /** Moves the camera smoothly (or at once with reduced motion); any input from the reader stops it. */
  const animateCamera = useCallback(
    (target: Camera) => {
      cameraReady.current = true
      cancelAnimationFrame(animation.current)
      const start = cameraRef.current
      if (prefersReducedMotion()) {
        setCamera(target)
        return
      }
      const began = performance.now()
      const step = (now: number) => {
        const k = Math.min(1, (now - began) / 260)
        const e = 1 - (1 - k) ** 3
        setCamera({ x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e, s: start.s + (target.s - start.s) * e })
        if (k < 1) animation.current = requestAnimationFrame(step)
      }
      animation.current = requestAnimationFrame(step)
    },
    [cameraRef, setCamera],
  )
  useEffect(() => () => cancelAnimationFrame(animation.current), [])

  const [tool, setTool] = useState<Tool>('select')
  const [pending, setPending] = useState<Pending | null>(null)
  const [bridgeHeld, setBridgeHeld] = useState<PdfYarnAnchor[] | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [hideThreads, setHideThreads] = useState(false)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedCard, setFocusedCard] = useState<string | null>(null)
  const [showJournal, setShowJournal] = useState(false)
  const [offscreenCard, setOffscreenCard] = useState<string | null>(null)
  const [brushColor, setBrushColor] = useState<YarnColor>('mint')
  const [brush, setBrush] = useState<BrushState | null>(null)
  const [pagedReading, setPagedReading] = useState(opened.paged)
  const [pagedPage, setPagedPage] = useState(opened.page)
  const [shortQuotes, setShortQuotes] = useState<ReadonlySet<string>>(() => new Set())
  const [translationTarget, setTranslationTarget] = useState<Lang>(opened.target)
  const [explainTerms, setExplainTerms] = useState(opened.explainTerms)
  const [askingRange, setAskingRange] = useState(false)
  const [extractingPage, setExtractingPage] = useState<number | null>(null)
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number; page: number } | null>(null)
  const [showTranslationFor, setShowTranslationFor] = useState<number | null>(null)
  const brushRange = useRef<Range | null>(null)
  const pageElements = useRef(new Map<number, { element: HTMLElement; textLayer: HTMLElement | null }>())
  const pageTexts = useMemo(() => new PageTextCache(doc), [doc])
  // Pages read with Pery in "Extract page text", kept with the book; a batch job still lands while it is open.
  const fake = useFakeAi()
  const readings = useMemo(
    () => new PageReadingsStore({ bookId: book.id, bookTitle: book.title, pageCount: doc.numPages, settings, fake, picture: async (p) => renderPageJpeg(await doc.getPage(p), 2, 0.88) }),
    // Settings follow below; a new store only for another book or document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book.id, doc, fake],
  )
  useEffect(() => {
    readings.open()
    return () => readings.close()
  }, [readings])
  useEffect(() => {
    readings.settings = settings
  }, [readings, settings])
  const { store, cards, create, ask, retry, stop, remove, update, resize } = useCards({ bookId: book.id, bookTitle: book.title, lang, settings })
  store.pageCount = pages.length
  store.explainTerms = explainTerms
  // Scanned pages' pictures are drawn when their translation is sent, not kept beforehand (WW-5).
  store.pagePicture = useCallback((page: number) => translationPicture(doc, page), [doc])
  const actions = useThreadActions({ bookId: book.id, cards, t })
  // Passages threads were opened from inside cards and translated pages, marked in their colours.
  useThreadMarks(worldRef, cards)

  // ---- Where the reader is ----
  const scrollPage = useMemo(() => {
    const centerY = (viewport.height / 2 - camera.y) / camera.s
    const i = pages.findIndex((p) => p.y + p.height >= centerY)
    return i === -1 ? pages.length : i + 1
  }, [camera.y, camera.s, viewport.height, pages])
  const currentPage = pagedReading ? pagedPage : scrollPage

  // ---- Layout: cards, translations, yarns, knots ----
  const layoutInput: WorldInput = useMemo(
    () => ({ cards, pages, heights, pagedReading, currentPage: 1, hideThreads: false, revealed: new Set<string>() }),
    [cards, pages, heights, pagedReading],
  )
  const placements = useMemo(() => placeCards(layoutInput), [layoutInput])
  const shownInput: WorldInput = useMemo(
    () => ({ ...layoutInput, currentPage, hideThreads, revealed }),
    [layoutInput, currentPage, hideThreads, revealed],
  )
  // Which cards are on screen now (worked out once per change, not per card per frame).
  const shownIds = useMemo(() => new Set(cards.filter((c) => isShown(c, shownInput)).map((c) => c.id)), [cards, shownInput])
  const content = useMemo(() => contentRect(layoutInput, placements), [layoutInput, placements])
  const world = worldRect(content)

  // A dragged card's live position, so its yarns (and knots) follow it before it is pinned.
  const [liveDrag, setLiveDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const onDragLive = useCallback((id: string, at: { x: number; y: number } | null) => setLiveDrag(at ? { id, ...at } : null), [])
  const livePlacements = useMemo(() => {
    if (!liveDrag) return placements
    const next = new Map(placements)
    next.set(liveDrag.id, { x: liveDrag.x, y: liveDrag.y })
    return next
  }, [placements, liveDrag])
  const segments = useMemo(() => yarnSegments(shownInput, livePlacements), [shownInput, livePlacements])
  const clips = useMemo(() => clipsFor(shownInput, livePlacements, lang), [shownInput, livePlacements, lang])
  const heldYarns = useMemo(
    () => new Set(liveDrag ? segments.filter((s) => s.cardId === liveDrag.id || s.sourceCardId === liveDrag.id).map((s) => s.key) : []),
    [segments, liveDrag],
  )
  const ropeBends = useRopes(segments, heldYarns)

  const { highlightsByPage, knotsByPage } = useMemo(() => {
    const highlights = new Map<number, PageHighlight[]>()
    const knots = new Map<number, PageKnot[]>()
    const add = <T,>(map: Map<number, T[]>, page: number, item: T) => {
      const list = map.get(page) ?? []
      list.push(item)
      map.set(page, list)
    }
    for (const card of cards) {
      if (card.translatedPage !== undefined) continue
      for (const a of card.anchors) {
        if (a.sourceType === 'card' || !a.lineRects.length) continue
        add(highlights, a.pageNumber, { key: `${card.id}-${a.id}`, cardId: card.id, color: card.color, area: a.sourceType === 'pdf_area', rects: a.lineRects })
      }
      if (card.collapsed) {
        const first = card.anchors.find((a) => a.sourceType !== 'card')
        const label = card.kind === 'question' || card.kind === 'bridge' || card.kind === 'translate' ? '⁂' : kindLabel(lang, card.kind)
        if (first) add(knots, first.pageNumber, { cardId: card.id, color: card.color, label, rect: first.boundingRect })
      }
    }
    // The reader's own highlights first, under the threads' marks.
    for (const entry of actions.highlightMarks) {
      for (const [i, m] of (entry.marks ?? []).entries()) {
        const list = highlights.get(m.pageNumber) ?? []
        list.unshift({ key: `hl-${entry.id}-${i}`, cardId: '', color: 'amber', area: false, rects: m.lineRects, highlighter: true })
        highlights.set(m.pageNumber, list)
      }
    }
    for (const a of [...(pending?.anchors ?? []), ...(bridgeHeld ?? [])]) {
      if (a.sourceType === 'card' || !a.lineRects.length) continue
      add(highlights, a.pageNumber, { key: `pending-${a.id}`, cardId: '', color: 'mint', area: a.sourceType === 'pdf_area', rects: a.lineRects })
    }
    return { highlightsByPage: highlights, knotsByPage: knots }
  }, [cards, pending, bridgeHeld, lang, actions.highlightMarks])

  // In page-by-page reading the view keeps to the current page and its threads.
  const bandFor = useCallback(
    (page: number) => (pagedReading ? pageBand({ ...shownInput, currentPage: page }, placements, page) : null),
    [pagedReading, shownInput, placements],
  )
  const constrainFor = useCallback(
    (band: { top: number; bottom: number } | null) => (band ? (c: Camera): Camera => constrainToBand(c, band, viewport.height) : null),
    [viewport.height],
  )
  constrainRef.current = constrainFor(bandFor(currentPage))

  // ---- Viewport, saved position ----
  const overviewCamera = useCallback(
    (width: number, height: number): Camera => {
      const s = Math.min(1, Math.max(0.15, (width - 48) / centredContentWidth(content)))
      return { x: width / 2 - (GEOMETRY.pageWorldWidth / 2) * s, y: 24, s }
    },
    [content],
  )
  const overviewRef = useRef(overviewCamera)
  overviewRef.current = overviewCamera

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setViewport({ width: r.width, height: r.height })
      if (!cameraReady.current && r.width > 0) setCamera(overviewRef.current(r.width, r.height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [setCamera])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void db.positions.put({ bookId: book.id, panX: camera.x, panY: camera.y, scale: camera.s, page: currentPage, updatedAt: Date.now() })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [camera, currentPage, book.id])

  // ---- Pages ----
  const fadePage = () => {
    if (prefersReducedMotion()) return
    worldRef.current?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
  }

  const goToPage = useCallback(
    (n: number) => {
      const page = Math.min(Math.max(1, n), pages.length)
      const box = pages[page - 1]
      if (!box) return
      const c = cameraRef.current
      if (pagedReading) {
        if (page !== pagedPage) fadePage()
        setPagedPage(page)
        const band = bandFor(page)
        constrainRef.current = constrainFor(band)
        cameraReady.current = true
        cancelAnimationFrame(animation.current)
        setCamera({ ...c, y: 24 - (band?.top ?? box.y) * c.s })
      } else {
        animateCamera({ ...c, y: 24 - box.y * c.s })
      }
    },
    [pages, pagedReading, pagedPage, bandFor, constrainFor, cameraRef, setCamera, animateCamera],
  )
  const turnPage = useCallback((delta: number) => goToPage(currentPage + delta), [goToPage, currentPage])

  const switchPaged = (paged: boolean) => {
    if (paged === pagedReading) return
    void setPref('pagedReading', paged)
    if (paged) {
      setPagedPage(scrollPage)
      setPagedReading(true)
      const band = pageBand({ ...shownInput, pagedReading: true, currentPage: scrollPage }, placeCards({ ...layoutInput, pagedReading: true }), scrollPage)
      constrainRef.current = constrainFor(band)
      const c = cameraRef.current
      if (band) setCamera({ ...c, y: 24 - band.top * c.s })
    } else {
      constrainRef.current = null
      setPagedReading(false)
    }
    fadePage()
  }

  // ---- Camera presets (only on click) ----
  const fit = (width: number, maxScale: number) => {
    const c = cameraRef.current
    const s = Math.min(maxScale, Math.max(0.15, (viewport.width - 48) / width))
    const cy = (viewport.height / 2 - c.y) / c.s
    animateCamera({ x: viewport.width / 2 - (GEOMETRY.pageWorldWidth / 2) * s, y: viewport.height / 2 - cy * s, s })
  }
  const presetFocus = () => fit(GEOMETRY.pageWorldWidth + 48, 2.5)
  const presetMap = () => fit(centredContentWidth(content), 0.45)
  const zoomCenter = (s: number) => zoomAround([viewport.width / 2, viewport.height / 2], s)

  /** A page and its translation side by side. */
  const showTranslation = useCallback(
    (page: number) => {
      const box = pages[page - 1]
      if (!box) return
      const card = store.pageTranslation(page, translationTarget)
      const p = card ? placements.get(card.id) : undefined
      const right = p && card ? p.x + card.width : box.x + box.width * 2 + 60
      const width = right - box.x + 80
      const s = Math.min(1.2, Math.max(0.15, (viewport.width - 48) / width))
      animateCamera({ x: viewport.width / 2 - ((box.x + right) / 2) * s, y: 24 - box.y * s, s })
    },
    [pages, store, translationTarget, placements, viewport.width, animateCamera],
  )

  // ---- Whole-page translation ----
  const preparing = useRef(new Set<number>())
  const [preparingCount, setPreparingCount] = useState(0)
  /** Bumped by "Stop translating": pages being prepared are dropped. */
  const translateGeneration = useRef(0)
  const pollTimer = useRef<number | null>(null)
  const ensurePolling = useCallback(() => {
    if (pollTimer.current !== null) return
    const pendingWork = () => preparing.current.size > 0 || store.hasPendingTranslation
    if (!pendingWork()) return
    let wait = POLL_START_MS
    const tick = async () => {
      if (!pendingWork()) {
        pollTimer.current = null
        return
      }
      await store.pollBatches()
      wait = Math.min(30_000, wait * 1.25)
      pollTimer.current = window.setTimeout(() => void tick(), wait)
    }
    pollTimer.current = window.setTimeout(() => void tick(), wait)
  }, [store])
  useEffect(() => {
    if (store.loaded) ensurePolling()
  }, [cards, store, ensurePolling])
  useEffect(
    () => () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current)
    },
    [],
  )

  /** Sends the pages that have no translation in `target` yet. */
  const translate = useCallback(
    async (numbers: number[], target: Lang) => {
      const wanted = [...new Set(numbers)].filter((n) => n >= 1 && n <= pages.length && !store.pageTranslation(n, target) && !preparing.current.has(n))
      if (!wanted.length) return false
      const generation = translateGeneration.current
      for (const n of wanted) preparing.current.add(n)
      setPreparingCount(preparing.current.size)
      const sources = []
      for (const n of wanted) {
        // The reader pressed "Stop translating" while the pages were being read: send nothing.
        if (generation !== translateGeneration.current) return false
        const source = await pageSource(doc, n, pages[n - 1]!).catch(() => null)
        if (source) sources.push(source)
      }
      for (const n of wanted) preparing.current.delete(n)
      setPreparingCount(preparing.current.size)
      if (generation !== translateGeneration.current) return false
      store.translatePages(sources, target)
      ensurePolling()
      return true
    },
    [doc, pages, store, ensurePolling],
  )

  /** Translates a page again; a scanned page's picture is drawn again by the store when it is sent. */
  const retranslate = useCallback((cardId: string) => store.retranslate(cardId), [store])

  /**
   * "Translate this page": only this page. Nothing is translated without the reader asking: more
   * pages only through "Translate pages…" (owner's decision, 14 Nov).
   */
  const startTranslating = (page = currentPage, target = translationTarget) => {
    if (target !== translationTarget) {
      setTranslationTarget(target)
      void setPref(`translateLang:${book.id}`, target)
    }
    setShowTranslationFor(page)
    void translate([page], target)
  }
  const translateRange = (from: number, to: number) => {
    const lower = Math.max(1, from)
    const upper = Math.min(pages.length, to, lower + RANGE_LIMIT - 1)
    if (lower > upper) return
    setShowTranslationFor(lower)
    void translate(Array.from({ length: upper - lower + 1 }, (_, i) => lower + i), translationTarget)
  }
  /** Pages still on their way: being prepared, waiting their turn, streaming in or in a batch job. */
  const pendingTranslations = useMemo(() => cards.filter(isUnfinishedTranslation).length + preparingCount, [cards, preparingCount])

  /** Stops every page translation still on its way; pages already translated stay. */
  const stopTranslating = () => {
    translateGeneration.current += 1
    const preparingNow = preparing.current.size
    preparing.current.clear()
    setPreparingCount(0)
    const stopped = store.stopTranslations() + preparingNow
    if (stopped) actions.showToast(t.translationsStopped(stopped))
  }

  // Once the translation is placed, show it beside its page.
  useEffect(() => {
    if (showTranslationFor === null) return
    const card = store.pageTranslation(showTranslationFor, translationTarget)
    if (card && placements.has(card.id)) {
      showTranslation(showTranslationFor)
      setShowTranslationFor(null)
    }
  }, [showTranslationFor, placements, store, translationTarget, showTranslation])

  // ---- Wheel, pinch and keys ----
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const target = e.target instanceof Element ? e.target : el
      if (target.closest('.journal-panel, .selection-menu, .popover')) return
      const scroller = target.closest<HTMLElement>('.yarn-card-middle, .translated-page-text')
      if (scroller && scroller.scrollHeight > scroller.clientHeight && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewport.height : 1
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * unit * 0.0025)
        zoomAround([e.clientX - r.left, e.clientY - r.top], cameraRef.current.s * factor)
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        panBy(-dx * unit, -dy * unit)
      }
    }
    let gestureStart = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureStart = cameraRef.current.s
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      const r = el.getBoundingClientRect()
      zoomAround([g.clientX - r.left, g.clientY - r.top], gestureStart * g.scale)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
    }
  }, [panBy, zoomAround, cameraRef, viewport.height])

  // Arrows, Page Up/Down and space read; + / − / 0 zoom. Page by page, left/right and Page Up/Down turn pages.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('textarea, input, select, dialog, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      const center: Point = [viewport.width / 2, viewport.height / 2]
      const step = 60
      const pageStep = viewport.height * 0.85
      if (pagedReading && ['ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', ' '].includes(e.key)) {
        turnPage(e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey) ? -1 : 1)
        e.preventDefault()
        return
      }
      switch (e.key) {
        case 'ArrowDown':
          panBy(0, -step)
          break
        case 'ArrowUp':
          panBy(0, step)
          break
        case 'ArrowLeft':
          panBy(step, 0)
          break
        case 'ArrowRight':
          panBy(-step, 0)
          break
        case 'PageDown':
        case ' ':
          panBy(0, e.shiftKey ? pageStep : -pageStep)
          break
        case 'PageUp':
          panBy(0, pageStep)
          break
        case '+':
        case '=':
          zoomAround(center, cameraRef.current.s * 1.2)
          break
        case '-':
          zoomAround(center, cameraRef.current.s / 1.2)
          break
        case '0':
          zoomAround(center, 1)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panBy, zoomAround, cameraRef, viewport, pagedReading, turnPage])

  // ---- Pointer: panning, brush ----
  const panDrag = useRef<{ x: number; y: number } | null>(null)
  const toWorld = (clientX: number, clientY: number): Point => {
    const host = viewportRef.current!.getBoundingClientRect()
    const c = cameraRef.current
    return screenToWorld([clientX - host.left, clientY - host.top], [c.x, c.y], c.s)
  }

  const onViewportPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (!target.closest('.selection-menu')) setPending((p) => (p ? null : p))
    const brushLayer = tool === 'brush' && e.button === 0 ? target.closest('.pdf-page .textLayer') : null
    if (brushLayer) {
      // With the brush, the page never falls back to the browser's own text selection.
      e.preventDefault()
      const caret = brushCaretAt(e.clientX, e.clientY, brushLayer, true)
      if (caret) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* synthetic or already released pointer */
        }
        window.getSelection()?.removeAllRanges()
        brushRange.current = null
        setBrush({ startNode: caret.node, startOffset: caret.offset, frozen: false, from: null, pointer: toWorld(e.clientX, e.clientY) })
        return
      }
    }
    const onEmpty = target === viewportRef.current || target === worldRef.current || target.classList.contains('yarn-layer')
    if (e.button === 1 || (e.button === 0 && onEmpty)) {
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic or already released pointer */
      }
      panDrag.current = { x: e.clientX, y: e.clientY }
    }
  }
  const onViewportPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (brush) {
      const pointer = toWorld(e.clientX, e.clientY)
      if (brush.frozen) {
        setBrush({ ...brush, pointer })
        return
      }
      // Paint only while the pointer is over text of the same page; pulling far enough right makes a thread.
      const selection = window.getSelection()
      const layer = (brush.startNode.parentElement ?? null)?.closest('.textLayer')
      const caret = layer ? brushCaretAt(e.clientX, e.clientY, layer) : null
      if (caret && selection) {
        const range = document.createRange()
        range.setStart(brush.startNode, brush.startOffset)
        range.setEnd(brush.startNode, brush.startOffset)
        if (range.comparePoint(caret.node, caret.offset) >= 0) range.setEnd(caret.node, caret.offset)
        else range.setStart(caret.node, caret.offset)
        snapToWords(range)
        brushRange.current = range
        selection.removeAllRanges()
        selection.addRange(range)
      }
      const painted = brushRange.current
      if (painted && !painted.collapsed) {
        const rects = [...painted.getClientRects()].filter((r) => r.width > 0)
        const right = lastLineRight(rects)
        const last = rects.reduce((a, r) => (r.bottom > a.bottom ? r : a), rects[0]!)
        if (right !== null && e.clientX - right >= GEOMETRY.brushPullThreshold) {
          selection?.removeAllRanges()
          selection?.addRange(painted)
          setBrush({ ...brush, frozen: true, from: toWorld(right, last.top + last.height / 2), pointer })
          return
        }
      }
      setBrush({ ...brush, pointer })
      return
    }
    const d = panDrag.current
    if (!d) return
    panBy(e.clientX - d.x, e.clientY - d.y)
    panDrag.current = { x: e.clientX, y: e.clientY }
  }
  const onViewportPointerUp = () => {
    if (brush) {
      const pulled = brush.frozen
      setBrush(null)
      if (pulled) {
        const selection = window.getSelection()
        const anchors = selection ? anchorsFromSelection(selection, pageList(), book.id) : []
        selection?.removeAllRanges()
        if (anchors.length) void createWith({ color: brushColor, kind: brushColor, anchors })
        return
      }
      window.setTimeout(readSelection, 0)
      return
    }
    if (panDrag.current) {
      panDrag.current = null
      return
    }
    window.setTimeout(readSelection, 0)
  }

  const registerPage = useCallback((pageNumber: number, element: HTMLElement | null, textLayer: HTMLElement | null) => {
    if (element) pageElements.current.set(pageNumber, { element, textLayer })
    else pageElements.current.delete(pageNumber)
  }, [])
  const pageList = (): PageElement[] => [...pageElements.current.entries()].map(([pageNumber, v]) => ({ pageNumber, ...v }))

  const cardContext = useCallback((cardId: string) => cardText(store.cards, cardId), [store])

  const readSelection = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const rect = selectionScreenRect(selection)
    const host = viewportRef.current?.getBoundingClientRect()
    if (!rect || !host) return
    const screenRect = { left: rect.left - host.left, top: rect.top - host.top, right: rect.right - host.left, bottom: rect.bottom - host.top }

    // A selection inside a card (answer, question, note) or a translated page opens a thread from that card.
    const start = selection.getRangeAt(0).startContainer
    const startEl = start.nodeType === Node.ELEMENT_NODE ? (start as HTMLElement) : start.parentElement
    const source = startEl?.closest<HTMLElement>('[data-thread-source]')
    if (source) {
      const cardId = source.dataset.threadSource
      const cardEl = source.closest<HTMLElement>('[data-card-id]')
      const text = normalizeText(selection.toString())
      if (!cardId || !cardEl || !text) return
      const c = cardEl.getBoundingClientRect()
      const s = cameraRef.current.s
      const box: NormalizedRect = { x: (rect.left - c.left) / s, y: (rect.top - c.top) / s, width: (rect.right - rect.left) / s, height: (rect.bottom - rect.top) / s }
      const anchor: PdfYarnAnchor = {
        id: newId(),
        sourceType: 'card',
        bookId: book.id,
        pageNumber: 0,
        selectedText: text,
        lineRects: [],
        boundingRect: box,
        sourceCardId: cardId,
        context: cardContext(cardId),
      }
      setPending({ anchors: [anchor], rect: screenRect, parentCardId: cardId })
      return
    }

    const anchors = anchorsFromSelection(selection, pageList(), book.id)
    for (const a of anchors) void pageTexts.text(a.pageNumber)
    if (anchors.length) setPending({ anchors, rect: screenRect })
  }, [book.id, cameraRef, cardContext, pageTexts])

  // Keyboard selections (shift + arrows) also open the menu.
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key.startsWith('Arrow')) readSelection()
    }
    window.addEventListener('keyup', onKeyUp)
    return () => window.removeEventListener('keyup', onKeyUp)
  }, [readSelection])

  const onAreaSelected = useCallback(
    async (pageNumber: number, rect: NormalizedRect) => {
      const page = await doc.getPage(pageNumber)
      const [image, text] = await Promise.all([cropPageRegion(page, rect, GEOMETRY.pageWorldWidth), textInRect(page, rect)])
      const el = pageElements.current.get(pageNumber)?.element
      const host = viewportRef.current?.getBoundingClientRect()
      if (!el || !host) return
      const p = el.getBoundingClientRect()
      const screenRect = {
        left: p.left + rect.x * p.width - host.left,
        top: p.top + rect.y * p.height - host.top,
        right: p.left + (rect.x + rect.width) * p.width - host.left,
        bottom: p.top + (rect.y + rect.height) * p.height - host.top,
      }
      void pageTexts.text(pageNumber)
      const anchor: PdfYarnAnchor = {
        id: newId(),
        sourceType: 'pdf_area',
        bookId: book.id,
        pageNumber,
        selectedText: text,
        lineRects: [rect],
        boundingRect: rect,
        croppedImage: image || undefined,
      }
      setPending({ anchors: [anchor], rect: screenRect })
    },
    [doc, book.id, pageTexts],
  )

  const finish = () => {
    setPending(null)
    window.getSelection()?.removeAllRanges()
  }

  /** Creates a thread once its passages carry the text around them; then brings it forward. */
  const createWith = async (input: Parameters<typeof create>[0]) => {
    const anchors = await Promise.all(
      input.anchors.map(async (a) => (a.sourceType === 'card' || a.context ? a : { ...a, context: await pageTexts.context(a.pageNumber) })),
    )
    const card = create({ ...input, anchors })
    setFocusedCard(card.id)
    setOffscreenCard(card.id)
    if (hideThreads) setRevealed((r) => new Set(r).add(card.id))
  }

  const createFromPending = (color: YarnColor, kind: YarnCard['kind'], text?: string) => {
    if (!pending) return
    void createWith({ color, kind, anchors: pending.anchors, parentCardId: pending.parentCardId, text })
    finish()
  }

  const onClip = async () => {
    if (!pending) return
    const anchors = pending.anchors
    finish()
    await actions.clip(anchors)
  }

  const onHighlight = async () => {
    if (!pending) return
    // A highlight covers whole words: the live selection is widened to word boundaries first.
    let anchors = pending.anchors
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0)
      const layer = pageList().find((pg) => pg.textLayer?.contains(range.startContainer))?.textLayer
      const widened = expandToWords(range, layer ?? range.commonAncestorContainer)
      selection.removeAllRanges()
      selection.addRange(widened)
      const whole = anchorsFromSelection(selection, pageList(), book.id)
      if (whole.length) anchors = whole
    }
    finish()
    await actions.highlight(anchors)
  }

  // ---- Card callbacks (stable, so cards re-render only when their own data changes) ----
  const onHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (Math.abs((prev[id] ?? 0) - h) < 0.5 ? prev : { ...prev, [id]: h }))
  }, [])
  const onHighlightClick = useCallback(
    (cardId: string) => {
      if (!cardId) return
      const card = store.cards.find((c) => c.id === cardId)
      if (card?.collapsed) update(cardId, { collapsed: false })
      // With threads hidden, a highlight brings back just its own card.
      setRevealed((r) => (r.has(cardId) ? r : new Set(r).add(cardId)))
      setFocusedCard(cardId)
    },
    [store, update],
  )
  const onMove = useCallback((id: string, x: number, y: number) => update(id, { isPinned: true, x, y }), [update])
  const onUnpin = useCallback((id: string) => update(id, { isPinned: false }), [update])
  const onCollapse = useCallback((id: string) => update(id, { collapsed: true }), [update])
  const onToggleQuote = useCallback((id: string) => {
    setShortQuotes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const scaleOf = useCallback(() => cameraRef.current.s, [cameraRef])
  const noop = useCallback(() => undefined, [])
  // The first page drawn means the book opened safely (see App's safe start).
  const drawnOnce = useRef(false)
  const onPageDrawn = useCallback(() => {
    if (drawnOnce.current) return
    drawnOnce.current = true
    onOpened?.(book.id)
  }, [onOpened, book.id])

  // A new thread that opened outside the view gets a small notice; the camera moves only if it is used.
  useEffect(() => {
    if (!offscreenCard) return
    const p = placements.get(offscreenCard)
    if (!p) return
    const card = cards.find((c) => c.id === offscreenCard)
    const w = (card?.width ?? GEOMETRY.cardWidth) * camera.s
    const sx = p.x * camera.s + camera.x
    const sy = p.y * camera.s + camera.y
    const visibleWidth = Math.min(sx + w, viewport.width) - Math.max(sx, 0)
    const inView = visibleWidth > w * 0.6 && sy < viewport.height - 40 && sy + 80 * camera.s > 0
    if (inView) {
      setOffscreenCard(null)
      return
    }
    const timer = window.setTimeout(() => setOffscreenCard(null), 8000)
    return () => window.clearTimeout(timer)
  }, [offscreenCard, placements, camera, viewport, cards])

  const showCard = (cardId: string) => {
    const p = placements.get(cardId)
    if (!p) return
    const card = cards.find((c) => c.id === cardId)
    const s = cameraRef.current.s
    animateCamera({ x: viewport.width / 2 - (p.x + (card?.width ?? GEOMETRY.cardWidth) / 2) * s, y: 40 - p.y * s, s })
    setOffscreenCard(null)
  }

  // Right-click on a page: translate it, or show its text (a selection keeps the browser's own menu).
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const pageEl = (e.target as HTMLElement).closest<HTMLElement>('.pdf-page')
    const selection = window.getSelection()
    if (!pageEl || (selection && !selection.isCollapsed)) return
    const page = Number(pageEl.dataset.page)
    const host = viewportRef.current?.getBoundingClientRect()
    if (!page || !host) return
    e.preventDefault()
    setPageMenu({ x: e.clientX - host.left, y: e.clientY - host.top, page })
  }

  // ---- Visible pages ----
  const visibleRange = useMemo(() => {
    if (pagedReading) return { first: currentPage - 1, last: currentPage - 1 }
    const top = -camera.y / camera.s
    const bottom = top + viewport.height / camera.s
    const margin = viewport.height / camera.s
    const first = pages.findIndex((p) => p.y + p.height >= top - margin)
    let last = first
    while (last + 1 < pages.length && pages[last + 1]!.y <= bottom + margin) last += 1
    return { first: Math.max(0, first), last: Math.max(0, last) }
  }, [camera.y, camera.s, viewport.height, pages, pagedReading, currentPage])

  const liveSegments: YarnSegment[] =
    brush?.frozen && brush.from ? [...segments, { key: 'brush-live', color: brushColor, from: brush.from, to: brush.pointer, dashed: true }] : segments

  return (
    <div className="reader-shell" style={{ ['--card-text' as string]: actions.cardTextScale }}>
      <ReaderTopBar
        title={book.title}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        onOpenJournal={() => setShowJournal((v) => !v)}
        journalOpen={showJournal}
        leading={<ToolSwitcher tool={tool} onTool={setTool} brushColor={brushColor} onBrushColor={setBrushColor} />}
      >
        <PageNav
          page={currentPage}
          pages={pages.length}
          paged={pagedReading}
          onPaged={switchPaged}
          onPrevious={() => turnPage(-1)}
          onNext={() => turnPage(1)}
          onGoTo={goToPage}
        />
        <TranslateMenu
          target={translationTarget}
          pending={pendingTranslations}
          onStop={stopTranslating}
          onTranslate={(target) => startTranslating(currentPage, target ?? translationTarget)}
          explainTerms={explainTerms}
          onExplainTerms={(on) => {
            setExplainTerms(on)
            void setPref('explainTerms', on)
          }}
          onRange={() => setAskingRange(true)}
          onExtract={() => setExtractingPage(currentPage)}
        />
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
          <LinkIcon size={15} /> {t.bridgeHeld}
          <button type="button" className="text-button" onClick={() => setBridgeHeld(null)}>{t.cancel}</button>
        </div>
      )}
      <div className="reader-main">
        <div
          ref={viewportRef}
          className={`reader-viewport tool-${tool}`}
          onPointerDown={onViewportPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={onViewportPointerUp}
          onContextMenu={onContextMenu}
          onScroll={(e) => {
            // The surface never scrolls natively (focus changes cannot move it).
            e.currentTarget.scrollTop = 0
            e.currentTarget.scrollLeft = 0
          }}
        >
          <div
            ref={worldRef}
            className="reader-world"
            style={{ width: world.x + world.width, height: world.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.s})` }}
          >
            {pages.map((box, i) =>
              i >= visibleRange.first && i <= visibleRange.last ? (
                <PdfPageView
                  key={i + 1}
                  doc={doc}
                  pageNumber={i + 1}
                  box={box}
                  renderScale={settledScale}
                  highlights={highlightsByPage.get(i + 1) ?? EMPTY}
                  knots={knotsByPage.get(i + 1) ?? EMPTY}
                  tool={tool}
                  register={registerPage}
                  onAreaSelected={onAreaSelected}
                  onHighlightClick={onHighlightClick}
                  onTextless={noop}
                  onDrawn={onPageDrawn}
                />
              ) : pagedReading ? null : (
                <div key={i + 1} className="pdf-page is-placeholder" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }} />
              ),
            )}
            <YarnLayer segments={liveSegments} bends={ropeBends} x={world.x} width={world.width} height={world.height} />
            {brush?.frozen && (
              <div
                className="ghost-card"
                data-yarn={brushColor}
                style={{ transform: `translate(${brush.pointer[0]}px, ${brush.pointer[1] - GEOMETRY.cardAttachY}px)`, width: GEOMETRY.cardWidth }}
                aria-hidden="true"
              >
                <span className="yarn-dot" /> {yarnKinds.kinds[brushColor].cardTitle[lang]}
              </div>
            )}
            {cards.map((card) => {
              const p = placements.get(card.id)
              if (!p || !shownIds.has(card.id)) return null
              if (card.translatedPage !== undefined) {
                return (
                  <div key={card.id} className="yarn-card-slot" style={{ zIndex: 1 }}>
                    <TranslatedPageView
                      card={card}
                      x={p.x}
                      y={p.y}
                      onHeight={onHeight}
                      onRetranslate={retranslate}
                      onTranslateNow={store.translateNow}
                      inBatch={store.isWaitingForBatch(card.id)}
                      onRemove={remove}
                      onOpenSettings={onOpenSettings}
                      textScale={actions.translationTextScale}
                      onTextScale={actions.stepTranslationText}
                    />
                  </div>
                )
              }
              return (
                <div key={card.id} className="yarn-card-slot" style={{ zIndex: focusedCard === card.id ? 3 : 2 }}>
                  <YarnCardView
                    card={card}
                    x={p.x}
                    y={p.y}
                    scale={scaleOf}
                    shortQuote={shortQuotes.has(card.id)}
                    onToggleQuote={onToggleQuote}
                    onHeight={onHeight}
                    onAsk={ask}
                    onRetry={retry}
                    onStop={stop}
                    onRemove={remove}
                    onMove={onMove}
                    onDragLive={onDragLive}
                    onResize={resize}
                    onUnpin={onUnpin}
                    onCollapse={onCollapse}
                    onOpenSettings={onOpenSettings}
                    onFocusCard={setFocusedCard}
                    onSaveToJournal={actions.saveToJournal}
                    journal={actions.journalStates.get(card.id)}
                    textScale={actions.cardTextScale}
                    onTextSize={actions.stepCardText}
                  />
                </div>
              )
            })}
            {clips.map((clip) => (
              <TiedKnot
                key={clip.cardId}
                color={clip.color}
                right={clip.right}
                title={clip.title}
                x={clip.point[0]}
                y={clip.point[1]}
                onOpen={() => onHighlightClick(clip.cardId)}
              />
            ))}
          </div>

          {pending && (
            <SelectionMenu
              anchorRect={pending.rect}
              bounds={viewport}
              bridgeHeld={Boolean(bridgeHeld) && !pending.parentCardId}
              canClip={!pending.parentCardId}
              canBridge={!pending.parentCardId}
              onQuick={(color) => createFromPending(color, color)}
              onAsk={(text) => createFromPending('mint', 'question', text)}
              onNote={(text) => createFromPending('cream', 'cream', text)}
              onBridge={() => {
                setBridgeHeld(pending.anchors)
                finish()
              }}
              onBridgeCompare={() => {
                if (!bridgeHeld) return
                void createWith({ color: 'sky', kind: 'bridge', anchors: [...bridgeHeld, ...pending.anchors] })
                setBridgeHeld(null)
                finish()
              }}
              onClip={() => void onClip()}
              // A highlight is for text on the PDF page only (not a page area, nor text in a card or translation).
              canHighlight={!pending.parentCardId && pending.anchors.every((a) => a.sourceType === 'pdf_text')}
              onHighlight={() => void onHighlight()}
              onTranslate={() => createFromPending('sky', 'translate')}
              onClose={finish}
            />
          )}
          {pageMenu && (
            <PageMenu
              x={pageMenu.x}
              y={pageMenu.y}
              onTranslate={() => startTranslating(pageMenu.page)}
              onExtract={() => setExtractingPage(pageMenu.page)}
              onClose={() => setPageMenu(null)}
            />
          )}
          <CameraBar
            scale={camera.s}
            onFocus={presetFocus}
            onMap={presetMap}
            onZoomIn={() => zoomCenter(camera.s * 1.2)}
            onZoomOut={() => zoomCenter(camera.s / 1.2)}
            onActualSize={() => zoomCenter(1)}
          />
          {offscreenCard && (
            <div className="offscreen-hint" role="status">
              {t.offscreenThread}
              <button type="button" className="text-button" onClick={() => showCard(offscreenCard)}>{t.show}</button>
            </div>
          )}
        </div>
        {showJournal && (
          <JournalPanel
            bookId={book.id}
            bookTitle={book.title}
            settings={settings}
            notePage={currentPage}
            onGoToPage={goToPage}
            onOpenSettings={onOpenSettings}
            onClose={() => setShowJournal(false)}
          />
        )}
      </div>
      {askingRange && <TranslateRangeDialog page={currentPage} pages={pages.length} onTranslate={translateRange} onClose={() => setAskingRange(false)} />}
      {extractingPage !== null && (
        <ExtractTextDialog doc={doc} page={extractingPage} bookTitle={book.title} readings={readings} onOpenSettings={onOpenSettings} onClose={() => setExtractingPage(null)} />
      )}
      {actions.toast && <div className="toast" role="status">{actions.toast}</div>}
    </div>
  )
}

const EMPTY: never[] = []

