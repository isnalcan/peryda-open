import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { db, getPref, newId, setPref, type BookRecord } from '../data/db'
import { closePdf, cropPageRegion, openPdf, pageSizes, textInRect, type PDFDocumentProxy } from '../pdf/pdfjs'
import { useI18n } from '../i18n/I18n'
import type { Lang } from '../i18n/strings'
import type { ByokSettings } from '../ai/provider'
import { kindLabel } from '../ai/compose'
import { GEOMETRY, clampPageScale, pageLayout, pageWidthAt, pageWidthOf } from '../ilmek/geometry'
import { useCards } from '../ilmek/useCards'
import { YarnCardView } from '../ilmek/YarnCardView'
import { YarnLayer } from '../ilmek/YarnLayer'
import { useRopes } from '../ilmek/rope'
import { SelectionMenu, type ScreenRect } from '../ilmek/SelectionMenu'
import type { NormalizedRect, PageBox, PdfYarnAnchor, Point, YarnCard, YarnColor } from '../ilmek/types'
import { cardsForSurface, centredContentWidth, clipsFor, contentRect, isShown, pageBand, pinnedAfterResize, placeCards, worldRect, yarnSegments, type WorldInput } from '../ilmek/worldLayout'
import type { CardPlacement } from '../ilmek/lane'
import { PdfPageView, type PageHighlight, type PageKnot, type Tool } from './PdfPageView'
import { ReaderTopBar } from './ReaderTopBar'
import { anchorsFromSelection, expandToWords, normalizeText, selectionScreenRect, type PageElement } from './selection'
import { cameraForTranslation, constrainToBand, useCamera, type Camera } from './useCamera'
import { EyeIcon, EyeOffIcon, LinkIcon, SidebarIcon } from '../ui/icons'
import { JournalPanel } from '../journal/JournalPanel'
import { useThreadActions } from '../ilmek/useThreadActions'
import { useThreadMarks } from '../ilmek/threadMarks'
import { CameraBar, PageMenu, PageNav, TiedKnot, ToolSwitcher, TranslateMenu } from './ReaderControls'
import { ExtractTextDialog, TranslateRangeDialog } from './ReaderDialogs'
import { TranslatedPageView } from './TranslatedPageView'
import { RANGE_LIMIT, isUnfinishedTranslation } from '../ilmek/cardsStore'
import { PageTextCache, pageSource, renderPageJpeg, translationPicture } from './pageText'
import { PageReadingsStore } from '../reading/pageReadings'
import { useFakeAi } from '../ai/fake'
import { cardText } from './useThreadSelection'
import { BookInfoDialog } from '../library/BookInfoDialog'
import { highlightColorOf, useHighlightColor, type HighlightColor } from './highlightColors'
import { FindBar } from './FindBar'
import { foldQuery, searchDocument, type FindHit, type PageText } from './find'
import type { PageFindMark } from './PdfPageView'
import { SIDEBAR_WIDTH, ThumbnailSidebar } from './ThumbnailSidebar'

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
  /** Each page's size in points. */
  sizes: (readonly [number, number])[]
  /** The book's page size (the reader resizes the pages from a page's corner); 1 is pageWorldWidth. */
  pageScale: number
  camera: Camera | null
  page: number
  paged: boolean
  target: Lang
  /** Translations explain hard terms in brackets (a reader preference, on unless turned off). */
  explainTerms: boolean
  /** The page thumbnails sidebar is open (kept for the whole app). */
  thumbnails: boolean
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
        const [saved, paged, target, explainTerms, pageScale, thumbnails] = await Promise.all([
          db.positions.get(book.id),
          getPref<boolean>('pagedReading', false),
          getPref<Lang | null>(`translateLang:${book.id}`, null),
          getPref<boolean>('explainTerms', true),
          getPref<unknown>(`pageScale:${book.id}`, 1),
          getPref<unknown>('thumbnailsOpen', false),
        ])
        if (cancelled) return
        setOpened({
          doc,
          sizes: sizes.map((s) => [s.width, s.height] as const),
          pageScale: typeof pageScale === 'number' && Number.isFinite(pageScale) ? clampPageScale(pageScale) : 1,
          camera: saved && saved.scale > 0 ? { x: saved.panX, y: saved.panY, s: saved.scale } : null,
          page: Math.min(Math.max(1, saved?.page ?? 1), doc.numPages),
          paged,
          target: target ?? lang,
          explainTerms,
          thumbnails: thumbnails === true,
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

/** A resize of the pages from a page's corner, while the pointer is down. */
interface PageResizeDrag {
  page: number
  /** The pages when the drag began (cards the reader placed are moved from these). */
  startPages: PageBox[]
  startScale: number
  scale: number
  /** The grabbed page's top-left corner on screen (viewport pixels): it stays there. */
  left: number
  top: number
  renderWidth: number
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
  const { doc, sizes } = opened
  // The pages' size: resized from a page's bottom-right corner, kept per book (owner, 16 Nov).
  const [pageScale, setPageScale] = useState(opened.pageScale)
  const pages = useMemo(() => pageLayout(sizes, pageWidthAt(pageScale)), [sizes, pageScale])
  const pageWidth = pageWidthOf(pages)
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
  const [highlightColor, setHighlightColor] = useHighlightColor()
  const [thumbnailsOpen, setThumbnailsOpen] = useState(opened.thumbnails)
  const [showInfo, setShowInfo] = useState(false)
  const pageResizing = useRef<PageResizeDrag | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [bridgeHeld, setBridgeHeld] = useState<PdfYarnAnchor[] | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [hideThreads, setHideThreads] = useState(false)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedCard, setFocusedCard] = useState<string | null>(null)
  const [showJournal, setShowJournal] = useState(false)
  const [offscreenCard, setOffscreenCard] = useState<string | null>(null)
  const [pagedReading, setPagedReading] = useState(opened.paged)
  const [pagedPage, setPagedPage] = useState(opened.page)
  const [translationTarget, setTranslationTarget] = useState<Lang>(opened.target)
  const [explainTerms, setExplainTerms] = useState(opened.explainTerms)
  const [askingRange, setAskingRange] = useState(false)
  const [extractingPage, setExtractingPage] = useState<number | null>(null)
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number; page: number } | null>(null)
  const [showTranslationFor, setShowTranslationFor] = useState<number | null>(null)
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
  const { store, cards, create, ask, retry, stop, remove, update, resize, resizeFrom, placeMany } = useCards({ bookId: book.id, bookTitle: book.title, lang, settings })
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
  // While the pages are resized from a corner: the width the pages stay drawn at (they are stretched
  // until the pointer is let go) and where the cards the reader placed are meanwhile.
  const [pageResize, setPageResize] = useState<{ renderWidth: number; moved: ReadonlyMap<string, CardPlacement> } | null>(null)
  // Page translations at their page's size now, and placed cards following a resize in progress.
  const surfaceCards = useMemo(() => cardsForSurface(cards, pages, pageResize?.moved), [cards, pages, pageResize])
  const layoutInput: WorldInput = useMemo(
    () => ({ cards: surfaceCards, pages, heights, pagedReading, currentPage: 1, hideThreads: false, revealed: new Set<string>() }),
    [surfaceCards, pages, heights, pagedReading],
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
        list.unshift({ key: `hl-${entry.id}-${i}`, cardId: '', color: 'amber', area: false, rects: m.lineRects, highlighter: true, highlightColor: highlightColorOf(entry) })
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
  // Not while the pages are being resized: the band moves with them (set again when the pointer is let go).
  constrainRef.current = pageResizing.current ? null : constrainFor(bandFor(currentPage))

  // ---- Viewport, saved position ----
  const overviewCamera = useCallback(
    (width: number, height: number): Camera => {
      const s = Math.min(1, Math.max(0.15, (width - 48) / centredContentWidth(content)))
      return { x: width / 2 - (pageWidth / 2) * s, y: 24, s }
    },
    [content, pageWidth],
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

  // ---- Find in the document (Ctrl/Cmd+F, owner 16 Nov) ----
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findHits, setFindHits] = useState<FindHit[]>([])
  const [findIndex, setFindIndex] = useState(-1)
  const [findSearching, setFindSearching] = useState(false)
  /** The search stopped at MAX_FIND_HITS matches. */
  const [findCapped, setFindCapped] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const findTexts = useRef(new Map<number, PageText>())
  const findHitsRef = useRef(findHits)
  findHitsRef.current = findHits
  const findIndexRef = useRef(findIndex)
  findIndexRef.current = findIndex
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage

  /**
   * Brings a match into view at the reader's zoom: centred up and down, moved sideways only when it is
   * outside the view. Page by page, it turns to the match's page.
   */
  const revealHit = (hit: FindHit) => {
    const box = pages[hit.page - 1]
    if (!box || !hit.rects.length) return
    const left = Math.min(...hit.rects.map((r) => r.x))
    const right = Math.max(...hit.rects.map((r) => r.x + r.width))
    const top = Math.min(...hit.rects.map((r) => r.y))
    const bottom = Math.max(...hit.rects.map((r) => r.y + r.height))
    const c = cameraRef.current
    const wx0 = box.x + left * box.width
    const wx1 = box.x + right * box.width
    const wy = box.y + ((top + bottom) / 2) * box.height
    const margin = 24
    const outside = c.x + wx0 * c.s < margin || c.x + wx1 * c.s > viewport.width - margin
    const target: Camera = { x: outside ? viewport.width / 2 - ((wx0 + wx1) / 2) * c.s : c.x, y: viewport.height / 2 - wy * c.s, s: c.s }
    if (pagedReading && hit.page !== pagedPage) {
      fadePage()
      setPagedPage(hit.page)
      constrainRef.current = constrainFor(bandFor(hit.page))
      cameraReady.current = true
      cancelAnimationFrame(animation.current)
      setCamera(target)
    } else {
      animateCamera(target)
    }
  }
  const revealRef = useRef(revealHit)
  revealRef.current = revealHit

  const chooseHit = useCallback((i: number) => {
    const hit = findHitsRef.current[i]
    if (!hit) return
    setFindIndex(i)
    revealRef.current(hit)
  }, [])

  /** The next (+1) or previous (−1) match, going round at either end. */
  const stepFind = useCallback(
    (delta: number) => {
      const n = findHitsRef.current.length
      if (!n) return
      const here = findIndexRef.current
      chooseHit(here < 0 ? (delta > 0 ? 0 : n - 1) : (here + delta + n) % n)
    },
    [chooseHit],
  )

  const openFind = useCallback(() => {
    setFindOpen(true)
    requestAnimationFrame(() => {
      findInputRef.current?.focus({ preventScroll: true })
      findInputRef.current?.select()
    })
  }, [])
  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
  }, [])

  // ---- Page thumbnails beside the surface (owner, 16 Nov) ----
  /** Opens or closes the sidebar; the surface narrows or widens by its width and keeps its middle. */
  const thumbnailsRef = useRef(thumbnailsOpen)
  thumbnailsRef.current = thumbnailsOpen
  const toggleThumbnails = useCallback(() => {
    const next = !thumbnailsRef.current
    thumbnailsRef.current = next
    setThumbnailsOpen(next)
    void setPref('thumbnailsOpen', next)
    const c = cameraRef.current
    setCamera({ ...c, x: c.x + (next ? -SIDEBAR_WIDTH / 2 : SIDEBAR_WIDTH / 2) })
  }, [cameraRef, setCamera])

  // Looks through the whole book a moment after typing stops; the counter fills in page by page, and the
  // first match on or after the page being read becomes the current one.
  useEffect(() => {
    if (!findOpen || !foldQuery(findQuery)) {
      setFindHits([])
      setFindIndex(-1)
      setFindSearching(false)
      return
    }
    const controller = new AbortController()
    const startPage = currentPageRef.current
    const timer = window.setTimeout(() => {
      const all: FindHit[] = []
      let chosen = -1
      setFindCapped(false)
      setFindHits([])
      setFindIndex(-1)
      setFindSearching(true)
      void searchDocument(doc, findQuery, {
        signal: controller.signal,
        cache: findTexts.current,
        onHits: (hits) => {
          if (controller.signal.aborted) return
          // One at a time: spreading a huge page's matches into push() overflowed the stack (W16-1).
          for (const hit of hits) all.push(hit)
          const snapshot = all.slice()
          findHitsRef.current = snapshot
          setFindHits(snapshot)
          if (chosen === -1) {
            const i = snapshot.findIndex((h) => h.page >= startPage)
            if (i !== -1) {
              chosen = i
              chooseHit(i)
            }
          }
        },
      }).then((capped) => {
        if (controller.signal.aborted) return
        setFindCapped(capped)
        setFindSearching(false)
        if (chosen === -1 && all.length) chooseHit(0)
      })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [findOpen, findQuery, doc, chooseHit])

  const findMarksByPage = useMemo(() => {
    const map = new Map<number, PageFindMark[]>()
    findHits.forEach((hit, i) => {
      const list = map.get(hit.page) ?? []
      list.push({ key: `find-${i}`, rects: hit.rects, current: i === findIndex })
      map.set(hit.page, list)
    })
    return map
  }, [findHits, findIndex])

  // Ctrl/Cmd+F opens find (instead of the browser's own, which cannot see pages not drawn yet);
  // Ctrl/Cmd+G and Shift+Ctrl/Cmd+G go to the next and previous match.
  const findOpenRef = useRef(findOpen)
  findOpenRef.current = findOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      // A dialog over the book (Settings, book info…) keeps the browser's own keys (audit W16-7).
      if (document.querySelector('dialog[open]')) return
      const target = e.target instanceof Element ? e.target : null
      if (e.altKey) {
        if (e.code === 'Digit2' && !target?.closest('textarea, input, select, [contenteditable="true"]')) {
          // Alt+Ctrl/Cmd+2: the thumbnails, as in Preview (⌥⌘2).
          e.preventDefault()
          toggleThumbnails()
        }
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'f') {
        e.preventDefault()
        openFind()
      } else if (key === 'g' && findOpenRef.current) {
        e.preventDefault()
        stepFind(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openFind, stepFind, toggleThumbnails])

  // ---- Resizing the pages from a page's bottom-right corner (owner, 16 Nov) ----
  // The pages keep their proportions; threads, highlights and translations follow them, and cards the
  // reader placed move with their passage. The grabbed page's top-left corner stays where it is on
  // screen. The pages are stretched while the pointer moves and drawn again at the new size after.
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const pageScaleRef = useRef(pageScale)
  pageScaleRef.current = pageScale

  /** Lays the pages out at `scale` and keeps the grabbed page's corner at (left, top) on screen. */
  const showPagesAt = useCallback(
    (scale: number, page: number, left: number, top: number) => {
      const next = pageLayout(sizes, pageWidthAt(scale))
      const box = next[page - 1]
      if (!box) return next
      cancelAnimationFrame(animation.current)
      cameraReady.current = true
      const c = cameraRef.current
      constrainRef.current = null
      setCamera({ x: left - box.x * c.s, y: top - box.y * c.s, s: c.s })
      setPageScale(scale)
      return next
    },
    [sizes, cameraRef, setCamera],
  )

  const onPageGripDown = useCallback(
    (page: number, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const box = pagesRef.current[page - 1]
      if (!box) return
      e.preventDefault()
      e.stopPropagation()
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic or already released pointer */
      }
      setPending(null)
      const c = cameraRef.current
      const scale = pageScaleRef.current
      pageResizing.current = { page, startPages: pagesRef.current, startScale: scale, scale, left: c.x + box.x * c.s, top: c.y + box.y * c.s, renderWidth: box.width }
      setPageResize({ renderWidth: box.width, moved: new Map() })
    },
    [cameraRef],
  )

  const onPageGripMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = pageResizing.current
      const host = viewportRef.current?.getBoundingClientRect()
      const b = d?.startPages[d.page - 1]
      if (!d || !host || !b) return
      // The pointer's offset from the page's corner, projected on the page's diagonal: the page keeps
      // its proportions and its bottom-right corner follows the pointer.
      const s = cameraRef.current.s
      const dx = (e.clientX - host.left - d.left) / s
      const dy = (e.clientY - host.top - d.top) / s
      const t = (dx * b.width + dy * b.height) / (b.width * b.width + b.height * b.height)
      const scale = clampPageScale((t * b.width) / GEOMETRY.pageWorldWidth)
      if (Math.abs(scale - d.scale) < 1e-4) return
      d.scale = scale
      const next = showPagesAt(scale, d.page, d.left, d.top)
      setPageResize({ renderWidth: d.renderWidth, moved: pinnedAfterResize(store.cards, d.startPages, next) })
    },
    [cameraRef, showPagesAt, store],
  )

  const onPageGripUp = useCallback(() => {
    const d = pageResizing.current
    if (!d) return
    pageResizing.current = null
    if (d.scale !== d.startScale) {
      placeMany(pinnedAfterResize(store.cards, d.startPages, pageLayout(sizes, pageWidthAt(d.scale))))
      void setPref(`pageScale:${book.id}`, d.scale)
    }
    setPageResize(null)
  }, [placeMany, store, sizes, book.id])

  /** A double click on the corner: the pages' original size. */
  const onPageGripReset = useCallback(
    (page: number) => {
      const from = pagesRef.current
      const box = from[page - 1]
      if (!box || pageScaleRef.current === 1) return
      const c = cameraRef.current
      const next = showPagesAt(1, page, c.x + box.x * c.s, c.y + box.y * c.s)
      placeMany(pinnedAfterResize(store.cards, from, next))
      void setPref(`pageScale:${book.id}`, 1)
    },
    [cameraRef, showPagesAt, placeMany, store, book.id],
  )

  const pageGrip = useMemo(
    () => ({ label: t.resizePage, down: onPageGripDown, move: onPageGripMove, up: onPageGripUp, reset: onPageGripReset }),
    [t.resizePage, onPageGripDown, onPageGripMove, onPageGripUp, onPageGripReset],
  )

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
    animateCamera({ x: viewport.width / 2 - (pageWidth / 2) * s, y: viewport.height / 2 - cy * s, s })
  }
  const presetFocus = () => fit(pageWidth + 48, 2.5)
  const presetMap = () => fit(centredContentWidth(content), 0.45)
  const zoomCenter = (s: number) => zoomAround([viewport.width / 2, viewport.height / 2], s)

  /** A page's new translation comes into view beside it, at the reader's own zoom and height. */
  const showTranslation = useCallback(
    (page: number) => {
      const box = pages[page - 1]
      if (!box) return
      const card = store.pageTranslation(page, translationTarget)
      const p = card ? placements.get(card.id) : undefined
      // A translation is drawn at its page's size.
      const left = p ? p.x : box.x + box.width + 60
      animateCamera(cameraForTranslation(cameraRef.current, viewport.width, { pageLeft: box.x, translationLeft: left, right: left + box.width }))
    },
    [pages, store, translationTarget, placements, viewport.width, animateCamera, cameraRef],
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

  // ---- Pointer: panning ----
  const panDrag = useRef<{ x: number; y: number } | null>(null)
  const onViewportPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (!target.closest('.selection-menu')) setPending((p) => (p ? null : p))
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
    const d = panDrag.current
    if (!d) return
    panBy(e.clientX - d.x, e.clientY - d.y)
    panDrag.current = { x: e.clientX, y: e.clientY }
  }
  const onViewportPointerUp = () => {
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
      input.anchors.map(async (a) => (a.sourceType === 'card' || a.context ? a : { ...a, context: await pageTexts.context(a.pageNumber, a.selectedText) })),
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

  const onHighlight = async (color: HighlightColor) => {
    if (!pending) return
    // Choosing a colour makes it the one "Vurgula" uses from now on.
    if (color !== highlightColor) setHighlightColor(color)
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
    await actions.highlight(anchors, color)
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

  return (
    <div className="reader-shell" style={{ ['--card-text' as string]: actions.cardTextScale }}>
      <ReaderTopBar
        title={book.title}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
        onOpenJournal={() => setShowJournal((v) => !v)}
        journalOpen={showJournal}
        onBookInfo={() => setShowInfo(true)}
        leading={
          <>
            <button
              type="button"
              className="icon-button"
              aria-pressed={thumbnailsOpen}
              title={t.thumbnails}
              aria-label={t.thumbnails}
              onClick={toggleThumbnails}
            >
              <SidebarIcon size={18} />
            </button>
            <ToolSwitcher tool={tool} onTool={setTool} />
          </>
        }
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
        {thumbnailsOpen && <ThumbnailSidebar doc={doc} sizes={sizes} current={currentPage} onGoTo={goToPage} />}
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
            className={`reader-world${pageResize ? ' is-resizing-pages' : ''}`}
            style={{
              width: world.x + world.width,
              height: world.height,
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.s})`,
              ['--zoom' as string]: camera.s,
            }}
          >
            {pages.map((box, i) =>
              i >= visibleRange.first && i <= visibleRange.last ? (
                <PdfPageView
                  key={i + 1}
                  doc={doc}
                  pageNumber={i + 1}
                  box={box}
                  renderWidth={pageResize?.renderWidth}
                  renderScale={settledScale}
                  highlights={highlightsByPage.get(i + 1) ?? EMPTY}
                  findMarks={findMarksByPage.get(i + 1)}
                  knots={knotsByPage.get(i + 1) ?? EMPTY}
                  tool={tool}
                  register={registerPage}
                  onAreaSelected={onAreaSelected}
                  onHighlightClick={onHighlightClick}
                  onTextless={noop}
                  onDrawn={onPageDrawn}
                  grip={pageGrip}
                />
              ) : pagedReading ? null : (
                <div key={i + 1} className="pdf-page is-placeholder" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }} />
              ),
            )}
            <YarnLayer segments={segments} bends={ropeBends} x={world.x} width={world.width} height={world.height} />
            {surfaceCards.map((card) => {
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
                    onHeight={onHeight}
                    onAsk={ask}
                    onRetry={retry}
                    onStop={stop}
                    onRemove={remove}
                    onMove={onMove}
                    onDragLive={onDragLive}
                    onResize={resize}
                    onResizeFrom={resizeFrom}
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

          {findOpen && (
            <FindBar
              ref={findInputRef}
              query={findQuery}
              onQuery={setFindQuery}
              count={findHits.length}
              index={findIndex}
              searching={findSearching}
              capped={findCapped}
              onNext={() => stepFind(1)}
              onPrevious={() => stepFind(-1)}
              onClose={closeFind}
            />
          )}
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
              highlightColor={highlightColor}
              onHighlight={(color) => void onHighlight(color)}
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
      {showInfo && <BookInfoDialog book={book} onClose={() => setShowInfo(false)} />}
      {actions.toast && <div className="toast" role="status">{actions.toast}</div>}
    </div>
  )
}

const EMPTY: never[] = []

