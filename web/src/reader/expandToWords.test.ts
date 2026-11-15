import { describe, expect, it } from 'vitest'
import { expandToWords } from './selection'

function rangeIn(text: string, start: number, end: number) {
  const span = document.createElement('span')
  span.textContent = text
  document.body.append(span)
  const node = span.firstChild!
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return { range, done: () => span.remove() }
}

// Owner test 15 Nov: a highlight began and ended mid-word ("r. Bu çaba … bırakm").
describe('Highlights cover whole words', () => {
  it('widens a range that starts and ends inside words', () => {
    const text = 'saglar. Bu çaba, bilginin zihinde daha sağlam bir iz bırakmasını sağlar.'
    const { range, done } = rangeIn(text, text.indexOf('r. Bu'), text.indexOf('asını'))
    expect(expandToWords(range).toString()).toBe('saglar. Bu çaba, bilginin zihinde daha sağlam bir iz bırakmasını')
    done()
  })

  it('leaves a range on word boundaries as it is', () => {
    const text = 'Dikkat sınırlı bir kaynaktır.'
    const { range, done } = rangeIn(text, 0, 'Dikkat sınırlı'.length)
    expect(expandToWords(range).toString()).toBe('Dikkat sınırlı')
    done()
  })

  it('reads a word split over several spans as one word', () => {
    const layer = document.createElement('div')
    for (const part of ['YAVA', 'Ş', ' ', 'OKUMANIN', ' ', 'SANATI']) {
      const span = document.createElement('span')
      span.textContent = part
      layer.append(span)
    }
    document.body.append(layer)
    const range = document.createRange()
    range.setStart(layer.children[1]!.firstChild!, 0) // "Ş" (mid-word)
    range.setEnd(layer.children[3]!.firstChild!, 3) // "OKU|MANIN"
    expect(expandToWords(range, layer).toString()).toBe('YAVAŞ OKUMANIN')
    layer.remove()
  })
})
