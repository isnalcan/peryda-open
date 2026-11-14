import { describe, expect, it } from 'vitest'
import type { JournalRecord } from '../data/db'
import { findTextRanges, threadMarks } from './threadMarks'
import type { YarnCard } from './types'
import { CARD_TEXT_SCALES, journalContent, journalState, stepScale } from './useThreadActions'

function card(partial: Partial<YarnCard> & { id: string }): YarnCard {
  return {
    bookId: 'b',
    color: 'mint',
    kind: 'mint',
    anchors: [{ id: 'a1', sourceType: 'pdf_text', bookId: 'b', pageNumber: 3, selectedText: 'Dikkat sınırlı bir kaynaktır.', lineRects: [], boundingRect: { x: 0, y: 0, width: 0, height: 0 } }],
    x: 0,
    y: 0,
    width: 400,
    isPinned: false,
    collapsed: false,
    messages: [
      { id: 'm1', role: 'user', content: 'Sadeleştir', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Zihnin aynı anda taşıyabileceği şey azdır.', createdAt: 2 },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...partial,
  } as YarnCard
}

describe('journal state (owner test 14 Nov: a card could be saved again and again)', () => {
  it('is saved once, and goes out of date when the conversation goes on', () => {
    const c = card({ id: 'c1' })
    const { quote, text } = journalContent(c)
    expect(text).toBe('Zihnin aynı anda taşıyabileceği şey azdır.')
    expect(journalState(c, [])).toBe('notSaved')
    const entry: JournalRecord = { id: 'j1', bookId: 'b', source: 'thread', quote, text, pageNumber: 3, cardId: 'c1', createdAt: 3 }
    expect(journalState(c, [entry])).toBe('saved')
    const more = card({
      id: 'c1',
      messages: [...c.messages, { id: 'm3', role: 'user', content: 'Bir örnek?', createdAt: 4 }, { id: 'm4', role: 'assistant', content: 'Örnek.', createdAt: 5 }],
    })
    expect(journalState(more, [entry])).toBe('outdated')
    expect(journalContent(more).text).toContain('**Bir örnek?**')
    expect(journalState(more, [{ ...entry, cardId: 'other' }])).toBe('notSaved')
  })
})

describe('card text size', () => {
  it('steps through the sizes and stops at both ends', () => {
    expect(stepScale(1, 1)).toBe(1.15)
    expect(stepScale(1, -1)).toBe(0.85)
    expect(stepScale(0.85, -1)).toBe(0.85)
    expect(stepScale(1.75, 1)).toBe(1.75)
    expect(stepScale(1.2, 1)).toBe(1.3)
    expect(CARD_TEXT_SCALES[0]).toBeLessThan(1)
  })
})

describe('thread marks (owner test 14 Nov: passages in cards were not marked)', () => {
  it('lists passages selected inside cards and translated pages, in the thread colour', () => {
    const parent = card({ id: 'p' })
    const child = card({
      id: 'c',
      color: 'lavender',
      anchors: [{ id: 'a2', sourceType: 'card', bookId: 'b', pageNumber: 0, selectedText: 'taşıyabileceği şey', lineRects: [], boundingRect: { x: 10, y: 80, width: 50, height: 16 }, sourceCardId: 'p' }],
    })
    expect(threadMarks([parent, child])).toEqual([{ sourceCardId: 'p', text: 'taşıyabileceği şey', color: 'lavender', nearY: 80 }])
    expect(threadMarks([parent]), 'a deleted thread takes its mark along').toEqual([])
  })

  it('finds a passage across paragraphs and inline markup, ignoring spaces and line breaks', () => {
    // <p>Birinci <strong>paragraf</strong> burada.</p><ul><li>İkinci satır</li></ul><p>paragraf yine</p>
    const el = (tag: string, ...children: (Node | string)[]) => {
      const node = document.createElement(tag)
      node.append(...children)
      return node
    }
    const root = el('div', el('p', 'Birinci ', el('strong', 'paragraf'), ' burada.'), el('ul', el('li', 'İkinci satır')), el('p', 'paragraf yine'))
    const [first, second] = findTextRanges(root, 'paragraf burada. İkinci')
    expect(first?.toString()).toBe('paragraf burada.İkinci')
    expect(second).toBeUndefined()
    expect(findTextRanges(root, 'paragraf').map((r) => r.toString())).toEqual(['paragraf', 'paragraf'])
    expect(findTextRanges(root, '   ')).toEqual([])
    expect(findTextRanges(root, 'yok böyle bir şey')).toEqual([])
  })
})
