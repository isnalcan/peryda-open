import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getPref, newId, setPref, type JournalRecord } from '../data/db'
import type { Strings } from '../i18n/strings'
import type { PdfYarnAnchor, YarnCard } from './types'
import type { HighlightColor } from '../reader/highlightColors'

interface Options {
  bookId: string
  cards: readonly YarnCard[]
  t: Strings
}

/** A region of a page sent as a picture: its own text (read from a scan) is not shown. */
export function isPictureArea(anchor: PdfYarnAnchor): boolean {
  return anchor.sourceType === 'pdf_area' && !!anchor.croppedImage
}

/**
 * What a card puts in the journal: its passage and its conversation (or note). A page area is named by
 * `areaQuote` ("Area selected on the page") instead of the text read from its picture (owner test 15 Nov).
 */
export function journalContent(card: YarnCard, areaQuote = ''): { quote: string; text: string } {
  const quote = card.anchors
    .map((a) => (isPictureArea(a) ? areaQuote : a.selectedText))
    .filter(Boolean)
    .join(' … ')
  const usable = card.messages.filter((m) => m.state !== 'error' && m.content.trim())
  const text =
    card.kind === 'cream'
      ? usable.map((m) => m.content).join('\n\n')
      : usable
          .filter((m, i) => m.role === 'assistant' || (i > 0 && m.role === 'user'))
          .map((m) => (m.role === 'user' ? `**${m.content}**` : m.content))
          .join('\n\n')
  return { quote, text }
}

export type JournalState = 'notSaved' | 'saved' | 'outdated'

/** Whether a card is in the journal, and if so whether its conversation went on since. */
export function journalState(card: YarnCard, entries: readonly JournalRecord[], areaQuote = ''): JournalState {
  const entry = entries.find((e) => e.cardId === card.id)
  if (!entry) return 'notSaved'
  const now = journalContent(card, areaQuote)
  return entry.text === now.text && entry.quote === now.quote ? 'saved' : 'outdated'
}

/** Card text sizes (×1 as designed), one per step of the − and + in a card's header. */
export const CARD_TEXT_SCALES: readonly number[] = [0.85, 1, 1.15, 1.3, 1.5, 1.75]

/** One step smaller (−1) or larger (+1) than `scale`, within the steps. */
export function stepScale(scale: number, delta: number): number {
  const here = CARD_TEXT_SCALES.reduce<number>((best, s, i) => (Math.abs(s - scale) < Math.abs(CARD_TEXT_SCALES[best]! - scale) ? i : best), 1)
  return CARD_TEXT_SCALES[Math.min(Math.max(here + delta, 0), CARD_TEXT_SCALES.length - 1)]!
}

const NO_ENTRIES: JournalRecord[] = []

/** Journal, clipping, card text size and the short notice line, shared by the PDF and EPUB readers. */
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

  /**
   * "Vurgula": the passage is highlighted on its page in the chosen colour (yellow unless another was
   * chosen, owner 16 Nov) and goes into the journal as a highlight; deleting that entry removes the
   * highlight (owner test 15 Nov). PDF text only.
   */
  const highlight = useCallback(
    async (anchors: readonly PdfYarnAnchor[], color: HighlightColor = 'yellow') => {
      const text = anchors.filter((a) => a.sourceType === 'pdf_text' && a.lineRects.length)
      if (!text.length) return
      const quote = text.map((a) => a.selectedText).filter(Boolean).join(' … ')
      const marks = text.map((a) => ({ pageNumber: a.pageNumber, lineRects: a.lineRects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })) }))
      await db.journal.put({
        id: newId(),
        bookId,
        source: 'highlight',
        quote,
        text: '',
        pageNumber: text[0]!.pageNumber,
        marks,
        ...(color === 'yellow' ? {} : { highlightColor: color }),
        createdAt: Date.now(),
      })
      showToast(t.highlighted)
    },
    [bookId, showToast, t.highlighted],
  )

  // The book's journal entries, to show which cards are in it.
  const entries = useLiveQuery(() => db.journal.where('bookId').equals(bookId).toArray(), [bookId], NO_ENTRIES)
  const journalStates = useMemo(() => new Map(cards.map((c) => [c.id, journalState(c, entries, t.areaQuote)])), [cards, entries, t.areaQuote])

  // Read through refs so the callback stays the same while answers stream in.
  const cardsRef = useRef(cards)
  cardsRef.current = cards
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  /**
   * A card goes into the journal once (owner test 14 Nov: it could be saved again and again). Saved
   * again after the conversation went on, its one entry is brought up to date instead.
   */
  const saveToJournal = useCallback(
    (cardId: string) => {
      const card = cardsRef.current.find((c) => c.id === cardId)
      if (!card) return
      const { quote, text } = journalContent(card, t.areaQuote)
      const entry = entriesRef.current.find((e) => e.cardId === cardId)
      if (entry) {
        if (entry.text === text && entry.quote === quote) return
        void db.journal.update(entry.id, { quote, text }).then(() => showToast(t.journalUpdated))
        return
      }
      const pageNumber = card.anchors.find((a) => a.sourceType !== 'card')?.pageNumber ?? 0
      void db.journal
        .put({ id: newId(), bookId, source: card.kind === 'cream' ? 'note' : 'thread', quote, text, pageNumber, cardId, createdAt: Date.now() })
        .then(() => showToast(t.savedToJournal))
    },
    [bookId, showToast, t.savedToJournal, t.journalUpdated, t.areaQuote],
  )

  // The size of the text in this book's cards, kept per book: some PDFs leave the cards small beside
  // large pages (owner test 14 Nov).
  const [cardTextScale, setCardTextScale] = useState(1)
  useEffect(() => {
    let live = true
    void getPref<number>(`cardTextScale:${bookId}`, 1).then((s) => {
      if (live) setCardTextScale(CARD_TEXT_SCALES.includes(s) ? s : 1)
    })
    return () => {
      live = false
    }
  }, [bookId])
  const stepCardText = useCallback(
    (delta: number) => {
      setCardTextScale((s) => {
        const next = stepScale(s, delta)
        void setPref(`cardTextScale:${bookId}`, next)
        return next
      })
    },
    [bookId],
  )

  // The size of translated pages' text (×1 is the size the page fits to), kept per book like the cards'
  // (owner test 15 Nov).
  const [translationTextScale, setTranslationTextScale] = useState(1)
  useEffect(() => {
    let live = true
    void getPref<number>(`translationTextScale:${bookId}`, 1).then((s) => {
      if (live) setTranslationTextScale(CARD_TEXT_SCALES.includes(s) ? s : 1)
    })
    return () => {
      live = false
    }
  }, [bookId])
  const stepTranslationText = useCallback(
    (delta: number) => {
      setTranslationTextScale((s) => {
        const next = stepScale(s, delta)
        void setPref(`translationTextScale:${bookId}`, next)
        return next
      })
    },
    [bookId],
  )

  // The reader's highlights, to draw on their pages.
  const highlightMarks = useMemo(() => entries.filter((e) => e.source === 'highlight' && e.marks?.length), [entries])

  return { toast, showToast, clip, highlight, highlightMarks, saveToJournal, journalStates, cardTextScale, stepCardText, translationTextScale, stepTranslationText }
}
