import { StrictMode, act, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { I18nProvider } from '../i18n/I18n'
import { PdfPageView, parkEndOfContent, type PageHighlight } from '../reader/PdfPageView'
import { TiedKnot } from '../reader/ReaderControls'
import { createWheelAxisLock, stepCardWheelLock } from '../reader/useCamera'
import { highlighter } from '../styles/tokens'
import { YarnCardView } from './YarnCardView'
import { YarnLayer } from './YarnLayer'
import { findCardThreadAtPoint } from './threadMarks'
import type { YarnCard } from './types'
import { THREAD_EXIT_MS, useThreadPresence, type ThreadPresence } from './useThreadPresence'
import { clipsFor, placeCards, yarnSegments } from './worldLayout'
import { LEFT_LANE_SINCE } from './lane'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
async function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<I18nProvider lang="tr">{node}</I18nProvider>))
}
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})

const noop = () => undefined

describe('1 & 5. Yarn draw/retract and smooth card unravel/reveal presence', () => {
  it('keeps initial threads open, animates newly added threads entering -> open, keeps hidden/folded threads mounted while closing, and reverses mid-flight on interruption', async () => {
    vi.useFakeTimers()
    let latest: ThreadPresence | null = null
    let setShown!: (ids: string[]) => void

    function Harness({ existing }: { existing: string[] }) {
      const [shown, updateShown] = useState(['c1'])
      setShown = updateShown
      const existingSet = new Set(existing)
      const shownSet = new Set(shown)
      latest = useThreadPresence(existingSet, shownSet)
      return (
        <div>
          <YarnLayer
            width={1200}
            height={800}
            segments={[...latest.renderedIds].map((id) => ({
              key: `seg-${id}`,
              color: 'coral',
              from: [100, 100],
              to: [400, 140],
              cardId: id,
              state: latest!.stateOf.get(id),
              delayMs: latest!.delayOf.get(id),
            }))}
          />
        </div>
      )
    }

    await render(<Harness existing={['c1', 'c2']} />)
    expect([...latest!.renderedIds]).toEqual(['c1'])
    expect(latest!.stateOf.get('c1')).toBe('open')
    expect(host.querySelector('g.yarn')?.getAttribute('data-state')).toBe('open')
    expect(host.querySelector('path.yarn-main')?.getAttribute('pathLength')).toBe('1')

    // Spawn c2 -> starts in 'entering' on first frame so stroke-dashoffset transitions 1 -> 0.
    await act(async () => setShown(['c1', 'c2']))
    expect(latest!.stateOf.get('c2')).toBe('entering')
    expect(host.querySelectorAll('g.yarn')[1]?.getAttribute('data-state')).toBe('entering')

    // Hide all threads ("İlmekleri gizle") -> both stay mounted in 'closing' with stagger delays.
    await act(async () => setShown([]))
    expect([...latest!.renderedIds].sort()).toEqual(['c1', 'c2'])
    expect(latest!.stateOf.get('c1')).toBe('closing')
    expect(latest!.stateOf.get('c2')).toBe('closing')
    expect(latest!.delayOf.get('c2')).toBeGreaterThan(0)

    // Interrupt mid-flight at 100ms ("İlmekleri göster" clicked early) -> immediately flips back to 'open'!
    await act(async () => vi.advanceTimersByTime(100))
    expect(latest!.renderedIds.size).toBe(2)
    await act(async () => setShown(['c1', 'c2']))
    expect(latest!.stateOf.get('c1')).toBe('open')
    expect(latest!.stateOf.get('c2')).toBe('open')

    // Hide again and let exit animation complete -> unmounts cleanly after THREAD_EXIT_MS + stagger.
    await act(async () => setShown([]))
    expect(latest!.renderedIds.size).toBe(2)
    await act(async () => vi.advanceTimersByTime(THREAD_EXIT_MS + 150))
    expect(latest!.renderedIds.size).toBe(0)
    expect(host.querySelectorAll('g.yarn')).toHaveLength(0)
  })
})

describe('2. Opening folded threads directly by clicking highlighted text (no knot label pills)', () => {
  it('clicks through the PDF textLayer onto a thread highlight rect and prefers folded threads', async () => {
    const onHighlightClick = vi.fn()
    const doc = {
      getPage: async () => ({
        getViewport: () => ({ width: 0, height: 0, scale: 1 }),
      }),
    } as unknown as PDFDocumentProxy
    const highlights: PageHighlight[] = [
      { key: 'open-1', cardId: 'card-open', color: 'mint', area: false, rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }], folded: false },
      { key: 'folded-1', cardId: 'card-folded', color: 'coral', area: false, rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }], folded: true },
    ]

    await render(
      <PdfPageView
        doc={doc}
        pageNumber={1}
        box={{ x: 0, y: 0, width: 600, height: 800 }}
        renderScale={1}
        highlights={highlights}
        knots={[]}
        tool="select"
        register={noop}
        onAreaSelected={noop}
        onHighlightClick={onHighlightClick}
        onTextless={noop}
      />,
    )

    expect(host.querySelector('.page-knot')).toBeNull()
    const pageEl = host.querySelector<HTMLElement>('.pdf-page')!
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const textLayer = pageEl.querySelector<HTMLElement>('.textLayer')!

    // Plain click at (180, 176) -> normalized (0.3, 0.22), inside [0.1..0.6, 0.2..0.24].
    await act(async () => {
      textLayer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 180, clientY: 176 }))
      textLayer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 180, clientY: 176 }))
      textLayer.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 180, clientY: 176 }))
    })
    expect(onHighlightClick).toHaveBeenCalledTimes(1)
    expect(onHighlightClick).toHaveBeenCalledWith('card-folded')
  })

  it('reopens reliably across 10 consecutive fold/unfold cycles (including StrictMode, mid-close clicks, and accidental browser word selection)', async () => {
    vi.useFakeTimers()
    let collapsedState = false
    let setCollapsedFn!: (next: boolean) => void
    let presenceSnapshot!: ThreadPresence

    const doc = {
      getPage: async () => ({
        getViewport: () => ({ width: 0, height: 0, scale: 1 }),
      }),
    } as unknown as PDFDocumentProxy

    function CycleHarness() {
      const [collapsed, setCollapsed] = useState(false)
      collapsedState = collapsed
      setCollapsedFn = setCollapsed
      // Must be memoized just like PdfReader's `existingThreadIds` & `activeThreadIds`!
      const existing = useMemo(() => new Set(['c-repeat']), [])
      const shown = useMemo(() => new Set(collapsed ? [] : ['c-repeat']), [collapsed])
      presenceSnapshot = useThreadPresence(existing, shown)
      const highlights: PageHighlight[] = [
        {
          key: 'h-repeat',
          cardId: 'c-repeat',
          color: 'coral',
          area: false,
          rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
          folded: collapsed,
        },
      ]
      return (
        <StrictMode>
          <PdfPageView
            doc={doc}
            pageNumber={1}
            box={{ x: 0, y: 0, width: 600, height: 800 }}
            renderScale={1}
            highlights={highlights}
            knots={[]}
            tool="select"
            register={noop}
            onAreaSelected={noop}
            onHighlightClick={() => setCollapsed(false)}
            onTextless={noop}
          />
          {presenceSnapshot.renderedIds.has('c-repeat') && (
            <div className="mounted-card-probe" data-state={presenceSnapshot.stateOf.get('c-repeat') ?? 'open'} />
          )}
        </StrictMode>
      )
    }

    await render(<CycleHarness />)
    const pageEl = host.querySelector<HTMLElement>('.pdf-page')!
    vi.spyOn(pageEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 600,
      bottom: 800,
      width: 600,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const textLayer = pageEl.querySelector<HTMLElement>('.textLayer')!
    const sampleSpan = document.createElement('span')
    sampleSpan.textContent = 'Aydınlanma insanın kendi suçu ile düşmüş olduğu ergin olmama durumundan çıkmasıdır.'
    const endDiv = document.createElement('div')
    endDiv.className = 'endOfContent'
    textLayer.append(sampleSpan, endDiv)

    const waitMs = [650, 120, 700, 40, 560, 0, 620, 250, 800, 300]
    for (let cycle = 0; cycle < 10; cycle += 1) {
      // Fold the card ("Katla")
      await act(async () => setCollapsedFn(true))
      expect(collapsedState).toBe(true)

      await act(async () => vi.advanceTimersByTime(waitMs[cycle]!))

      // Simulate browser selecting a word on rapid clicks (cycles 3, 4, 7) + 2px pointer jitter during click!
      if (cycle === 3 || cycle === 4 || cycle === 7) {
        const range = document.createRange()
        range.selectNodeContents(sampleSpan)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)
        expect(sel.isCollapsed).toBe(false)
      }

      await act(async () => {
        sampleSpan.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 200, clientY: 176 }))
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 202, clientY: 177 }))
        // Plain click (2px jitter <= 4px) must NEVER activate .selecting on .textLayer!
        expect(textLayer.classList.contains('selecting')).toBe(false)
        sampleSpan.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 202, clientY: 177 }))
        sampleSpan.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: 202, clientY: 177 }))
      })

      expect(collapsedState).toBe(false)
      expect(presenceSnapshot.renderedIds.has('c-repeat')).toBe(true)
      expect(window.getSelection()?.isCollapsed ?? true).toBe(true)

      // Advance past entering rAF/fallback (100ms) -> MUST transition out of 'entering' to 'open' even with memoized Sets!
      await act(async () => vi.advanceTimersByTime(100))
      expect(presenceSnapshot.stateOf.get('c-repeat')).toBe('open')
      expect(host.querySelector('.mounted-card-probe')?.getAttribute('data-state')).toBe('open')
    }
  })

  it('finds a folded child thread when clicking its marked phrase inside a parent card', () => {
    const source = document.createElement('div')
    source.textContent = 'Tembellik ve korkaklık insanları ergin olmama durumunda tutar.'
    document.body.append(source)

    const origRects = Range.prototype.getClientRects
    Range.prototype.getClientRects = function () {
      return [{ left: 20, top: 40, right: 160, bottom: 58, width: 140, height: 18, x: 20, y: 40, toJSON: () => ({}) }] as unknown as DOMRectList
    }
    try {
      const child: YarnCard = {
        id: 'child-1',
        bookId: 'b',
        color: 'mint',
        kind: 'mint',
        parentCardId: 'parent-1',
        anchors: [
          {
            id: 'a1',
            sourceType: 'card',
            bookId: 'b',
            pageNumber: 0,
            selectedText: 'Tembellik ve korkaklık',
            lineRects: [],
            boundingRect: { x: 20, y: 40, width: 140, height: 18 },
            sourceCardId: 'parent-1',
          },
        ],
        x: 0,
        y: 0,
        width: 390,
        isPinned: false,
        collapsed: true,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      }
      expect(findCardThreadAtPoint(source, null, 80, 48, 'parent-1', [child])).toBe('child-1')
      expect(findCardThreadAtPoint(source, null, 300, 300, 'parent-1', [child])).toBeNull()
    } finally {
      Range.prototype.getClientRects = origRects
      source.remove()
    }
  })
})

describe('3. Smart chat auto-scroll on message send and streaming follow-ups', () => {
  it('scrolls to bottom when user submits a follow-up, follows streaming near bottom, and respects manual scroll-up', async () => {
    const scrollToSpy = vi.fn()
    function ChatHarness() {
      const [messages, setMessages] = useState<YarnCard['messages']>([
        { id: 'm1', role: 'user', content: 'ÖRNEK', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'İlk yanıt tamamlandı.', createdAt: 2 },
      ])
      const card: YarnCard = {
        id: 'c-chat',
        bookId: 'b',
        color: 'coral',
        kind: 'coral',
        anchors: [],
        x: 100,
        y: 100,
        width: 390,
        isPinned: false,
        collapsed: false,
        messages,
        createdAt: 1,
        updatedAt: 2,
      }
      return (
        <div>
          <button
            type="button"
            className="stream-more"
            onClick={() =>
              setMessages((prev) =>
                prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: `${m.content} Yeni satır eklendi.`, state: 'streaming' } : m)),
              )
            }
          >
            stream
          </button>
          <YarnCardView
            card={card}
            x={100}
            y={100}
            scale={() => 1}
            onHeight={noop}
            onAsk={(_id, text) =>
              setMessages((prev) => [
                ...prev,
                { id: `u-${prev.length}`, role: 'user', content: text, createdAt: 3 },
                { id: `a-${prev.length}`, role: 'assistant', content: '', state: 'streaming', createdAt: 4 },
              ])
            }
            onRetry={noop}
            onStop={noop}
            onRemove={noop}
            onMove={noop}
            onUnpin={noop}
            onCollapse={noop}
            onOpenSettings={noop}
            onFocusCard={noop}
            onSaveToJournal={noop}
          />
        </div>
      )
    }

    await render(<ChatHarness />)
    const middle = host.querySelector<HTMLElement>('.yarn-card-middle')!
    Object.defineProperty(middle, 'scrollHeight', { configurable: true, get: () => 900 })
    Object.defineProperty(middle, 'clientHeight', { configurable: true, get: () => 400 })
    let currentTop = 0
    Object.defineProperty(middle, 'scrollTop', {
      configurable: true,
      get: () => currentTop,
      set: (v: number) => {
        currentTop = v
      },
    })
    middle.scrollTo = ((opts: ScrollToOptions) => {
      scrollToSpy(opts)
      if (typeof opts.top === 'number') currentTop = opts.top
    }) as typeof middle.scrollTo

    // Type a follow-up question and press Enter -> scrolls to bottom (900).
    const textarea = host.querySelector<HTMLTextAreaElement>('.yarn-card-footer textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'Bunu biraz daha açar mısın?')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => requestAnimationFrame(r))
    })
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ top: 900 }))
    expect(currentTop).toBe(900)

    // User manually scrolls upward from 900 -> 100 -> streaming must NOT yank them back down to 900!
    currentTop = 100
    await act(async () => {
      middle.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.stream-more')!.click()
    })
    expect(currentTop).toBe(100)
  })
})

describe('4. Mac trackpad overscroll-behavior protection & PDF 3-line selection stabilizer', () => {
  it('blocks browser swipe-back navigation via overscroll-behavior: none on root elements', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    const rootRule = /html,\s*body,\s*#root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rootRule).toContain('overscroll-behavior: none')
  })

  it('parks .endOfContent right after the 3rd line (including its <br>) instead of letting selection jump to line 15', () => {
    const layer = document.createElement('div')
    const spans: { el: Element; rect: DOMRect }[] = []
    for (let i = 1; i <= 15; i += 1) {
      const s = document.createElement('span')
      s.textContent = `Line ${i}`
      const br = document.createElement('br')
      layer.append(s, br)
      const top = i * 24
      spans.push({
        el: s,
        rect: { left: 40, right: 340, top, bottom: top + 16, width: 300, height: 16, x: 40, y: top, toJSON: () => ({}) } as DOMRect,
      })
    }
    const end = document.createElement('div')
    end.className = 'endOfContent'
    layer.append(end)

    // Dragging from Line 1 (y=28) down into the whitespace gap below Line 3 (y=92, x=180):
    parkEndOfContent(end, spans, 28, 180, 92)
    // endOfContent sits immediately after Line 3's <br>, right before Line 4's <span>!
    expect(end.nextSibling).toBe(spans[3]!.el)

    // Dragging upward from Line 10 (y=245) up into the whitespace above Line 8 (y=194, x=100):
    parkEndOfContent(end, spans, 245, 100, 194)
    expect(end.nextSibling).toBe(spans[7]!.el)

    // 2-column academic PDF safety: dragging 3 lines down Left Column (x=40..300) must NEVER jump to Right Column (x=380..640)!
    const twoCol = document.createElement('div')
    const colSpans: { el: Element; rect: DOMRect }[] = []
    for (let col = 0; col < 2; col += 1) {
      const left = col === 0 ? 40 : 380
      for (let line = 1; line <= 10; line += 1) {
        const s = document.createElement('span')
        s.textContent = `C${col + 1}-L${line}`
        const br = document.createElement('br')
        twoCol.append(s, br)
        const top = line * 24
        colSpans.push({
          el: s,
          rect: { left, right: left + 260, top, bottom: top + 16, width: 260, height: 16, x: left, y: top, toJSON: () => ({}) } as DOMRect,
        })
      }
    }
    const twoColEnd = document.createElement('div')
    twoColEnd.className = 'endOfContent'
    twoCol.append(twoColEnd)
    // Start in Left Column Line 1 (x=120, y=28) and drag to Left Column Line 3 (x=180, y=92):
    parkEndOfContent(twoColEnd, colSpans, 28, 180, 92, 120)
    expect(twoColEnd.nextSibling).toBe(colSpans[3]!.el) // parked right after C1-L3, NOT in Column 2!
  })

  it('locks vertical card scrolling so natural trackpad finger curvature never drifts the canvas sideways, while keeping deliberate horizontal pan & Shift+Wheel', () => {
    const lock = createWheelAxisLock()
    const cardEl = document.createElement('div')

    // 1) Vertical reading swipe with natural diagonal finger arc (dx=3..6, dy=15..25) + trailing momentum:
    const f1 = stepCardWheelLock(lock, 2.5, 5, false, 100, cardEl)
    const f2 = stepCardWheelLock(lock, 4, 18, false, 116, cardEl)
    const f3 = stepCardWheelLock(lock, 6, 4, false, 132, cardEl) // curved momentum tail where dx > dy!
    expect(f1).toEqual({ scrollY: 5, panX: 0 })
    expect(f2).toEqual({ scrollY: 18, panX: 0 })
    expect(f3).toEqual({ scrollY: 4, panX: 0 }) // STILL 0 horizontal drift!

    // 2) After >140ms pause, user deliberately swipes sideways inside the card -> pans canvas with 0 vertical card scroll:
    const h1 = stepCardWheelLock(lock, 8, 1.5, false, 300, cardEl)
    const h2 = stepCardWheelLock(lock, 22, 4, false, 316, cardEl)
    expect(h1).toEqual({ scrollY: 0, panX: -8 })
    expect(h2).toEqual({ scrollY: 0, panX: -22 })

    // 3) Windows Shift + Mouse Wheel immediately pans horizontally even right after vertical wheel:
    stepCardWheelLock(lock, 0, 100, false, 500, cardEl)
    const shiftPan = stepCardWheelLock(lock, 100, 0, true, 520, cardEl)
    expect(shiftPan).toEqual({ scrollY: 0, panX: -100 })

    // 4) Deliberate fast 90-degree sideways flick interrupts winding-down vertical momentum without waiting 140ms:
    stepCardWheelLock(lock, 1, 20, false, 700, cardEl)
    const redirect = stepCardWheelLock(lock, 24, 2, false, 716, cardEl)
    expect(redirect).toEqual({ scrollY: 0, panX: -24 })
  })

  it('restores TiedKnot on the parent card edge when a child thread is folded and reopens on click', async () => {
    const onOpen = vi.fn()
    const parent: YarnCard = {
      id: 'parent-card',
      bookId: 'b',
      color: 'mint',
      kind: 'mint',
      anchors: [
        {
          id: 'pa',
          sourceType: 'pdf_text',
          bookId: 'b',
          pageNumber: 1,
          selectedText: 'Ana metin',
          lineRects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
          boundingRect: { x: 0.1, y: 0.2, width: 0.4, height: 0.03 },
        },
      ],
      x: 820,
      y: 120,
      width: 390,
      isPinned: true,
      collapsed: false,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const child: YarnCard = {
      id: 'child-card',
      bookId: 'b',
      color: 'coral',
      kind: 'coral',
      parentCardId: 'parent-card',
      anchors: [
        {
          id: 'ca',
          sourceType: 'card',
          bookId: 'b',
          pageNumber: 0,
          selectedText: 'Yavru ilmek ifadesi',
          lineRects: [],
          boundingRect: { x: 20, y: 60, width: 120, height: 18 },
          sourceCardId: 'parent-card',
        },
      ],
      x: 1260,
      y: 150,
      width: 390,
      isPinned: false,
      collapsed: true,
      messages: [],
      createdAt: 2,
      updatedAt: 2,
    }
    const clips = clipsFor(
      {
        cards: [parent, child],
        pages: [{ x: 0, y: 0, width: 760, height: 1000 }],
        heights: { 'parent-card': 280 },
        pagedReading: false,
        currentPage: 1,
        hideThreads: false,
        revealed: new Set(),
      },
      new Map([['parent-card', { x: 820, y: 120 }]]),
      'tr',
    )
    expect(clips).toHaveLength(1)
    expect(clips[0]!.cardId).toBe('child-card')

    await render(
      <TiedKnot
        color={clips[0]!.color}
        right={clips[0]!.right}
        title={clips[0]!.title}
        x={clips[0]!.point[0]}
        y={clips[0]!.point[1]}
        tying
        onOpen={() => onOpen(clips[0]!.cardId)}
      />,
    )
    const knotBtn = host.querySelector<HTMLButtonElement>('button.tied-knot.is-tying')!
    expect(knotBtn).not.toBeNull()
    expect(knotBtn.style.transform).toBe(`translate(${1210 - 13}px, ${clips[0]!.point[1] - 18}px)`)
    await act(async () => knotBtn.click())
    expect(onOpen).toHaveBeenCalledWith('child-card')

    // Left-edge original TiedKnot: border at x=820, 36px SVG with default 50% transform-origin -> 820 - 36 + 13 = 797px!
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    const knotSvgRule = /\.tied-knot svg\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(knotSvgRule).not.toContain('transform-origin')
    act(() => root.unmount())
    host.remove()
    await render(
      <TiedKnot
        color="mint"
        right={false}
        title="SADE ANLATIM"
        x={820}
        y={200}
        onOpen={noop}
      />,
    )
    const leftKnot = host.querySelector<HTMLButtonElement>('button.tied-knot')!
    expect(leftKnot.style.transform).toBe('translate(797px, 182px)')
    expect(leftKnot.querySelector('svg')?.style.transform).toBe('scaleX(-1)')
  })

  it('opens new threads on the left side of the PDF page when the right side near that passage is already crowded, and flows left-side child threads further left', () => {
    const pages = [{ x: 0, y: 0, width: 760, height: 1000 }]
    const mkRoot = (id: string, yNorm: number, createdAt: number): YarnCard => ({
      id,
      bookId: 'b',
      color: 'mint',
      kind: 'mint',
      anchors: [
        {
          id: `a-${id}`,
          sourceType: 'pdf_text',
          bookId: 'b',
          pageNumber: 1,
          selectedText: id,
          lineRects: [{ x: 0.1, y: yNorm, width: 0.6, height: 0.02 }],
          boundingRect: { x: 0.1, y: yNorm, width: 0.6, height: 0.02 },
        },
      ],
      x: 0,
      y: 0,
      width: 390,
      isPinned: false,
      collapsed: false,
      messages: [],
      createdAt,
      updatedAt: createdAt,
    })

    const c1 = mkRoot('t1', 0.25, LEFT_LANE_SINCE + 1) // First thread at y=250 -> Right lane (x=835)
    const c2 = mkRoot('t2', 0.28, LEFT_LANE_SINCE + 2) // Second thread right beside c1 (y=280) -> Right is crowded, opens on Left lane (x=-465)!
    const c3 = mkRoot('t3', 0.78, LEFT_LANE_SINCE + 3) // Third thread way down at y=780 where Right is completely free -> Right lane (x=835)!
    const c2Child: YarnCard = {
      id: 't2-child',
      bookId: 'b',
      color: 'coral',
      kind: 'coral',
      parentCardId: 't2',
      anchors: [
        {
          id: 'ac',
          sourceType: 'card',
          bookId: 'b',
          pageNumber: 0,
          selectedText: 'alt ifade',
          lineRects: [],
          boundingRect: { x: 20, y: 80, width: 100, height: 16 },
          sourceCardId: 't2',
        },
      ],
      x: 0,
      y: 0,
      width: 390,
      isPinned: false,
      collapsed: false,
      messages: [],
      createdAt: 4,
      updatedAt: 4,
    }

    const world = {
      cards: [c1, c2, c3, c2Child],
      pages,
      heights: { t1: 340, t2: 320, t3: 280, 't2-child': 220 },
      pagedReading: false,
      currentPage: 1,
      hideThreads: false,
      revealed: new Set<string>(),
    }
    const placed = placeCards(world)
    expect(placed.get('t1')!.x).toBe(835) // Right of page (760 + 75)
    expect(placed.get('t2')!.x).toBe(-465) // Left of page (-75 - 390), right beside its sentence!
    expect(placed.get('t2')!.y).toBeCloseTo(290 - 14, 1) // Zero push-down!
    expect(placed.get('t3')!.x).toBe(835) // Right of page at bottom where room is open
    expect(placed.get('t2-child')!.x).toBe(-465 - 390 - 68) // Flows further left (-923), never covering the PDF page!

    const segs = yarnSegments(world, placed)
    const leftSeg = segs.find((s) => s.cardId === 't2')!
    expect(leftSeg.from[0]).toBeCloseTo(0.1 * 760, 5) // Starts at left end of passage
    expect(leftSeg.to[0]).toBe(-75) // Attaches to right edge of left-lane card
  })

  it('multiplies .highlight-layer directly onto .pdf-canvas (inside isolated .pdf-page) so PDF ink never fades, and separates overlapping multi-line rects', async () => {
    expect(highlighter('yellow')).toBe('rgba(252, 224, 85, 0.34)')
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    const pdfPageRule = /\.pdf-page\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const hlLayerRule = /\.highlight-layer\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    const hlLineRule = /\.highlight-line,\s*\.highlight-area\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(pdfPageRule).toContain('isolation: isolate')
    expect(hlLayerRule).toContain('mix-blend-mode: multiply')
    expect(hlLineRule).not.toContain('mix-blend-mode: multiply')
    const doc = {
      getPage: async () => ({
        getViewport: () => ({ width: 0, height: 0, scale: 1 }),
      }),
    } as unknown as PDFDocumentProxy
    const overlappingHighlight: PageHighlight = {
      key: 'hl-overlap',
      cardId: '',
      color: 'amber',
      area: false,
      highlighter: true,
      highlightColor: 'yellow',
      rects: [
        { x: 0.1, y: 0.2, width: 0.7, height: 0.022 },
        { x: 0.1, y: 0.22, width: 0.65, height: 0.022 }, // overlaps line 1 by 0.002!
      ],
    }
    await render(
      <PdfPageView
        doc={doc}
        pageNumber={1}
        box={{ x: 0, y: 0, width: 600, height: 800 }}
        renderScale={1}
        highlights={[overlappingHighlight]}
        knots={[]}
        tool="select"
        register={noop}
        onAreaSelected={noop}
        onHighlightClick={noop}
        onTextless={noop}
      />,
    )
    const lines = host.querySelectorAll<HTMLElement>('.highlight-line.is-highlighter')
    expect(lines).toHaveLength(2)
    const top1 = Number.parseFloat(lines[0]!.style.top)
    const height1 = Number.parseFloat(lines[0]!.style.height)
    const top2 = Number.parseFloat(lines[1]!.style.top)
    expect(top1 + height1).toBeLessThan(top2)
  })
})
