import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { GEOMETRY } from './geometry'
import type { YarnCard } from './types'
import { YarnCardView } from './YarnCardView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// jsdom measures nothing: the card's height report is not part of these tests.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

const card: YarnCard = {
  id: 'c1',
  bookId: 'b',
  color: 'coral',
  kind: 'coral',
  anchors: [],
  x: 835,
  y: 200,
  width: 400,
  isPinned: false,
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: 'm1', role: 'assistant', content: 'Yanıt', createdAt: 1 }],
}

async function render(scale: number) {
  const onResize = vi.fn()
  const onResizeFrom = vi.fn()
  const onDragLive = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const noop = () => undefined
  await act(async () =>
    root.render(
      <I18nProvider lang="tr">
        <YarnCardView
          card={card}
          x={card.x}
          y={card.y}
          scale={() => scale}
          onHeight={noop}
          onAsk={noop}
          onRetry={noop}
          onStop={noop}
          onRemove={noop}
          onMove={noop}
          onDragLive={onDragLive}
          onResize={onResize}
          onResizeFrom={onResizeFrom}
          onUnpin={noop}
          onCollapse={noop}
          onOpenSettings={noop}
          onFocusCard={noop}
          onSaveToJournal={noop}
        />
      </I18nProvider>,
    ),
  )
  return { onResize, onResizeFrom, onDragLive }
}

const Pointer = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent
const fire = (el: Element, type: string, clientX: number) =>
  act(() => {
    el.dispatchEvent(new Pointer(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 10 }))
  })

// Owner, 16 Nov: a card can be widened from its left or right side.
describe('card side edges', () => {
  it('the right edge changes the width only, within the limits, at the camera’s zoom', async () => {
    const { onResize, onResizeFrom } = await render(2)
    const right = host.querySelector('.yarn-card-edge.is-right')!
    expect(right.getAttribute('aria-label')).toBe('Genişliği değiştir')
    fire(right, 'pointerdown', 100)
    fire(right, 'pointermove', 300) // 200 screen px at ×2 = 100 world units
    fire(right, 'pointerup', 300)
    expect(onResize).toHaveBeenCalledWith('c1', 500, undefined)
    expect(onResizeFrom).not.toHaveBeenCalled()
    fire(right, 'pointerdown', 100)
    fire(right, 'pointermove', 2000)
    fire(right, 'pointerup', 2000)
    expect(onResize).toHaveBeenLastCalledWith('c1', 640, undefined)
  })

  it('the left edge keeps the right edge where it is', async () => {
    const { onResize, onResizeFrom, onDragLive } = await render(1)
    const left = host.querySelector('.yarn-card-edge.is-left')!
    fire(left, 'pointerdown', 500)
    fire(left, 'pointermove', 450) // 50 world units wider, to the left
    expect(onDragLive).toHaveBeenLastCalledWith('c1', { x: 785, y: 200 })
    fire(left, 'pointerup', 450)
    expect(onResizeFrom).toHaveBeenCalledWith('c1', 450, 835 + 400, 200)
    expect(onDragLive).toHaveBeenLastCalledWith('c1', null)
    expect(onResize).not.toHaveBeenCalled()
  })

  it('a double click on an edge returns to the natural width', async () => {
    const { onResize } = await render(1)
    act(() => {
      host.querySelector('.yarn-card-edge.is-left')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onResize).toHaveBeenCalledWith('c1', GEOMETRY.cardWidth, undefined)
  })
})
