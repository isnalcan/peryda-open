import { memo, useEffect, useRef, useState, type PointerEvent } from 'react'
import { pdfjs, pageCharacterCount, type PDFDocumentProxy } from '../pdf/pdfjs'
import { GEOMETRY, areaAccepted, rectFromCorners } from '../ilmek/geometry'
import { cappedScale } from '../pdf/canvasLimit'
import type { NormalizedRect, PageBox, YarnColor } from '../ilmek/types'

export interface PageHighlight {
  key: string
  cardId: string
  color: YarnColor
  area: boolean
  rects: NormalizedRect[]
  /** The reader's own yellow highlight ("Vurgula"): drawn like a highlighter, not clickable, text under it stays selectable. */
  highlighter?: boolean
}

export interface PageKnot {
  cardId: string
  color: YarnColor
  label: string
  rect: NormalizedRect
}

export type Tool = 'select' | 'area' | 'brush'

interface Props {
  doc: PDFDocumentProxy
  pageNumber: number
  box: PageBox
  renderScale: number
  highlights: readonly PageHighlight[]
  knots: readonly PageKnot[]
  tool: Tool
  register: (pageNumber: number, element: HTMLElement | null, textLayer: HTMLElement | null) => void
  onAreaSelected: (pageNumber: number, rect: NormalizedRect) => void
  onHighlightClick: (cardId: string) => void
  onTextless: (pageNumber: number, textless: boolean) => void
  /** Called after the page's picture has been drawn. */
  onDrawn?: () => void
}

function PdfPageViewImpl(props: Props) {
  const { doc, pageNumber, box, renderScale } = props
  const pageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [textless, setTextless] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [drag, setDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null)

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
      const viewport = page.getViewport({ scale: box.width / unit.width })
      pageRef.current.style.setProperty('--total-scale-factor', String(viewport.scale))
      textRef.current.replaceChildren()
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textRef.current, viewport })
      await layer.render().catch(() => undefined)
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
  }, [doc, pageNumber, box.width])

  // Bitmap: re-rendered when the camera settles at a new scale so text stays sharp.
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    void (async () => {
      const page = await doc.getPage(pageNumber)
      const canvas = canvasRef.current
      if (cancelled || !canvas) return
      const unit = page.getViewport({ scale: 1 })
      const dpr = window.devicePixelRatio || 1
      const scale = cappedScale(unit.width, unit.height, (box.width * renderScale * dpr) / unit.width)
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
  }, [doc, pageNumber, box.width, renderScale])

  const toNormalized = (e: PointerEvent): [number, number] => {
    const r = pageRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const areaGesture = props.tool === 'area' || e.shiftKey || e.altKey || textless
    if (!areaGesture || (e.target as HTMLElement).closest('.page-knot')) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toNormalized(e)
    setDrag({ a: p, b: p })
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return
    setDrag({ a: drag.a, b: toNormalized(e) })
  }
  const onPointerUp = () => {
    if (!drag) return
    const rect = rectFromCorners(drag.a, drag.b)
    setDrag(null)
    if (areaAccepted(rect)) props.onAreaSelected(pageNumber, rect)
  }

  const pct = (r: NormalizedRect) => ({
    left: `${r.x * 100}%`,
    top: `${r.y * 100}%`,
    width: `${r.width * 100}%`,
    height: `${r.height * 100}%`,
  })
  const dragRect = drag ? rectFromCorners(drag.a, drag.b) : null

  return (
    <div
      ref={pageRef}
      className={`pdf-page${textless ? ' is-textless' : ''}${props.tool === 'area' ? ' is-area-tool' : ''}`}
      data-page={pageNumber}
      style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <canvas ref={canvasRef} className={`pdf-canvas${rendered ? ' is-ready' : ''}`} />
      <div className="highlight-layer" aria-hidden="true">
        {props.highlights.map((h) =>
          h.area ? (
            <div key={h.key} className="highlight-area" data-yarn={h.color} style={pct(h.rects[0]!)} onClick={() => props.onHighlightClick(h.cardId)} />
          ) : (
            h.rects.map((r, i) =>
              h.highlighter ? (
                <div key={`${h.key}-${i}`} className="highlight-line is-highlighter" style={pct(r)} />
              ) : (
                <div key={`${h.key}-${i}`} className="highlight-line" data-yarn={h.color} style={pct(r)} onClick={() => props.onHighlightClick(h.cardId)} />
              ),
            )
          ),
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
    </div>
  )
}

export const PdfPageView = memo(PdfPageViewImpl)
