/**
 * İlmek data model shared in spirit with the Mac app (shared/schema). Coordinates on a page are
 * normalized to the page box with a top-left origin, so they do not depend on zoom or screen size.
 */

export type YarnColor = 'coral' | 'mint' | 'sky' | 'amber' | 'lavender' | 'cream'

export const YARN_COLORS: readonly YarnColor[] = ['coral', 'mint', 'sky', 'amber', 'lavender', 'cream']

/** 0..1 within the page box; origin at the top-left corner of the page. */
export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export type AnchorSource = 'pdf_text' | 'pdf_area' | 'card' | 'epub_text'

export interface PdfYarnAnchor {
  id: string
  sourceType: AnchorSource
  bookId: string
  /** 1-based page number. Unused for card anchors. */
  pageNumber: number
  /** The selected text, or the text found inside an area selection (may be empty). */
  selectedText: string
  /** One rectangle per selected line, for drawing the highlight. */
  lineRects: NormalizedRect[]
  /** Encloses the whole selection; the yarn leaves from the middle of its right edge. */
  boundingRect: NormalizedRect
  /** PNG data URL of an area selection, rendered at 2x. */
  croppedImage?: string
  /** For sourceType 'card': the card the selection was made in. */
  sourceCardId?: string
  /** For sourceType 'epub_text': the EPUB CFI range of the selection. pageNumber holds the chapter. */
  cfi?: string
  /** Text around the selection sent with it: the start of the page or chapter, or the parent card's answer. */
  context?: string
}

export interface YarnMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** Set while an answer is still streaming or when it failed. */
  state?: 'streaming' | 'error'
  provider?: 'gemini' | 'openai' | 'deepseek' | 'claude'
  model?: string
}

/** From the retired archive-link feature: still read so older backups load. */
export interface ArchiveLink {
  bookId: string
  bookTitle: string
  sourceId: string
  snippet: string
}

export interface YarnCard {
  id: string
  bookId: string
  color: YarnColor
  /** 'kind' is the quick action that opened the card; 'question' and 'bridge' are free questions. */
  kind: YarnColor | 'question' | 'bridge' | 'translate'
  anchors: PdfYarnAnchor[]
  parentCardId?: string
  /** World coordinates of the top-left corner; meaningful only when pinned. */
  x: number
  y: number
  width: number
  /** A height the reader set by resizing the card; absent means as tall as its content. */
  height?: number
  /** Whole-page translations: the page translated, its language, and the batch job it waits on. */
  translatedPage?: number
  translationLanguage?: string
  batchJob?: string
  isPinned: boolean
  collapsed: boolean
  messages: YarnMessage[]
  archiveLinks?: ArchiveLink[]
  archiveDismissed?: boolean
  createdAt: number
  updatedAt: number
}

export interface PageBox {
  /** World position and size of a page after stacking. */
  x: number
  y: number
  width: number
  height: number
}

export type Point = readonly [number, number]
