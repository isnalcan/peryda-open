import { useCallback, useRef } from 'react'
import { CONTEXT_LENGTH } from '../ai/compose'
import type { YarnCard } from '../ilmek/types'
import { normalizeText } from './selection'

/**
 * Reads a selection made inside a card (its answer, question or note) or a translated page: which
 * card, the text, where it is on screen, and the card's text as the new thread's context.
 */
export function useThreadSelection(cards: readonly YarnCard[]) {
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  return useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const start = range.startContainer
    const el = start.nodeType === Node.ELEMENT_NODE ? (start as HTMLElement) : start.parentElement
    const cardId = el?.closest<HTMLElement>('[data-thread-source]')?.dataset.threadSource
    const text = normalizeText(selection.toString())
    if (!cardId || !text) return null
    return { cardId, text, rect: range.getBoundingClientRect(), context: cardText(cardsRef.current, cardId) }
  }, [])
}

/** What a thread opened inside a card is read with: the card's answer (or note, or translation). */
export function cardText(cards: readonly YarnCard[], cardId: string): string | undefined {
  const card = cards.find((c) => c.id === cardId)
  if (!card) return undefined
  const answer = [...card.messages].reverse().find((m) => m.role === 'assistant' && m.state !== 'error' && m.content.trim())
  const text = answer?.content ?? card.messages.find((m) => m.role === 'user')?.content
  return text ? text.slice(0, CONTEXT_LENGTH) : undefined
}
