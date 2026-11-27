import { memo, useEffect, useRef, useState, type PointerEvent } from 'react'
import { pdfjs, pageCharacterCount, type PDFDocumentProxy } from '../pdf/pdfjs'
import { GEOMETRY, areaAccepted, rectFromCorners } from '../ilmek/geometry'
import { cappedScale } from '../pdf/canvasLimit'
import type { NormalizedRect, PageBox, YarnColor } from '../ilmek/types'
import type { HighlightColor } from './highlightColors'

export interface PageHighlight {
  key: string
  cardId: string
  color: YarnColor
  area: boolean
  rects: NormalizedRect[]
  /** True when the thread card is currently folded or hidden, so clicking its highlight unfolds/reveals it first. */
  folded?: boolean
  /** The reader's own highlight ("Vurgula"): drawn like a highlighter, not clickable, text under it stays selectable. */
  highlighter?: boolean
  /** The highlighter's colour (yellow when not given). */
  highlightColor?: HighlightColor
}

/** A match of "Find in the document" on this page; the current one is drawn stronger. */
export interface PageFindMark {
  key: string
  rects: readonly NormalizedRect[]
  current: boolean
}

export interface PageKnot {
  cardId: string
  color: YarnColor
  label: string
  rect: NormalizedRect
}

export type Tool = 'select' | 'area'

/** The corner the pages are resized from (bottom-right of every page), handled by the reader. */
export interface PageGrip {
  label: string
  down: (pageNumber: number, e: PointerEvent<HTMLElement>) => void
  move: (e: PointerEvent<HTMLElement>) => void
  up: () => void
  reset: (pageNumber: number) => void
}

interface Props {
  doc: PDFDocumentProxy
  pageNumber: number
  box: PageBox
  /**
   * While the pages are being resized: the width the page stays drawn at, stretched to `box` (drawing it
   * again on every move would stutter). It is drawn at its new size once the pointer is let go.
   */
  renderWidth?: number
  renderScale: number
  highlights: readonly PageHighlight[]
  /** Matches of "Find in the document" on this page. */
  findMarks?: readonly PageFindMark[]
  knots: readonly PageKnot[]
  tool: Tool
  register: (pageNumber: number, element: HTMLElement | null, textLayer: HTMLElement | null) => void
  onAreaSelected: (pageNumber: number, rect: NormalizedRect) => void
  onHighlightClick: (cardId: string) => void
  onTextless: (pageNumber: number, textless: boolean) => void
  /** Called after the page's picture has been drawn. */
  onDrawn?: () => void
  grip?: PageGrip
}

/**
 * Places `.endOfContent` right next to the text span at `(clientX, clientY)` while the reader drags a
 * selection across a PDF page. Because `pdf.js` renders each line/run as an `absolute` span with empty
 * gaps between lines and in margins, hitting bare `.textLayer` mid-drag makes browsers jump the selection
 * endpoint to the end of `.textLayer` (selecting 10–15 lines at once). Parking `.endOfContent` (`z-index: 0,
 * user-select: none`) right after the active span keeps the selection locked to the line under the cursor.
 */
export function parkEndOfContent(
  endOfContent: HTMLElement,
  spans: readonly { el: Element; rect: DOMRect }[],
  anchorY: number,
  clientX: number,
  clientY: number,
  anchorX = clientX,
): void {
  if (!spans.length) return
  // Filter to spans belonging to the horizontal column under `(clientX)` (or between `anchorX` and `clientX`)
  // so dragging down the left column of a 2-column academic PDF never jumps to the right column!
  const minBandX = Math.min(anchorX, clientX) - 44
  const maxBandX = Math.max(anchorX, clientX) + 44
  const inCursorColumn = (r: DOMRect) => r.right >= clientX - 44 && r.left <= clientX + 44
  const hasCursorColumn = spans.some((s) => s.rect.width > 0 && s.rect.height > 0 && inCursorColumn(s.rect))
  const inBand = (r: DOMRect) =>
    hasCursorColumn ? inCursorColumn(r) : r.right >= minBandX && r.left <= maxBandX
  const useAll = !hasCursorColumn && !spans.some((s) => s.rect.width > 0 && s.rect.height > 0 && inBand(s.rect))

  if (clientY >= anchorY - 2) {
    let lastIdx = -1
    for (let i = 0; i < spans.length; i += 1) {
      const r = spans[i]!.rect
      if (r.width <= 0 || r.height <= 0) continue
      if (!useAll && !inBand(r)) continue
      const aboveLine = r.bottom <= clientY + 2
      const onLine = r.top <= clientY + 2 && r.bottom > clientY + 2 && r.left <= clientX + 4
      if (aboveLine || onLine) lastIdx = i
    }
    if (lastIdx >= 0) {
      const span = spans[lastIdx]!.el
      const afterNode = span.nextElementSibling?.tagName === 'BR' ? span.nextElementSibling : span
      if (afterNode.nextSibling !== endOfContent) afterNode.after(endOfContent)
    } else if (spans[0]!.el.previousSibling !== endOfContent) {
      spans[0]!.el.before(endOfContent)
    }
  } else {
    let firstIdx = -1
    for (let i = 0; i < spans.length; i += 1) {
      const r = spans[i]!.rect
      if (r.width <= 0 || r.height <= 0) continue
      if (!useAll && !inBand(r)) continue
      const belowLine = r.top >= clientY - 2
      const onLine = r.top < clientY - 2 && r.bottom >= clientY - 2 && r.right >= clientX - 4
      if (belowLine || onLine) {
        firstIdx = i
        break
      }
    }
    if (firstIdx >= 0) {
      const target = spans[firstIdx]!.el
      if (target.previousSibling !== endOfContent) target.before(endOfContent)
    } else {
      const last = spans[spans.length - 1]!.el
      if (last.nextSibling !== endOfContent) last.after(endOfContent)
    }
  }
}

function PdfPageViewImpl(props: Props) {
  const { doc, pageNumber, box, renderScale } = props
  const drawnWidth = props.renderWidth ?? box.width
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [textless, setTextless] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [drag, setDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null)
  const clickStartRef = useRef<{ x: number; y: number } | null>(null)
  const handledPointerClickRef = useRef(false)
  const justReopenedRef = useRef(false)

  useEffect(() => {
    props.register(pageNumber, pageRef.current, textRef.current)
    return () => props.register(pageNumber, null, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNumber])

  // Text layer: drawn once per page at world scale; the world transform scales it with the camera.
  useEffect(() => {
    let cancelled = false
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled || !textRef.current || !pageRef.current) return
      const unit = page.getViewport({ scale: 1 })
      // A page with no usable size stays a blank page (audit 16 Nov, M16-1).
      if (!(unit.width >= 1 && unit.height >= 1)) return
      const viewport = page.getViewport({ scale: drawnWidth / unit.width })
      pageRef.current.style.setProperty('--total-scale-factor', String(viewport.scale))
      textRef.current.replaceChildren()
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textRef.current, viewport })
      await layer.render().catch(() => undefined)
      if (!cancelled && textRef.current && !textRef.current.querySelector('.endOfContent')) {
        const end = document.createElement('div')
        end.className = 'endOfContent'
        textRef.current.append(end)
      }
      const count = await pageCharacterCount(page)
      if (!cancelled) {
        const none = count < GEOMETRY.textlessPageCharacterThreshold
        setTextless(none)
        props.onTextless(pageNumber, none)
      }
    })()
    return () => {
      cancelled = true
      layer?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageNumber, drawnWidth])

  // Bitmap: re-rendered when the camera settles at a new scale so text stays sharp.
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    void (async () => {
      const page = await doc.getPage(pageNumber)
      const canvas = canvasRef.current
      if (cancelled || !canvas) return
      const unit = page.getViewport({ scale: 1 })
      if (!(unit.width >= 1 && unit.height >= 1)) return
      const dpr = window.devicePixelRatio || 1
      const scale = cappedScale(unit.width, unit.height, (drawnWidth * renderScale * dpr) / unit.width)
      const viewport = page.getViewport({ scale })
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.ceil(viewport.width)
      offscreen.height = Math.ceil(viewport.height)
      const ctx = offscreen.getContext('2d')
      if (!ctx) return
      task = page.render({ canvas: offscreen, canvasContext: ctx, viewport })
      try {
        await task.promise
      } catch {
        return
      }
      if (cancelled) return
      // Swap in one step so the page never flashes blank while re-rendering.
      canvas.width = offscreen.width
      canvas.height = offscreen.height
      canvas.getContext('2d')?.drawImage(offscreen, 0, 0)
      setRendered(true)
      props.onDrawn?.()
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, drawnWidth, renderScale])

  // Stabilizes multi-line text selection inside pdf.js's absolute-positioned textLayer (prevents 10–15 line jumps).
  // Activated lazily only once the pointer actually drags > 4px, so plain clicks on highlighted passages never
  // mutate `.textLayer` children or expand `.endOfContent` (`user-select: none`) under the cursor mid-click.
  useEffect(() => {
    const container = textRef.current
    if (!container) return
    let pointerDownAt: { x: number; y: number } | null = null
    let active: { end: HTMLElement; spans: { el: Element; rect: DOMRect }[]; anchorX: number; anchorY: number } | null = null

    const onDown = (e: globalThis.PointerEvent) => {
      if (e.button !== 0 || props.tool !== 'select') return
      pointerDownAt = { x: e.clientX, y: e.clientY }
      active = null
    }

    const onMove = (e: globalThis.PointerEvent) => {
      if (!pointerDownAt) return
      if (!active) {
        if (Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y) <= 4) return
        const end = container.querySelector<HTMLElement>('.endOfContent')
        if (!end) {
          pointerDownAt = null
          return
        }
        if (container.lastElementChild !== end) container.append(end)
        const spans: { el: Element; rect: DOMRect }[] = []
        const collect = (parent: Element) => {
          for (const child of parent.children) {
            if (child === end) continue
            if (child.classList.contains('markedContent')) collect(child)
            else if (child.tagName === 'SPAN') spans.push({ el: child, rect: child.getBoundingClientRect() })
          }
        }
        collect(container)
        active = { end, spans, anchorX: pointerDownAt.x, anchorY: pointerDownAt.y }
        container.classList.add('selecting')
      }
      parkEndOfContent(active.end, active.spans, active.anchorY, e.clientX, e.clientY, active.anchorX)
    }

    const onEnd = () => {
      pointerDownAt = null
      if (!active) return
      active = null
      container.classList.remove('selecting')
    }

    container.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      container.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      container.classList.remove('selecting')
    }
  }, [props.tool])

  const toNormalized = (e: PointerEvent): [number, number] => {
    const r = pageRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }

  const findThreadHighlightAt = (nx: number, ny: number): PageHighlight | undefined => {
    const hits = props.highlights.filter(
      (h) =>
        !h.highlighter &&
        Boolean(h.cardId) &&
        h.rects.some((rect) => nx >= rect.x - 0.006 && nx <= rect.x + rect.width + 0.006 && ny >= rect.y - 0.005 && ny <= rect.y + rect.height + 0.005),
    )
    if (!hits.length) return undefined
    return hits.find((h) => h.folded) ?? hits[hits.length - 1]
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    handledPointerClickRef.current = false
    justReopenedRef.current = false
    if (e.button === 0) clickStartRef.current = { x: e.clientX, y: e.clientY }
    if (e.button !== 0) return
    const areaGesture = props.tool === 'area' || e.shiftKey || e.altKey || textless
    if (!areaGesture || (e.target as HTMLElement).closest('.page-knot, .page-resize-grip')) {
      if (props.tool === 'select' && e.detail >= 2 && pageRef.current) {
        const r = pageRef.current.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          const hit = findThreadHighlightAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
          if (hit?.folded) e.preventDefault()
        }
      }
      return
    }
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toNormalized(e)
    setDrag({ a: p, b: p })
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag) {
      setDrag({ a: drag.a, b: toNormalized(e) })
      return
    }
    if (props.tool === 'select' && pageRef.current) {
      const [nx, ny] = toNormalized(e)
      const hit = findThreadHighlightAt(nx, ny)
      if (hit) pageRef.current.dataset.overThread = 'true'
      else delete pageRef.current.dataset.overThread
    }
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag) {
      const rect = rectFromCorners(drag.a, drag.b)
      setDrag(null)
      if (areaAccepted(rect)) props.onAreaSelected(pageNumber, rect)
      return
    }
    if (e.button !== 0 || props.tool !== 'select') return
    if ((e.target as HTMLElement).closest('.page-resize-grip, .page-knot')) return
    const start = clickStartRef.current
    clickStartRef.current = null
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) return
    const r = pageRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return
    const hit = findThreadHighlightAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
    if (!hit) return
    if (hit.folded) {
      // A short click (<= 8px) on a folded/hidden thread highlight always reopens it, even if rapid clicks
      // (`detail >= 2`) or a 1–2px trackpad nudge caused the browser to auto-select a character or word.
      window.getSelection()?.removeAllRanges()
      handledPointerClickRef.current = true
      justReopenedRef.current = true
      props.onHighlightClick(hit.cardId)
      return
    }
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return
    handledPointerClickRef.current = true
    props.onHighlightClick(hit.cardId)
  }
  const onPageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (handledPointerClickRef.current) {
      handledPointerClickRef.current = false
      if (justReopenedRef.current) {
        justReopenedRef.current = false
        window.getSelection()?.removeAllRanges()
      }
      return
    }
    if (props.tool !== 'select') return
    if ((e.target as HTMLElement).closest('.page-resize-grip, .page-knot')) return
    const r = pageRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return
    const hit = findThreadHighlightAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
    if (!hit) return
    if (!hit.folded) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return
    } else {
      window.getSelection()?.removeAllRanges()
    }
    props.onHighlightClick(hit.cardId)
  }

  const pct = (r: NormalizedRect) => ({
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.width * 100}%`,
    height: `${r.height * 100}%`,
  })

  // Prevents adjacent pdf.js line boxes of a multi-line highlight from overlapping vertically (which would
  // double-multiply into dark horizontal seams across ascenders/descenders) and adds tiny side breathing room.
  const tidyHighlighterRects = (rects: readonly NormalizedRect[]): NormalizedRect[] => {
    const out = rects.map((r) => {
      const padX = 0.0015
      const trimY = r.height * 0.035
      const x = Math.max(0, r.x - padX)
      const right = Math.min(1, r.x + r.width + padX)
      return {
        x,
        y: r.y + trimY,
        width: Math.max(0, right - x),
        height: Math.max(0.002, r.height - trimY * 2),
      }
    })
    for (let i = 1; i < out.length; i += 1) {
      const prev = out[i - 1]!
      const curr = out[i]!
      const sameColumn = Math.min(prev.x + prev.width, curr.x + curr.width) > Math.max(prev.x, curr.x)
      const prevBottom = prev.y + prev.height
      if (sameColumn && curr.y < prevBottom + 0.0008 && curr.y > prev.y) {
        const mid = (prevBottom + curr.y) / 2
        prev.height = Math.max(0.002, mid - 0.0004 - prev.y)
        const currBottom = curr.y + curr.height
        curr.y = mid + 0.0004
        curr.height = Math.max(0.002, currBottom - curr.y)
      }
    }
    return out
  }
  const dragRect = drag ? rectFromCorners(drag.a, drag.b) : null
  const stretch = box.width / drawnWidth

  return (
    <div
      ref={pageRef}
      className={`pdf-page${textless ? ' is-textless' : ''}${props.tool === 'area' ? ' is-area-tool' : ''}`}
      data-page={pageNumber}
      style={{
        transform: `translate(${box.x}px, ${box.y}px)${stretch !== 1 ? ` scale(${stretch})` : ''}`,
        transformOrigin: '0 0',
        width: drawnWidth,
        height: box.height / stretch,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (pageRef.current) delete pageRef.current.dataset.overThread
      }}
      onPointerCancel={() => setDrag(null)}
      onClick={onPageClick}
    >
      <canvas ref={canvasRef} className={`pdf-canvas${rendered ? ' is-ready' : ''}`} />
      <div className="highlight-layer" aria-hidden="true">
        {props.highlights.map((h) =>
          h.area ? (
            <div key={h.key} className="highlight-area" data-yarn={h.color} style={pct(h.rects[0]!)} onClick={() => props.onHighlightClick(h.cardId)} />
          ) : h.highlighter ? (
            tidyHighlighterRects(h.rects).map((r, i) => (
              <div key={`${h.key}-${i}`} className="highlight-line is-highlighter" data-hl={h.highlightColor ?? 'yellow'} style={pct(r)} />
            ))
          ) : (
            h.rects.map((r, i) => (
              <div key={`${h.key}-${i}`} className="highlight-line" data-yarn={h.color} style={pct(r)} onClick={() => props.onHighlightClick(h.cardId)} />
            ))
          ),
        )}
        {props.findMarks?.map((m) =>
          m.rects.map((r, i) => <div key={`${m.key}-${i}`} className={`find-match${m.current ? ' is-current' : ''}`} style={pct(r)} />),
        )}
      </div>
      <div ref={textRef} className="textLayer" />
      {props.knots.map((k) => (
        <button
          key={k.cardId}
          type="button"
          className="page-knot"
          data-yarn={k.color}
          style={{ left: `${(k.rect.x + k.rect.width) * 100}%`, top: `${(k.rect.y + k.rect.height / 2) * 100}%` }}
          onClick={() => props.onHighlightClick(k.cardId)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="6" cy="6" r="3.2" fill="currentColor" />
            <path d="M1 6c2-2.5 3-2.5 5 0s3 2.5 5 0" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
          {k.label}
        </button>
      ))}
      {dragRect && <div className="area-drag" style={pct(dragRect)} />}
      {props.grip && (
        <span
          className="page-resize-grip"
          role="separator"
          aria-label={props.grip.label}
          title={props.grip.label}
          onPointerDown={(e) => props.grip?.down(pageNumber, e)}
          onPointerMove={props.grip.move}
          onPointerUp={props.grip.up}
          onPointerCancel={props.grip.up}
          onDoubleClick={() => props.grip?.reset(pageNumber)}
        />
      )}
    </div>
  )
}

export const PdfPageView = memo(PdfPageViewImpl)
