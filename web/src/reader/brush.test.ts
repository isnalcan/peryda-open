import { afterEach, describe, expect, it } from 'vitest'
import { brushCaretAt, lastLineRight, pointOnText } from './brush'

// Owner test 15 Nov: the brush seemed not to work on the web. A stroke begun in the page margin fell
// back to the browser's own selection, and a stroke pulled past the end of the text snapped to the
// page's first line, selecting the whole page; no thread was made.

/** A text layer with one line of text at x 100…300, y 10…20; the "browser" places carets on it only there. */
function page() {
  const layer = document.createElement('div')
  const span = document.createElement('span')
  span.textContent = 'Kavramlar sınırlarda netleşir.'
  layer.append(span)
  document.body.append(layer)
  span.getBoundingClientRect = () => ({ left: 100, right: 300, top: 10, bottom: 20, width: 200, height: 10, x: 100, y: 10, toJSON: () => ({}) })
  const text = span.firstChild!
  ;(document as unknown as { caretPositionFromPoint: (x: number, y: number) => unknown }).caretPositionFromPoint = (x: number, y: number) =>
    x >= 100 && x <= 300 && y >= 10 && y <= 20
      ? { offsetNode: text, offset: Math.round(((x - 100) / 200) * text.textContent!.length) }
      : // Off the text the browser gives the layer itself (or its first line), as Chromium does.
        { offsetNode: layer, offset: 0 }
  return { layer, text }
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint
})

describe('Brush hit-testing', () => {
  it('takes a caret on the text as it is', () => {
    const { layer, text } = page()
    expect(brushCaretAt(200, 15, layer)).toEqual({ node: text, offset: 15 })
  })

  it('past the end of a line keeps to that line, at its end', () => {
    const { layer, text } = page()
    expect(brushCaretAt(420, 15, layer)).toEqual({ node: text, offset: text.textContent!.length })
  })

  it('a stroke begun in the margin starts at the line, never at the page', () => {
    const { layer, text } = page()
    expect(brushCaretAt(70, 15, layer, true)).toEqual({ node: text, offset: 0 })
    // While painting, the margin to the left gives nothing (the stroke does not jump back).
    expect(brushCaretAt(70, 15, layer)).toBeNull()
  })

  it('refuses a caret off the row', () => {
    const { layer } = page()
    expect(brushCaretAt(200, 60, layer, true)).toBeNull()
  })

  it('measures the pull from the last painted line, not the widest one', () => {
    expect(lastLineRight([{ right: 500, bottom: 20, width: 400 }, { right: 220, bottom: 40, width: 120 }])).toBe(220)
    expect(lastLineRight([])).toBeNull()
    expect(pointOnText({ left: 0, right: 10, top: 0, bottom: 10 }, 11, 5)).toBe(true)
    expect(pointOnText({ left: 0, right: 10, top: 0, bottom: 10 }, 15, 5)).toBe(false)
  })
})
