import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from '../pdf/pdfjs'
import { useI18n } from '../i18n/I18n'
import { pageTitle } from '../ai/compose'
import { cappedScale } from '../pdf/canvasLimit'

/**
 * The pages in small, beside the reading surface (owner, 16 Nov: "like Preview's sidebar"). Thumbnails
 * are drawn only when they come near the visible part of the list, small and once: each is kept for the
 * document. The current page is outlined and kept in view; a click goes to a page as "Go to page" does.
 */

/** The width a thumbnail is drawn at (CSS pixels); the sidebar is a little wider. */
export const THUMB_WIDTH = 116
/** The sidebar's width (CSS pixels), border included: the reading surface makes room for it. */
export const SIDEBAR_WIDTH = 164

/**
 * Thumbnails kept per document, the oldest dropped past this many (audit 16 Nov, W16-3): a long book
 * scrolled end to end would otherwise keep every page's picture in memory. A dropped one is drawn again
 * when it comes back into view.
 */
const KEEP = 400
const drawn = new WeakMap<PDFDocumentProxy, Map<number, string>>()
/** Keeps a drawn thumbnail, dropping the oldest when there are too many. */
export function keepThumbnail(map: Map<number, string>, n: number, url: string, keep = KEEP): void {
  map.delete(n)
  map.set(n, url)
  while (map.size > keep) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
function drawnFor(doc: PDFDocumentProxy): Map<number, string> {
  let map = drawn.get(doc)
  if (!map) {
    map = new Map()
    drawn.set(doc, map)
  }
  return map
}

/** Two thumbnails are drawn at a time, in the order they were asked for. */
let running = 0
const waiting: (() => void)[] = []
function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const take = () => {
      running += 1
      resolve(() => {
        running -= 1
        waiting.shift()?.()
      })
    }
    if (running < 2) take()
    else waiting.push(take)
  })
}

async function drawThumbnail(doc: PDFDocumentProxy, n: number): Promise<string> {
  const page = await doc.getPage(n)
  const unit = page.getViewport({ scale: 1 })
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  // A page with an odd shape (a long strip) is drawn no larger than any canvas the reader may draw.
  const viewport = page.getViewport({ scale: cappedScale(unit.width, unit.height, (THUMB_WIDTH * dpr) / unit.width) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  const url = canvas.toDataURL('image/jpeg', 0.72)
  canvas.width = 0
  canvas.height = 0
  return url
}

interface ThumbProps {
  doc: PDFDocumentProxy
  number: number
  size: readonly [number, number]
  current: boolean
  label: string
  root: HTMLElement | null
  onGoTo: (page: number) => void
}

const Thumb = memo(function Thumb({ doc, number, size, current, label, root, onGoTo }: ThumbProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [url, setUrl] = useState<string | null>(() => drawnFor(doc).get(number) ?? null)

  useEffect(() => {
    if (url) return
    const el = ref.current
    let alive = true
    let observer: IntersectionObserver | null = null
    const draw = async () => {
      const release = await slot()
      try {
        if (!alive) return
        const known = drawnFor(doc).get(number)
        const made = known ?? (await drawThumbnail(doc, number))
        if (!made) return
        keepThumbnail(drawnFor(doc), number, made)
        if (alive) setUrl(made)
      } catch {
        /* a page that cannot be drawn keeps its blank frame */
      } finally {
        release()
      }
    }
    if (!el || typeof IntersectionObserver === 'undefined') {
      void draw()
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return
          observer?.disconnect()
          void draw()
        },
        { root, rootMargin: '400px 0px' },
      )
      observer.observe(el)
    }
    return () => {
      alive = false
      observer?.disconnect()
    }
  }, [doc, number, url, root])

  return (
    <button
      ref={ref}
      type="button"
      className={`thumb${current ? ' is-current' : ''}`}
      data-page={number}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      title={label}
      onClick={() => onGoTo(number)}
    >
      <span className="thumb-frame" style={{ aspectRatio: `${size[0]} / ${size[1]}` }}>
        {url && <img src={url} alt="" draggable={false} decoding="async" />}
      </span>
      <span className="thumb-number">{number}</span>
    </button>
  )
})

interface Props {
  doc: PDFDocumentProxy
  /** Each page's size in points. */
  sizes: readonly (readonly [number, number])[]
  current: number
  onGoTo: (page: number) => void
}

export function ThumbnailSidebar({ doc, sizes, current, onGoTo }: Props) {
  const { t, lang } = useI18n()
  const listRef = useRef<HTMLElement>(null)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  useEffect(() => setRoot(listRef.current), [])

  // The current page stays in view while reading.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${current}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [current, root])

  return (
    <nav ref={listRef} className="thumbnail-sidebar" aria-label={t.thumbnails}>
      {sizes.map((size, i) => (
        <Thumb
          key={i + 1}
          doc={doc}
          number={i + 1}
          size={size}
          current={current === i + 1}
          label={pageTitle(lang, i + 1)}
          root={root}
          onGoTo={onGoTo}
        />
      ))}
    </nav>
  )
}
