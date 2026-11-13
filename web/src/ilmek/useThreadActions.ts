import { useCallback, useRef, useState } from 'react'
import { db, newId } from '../data/db'
import type { Strings } from '../i18n/strings'
import type { PdfYarnAnchor, YarnCard } from './types'

interface Options {
  bookId: string
  cards: readonly YarnCard[]
  t: Strings
}

/** Journal, clipping and the short notice line, shared by the PDF and EPUB readers. */
export function useThreadActions({ bookId, cards, t }: Options) {
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  const clip = useCallback(
    async (anchors: readonly PdfYarnAnchor[]) => {
      const quote = anchors.map((a) => a.selectedText).filter(Boolean).join(' … ')
      await db.journal.put({ id: newId(), bookId, source: 'clip', quote, text: '', pageNumber: anchors[0]?.pageNumber ?? 0, createdAt: Date.now() })
      showToast(t.clipped)
    },
    [bookId, showToast, t.clipped],
  )

  // Read through a ref so the callback stays the same while answers stream in.
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const saveToJournal = useCallback(
    (cardId: string) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card) return
      const quote = card.anchors.map((a) => a.selectedText).filter(Boolean).join(' … ')
      const usable = card.messages.filter((m) => m.state !== 'error' && m.content.trim())
      const text =
        card.kind === 'cream'
          ? usable.map((m) => m.content).join('\n\n')
          : usable
              .filter((m, i) => m.role === 'assistant' || (i > 0 && m.role === 'user'))
              .map((m) => (m.role === 'user' ? `**${m.content}**` : m.content))
              .join('\n\n')
      const pageNumber = card.anchors.find((a) => a.sourceType !== 'card')?.pageNumber ?? 0
      void db.journal
        .put({ id: newId(), bookId, source: card.kind === 'cream' ? 'note' : 'thread', quote, text, pageNumber, cardId, createdAt: Date.now() })
        .then(() => showToast(t.savedToJournal))
    },
    [bookId, showToast, t.savedToJournal],
  )

  return { toast, showToast, clip, saveToJournal }
}
