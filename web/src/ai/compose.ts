import prompts from '@shared/prompts.json'
import yarnKinds from '@shared/yarn-kinds.json'
import type { Lang } from '../i18n/strings'
import type { PdfYarnAnchor, YarnCard, YarnColor } from '../ilmek/types'
import type { AiPart, AiTurn } from './client'

/** Builds provider conversations from cards. Matches mac/PerydaKit/Sources/PerydaKit/AI/Compose.swift. */

export const LANGUAGE_NAMES: Record<Lang, string> = { tr: 'Türkçe', en: 'English', de: 'Deutsch', es: 'español' }

/** How much of the page (or parent card) travels with a selection as its context. */
export const CONTEXT_LENGTH = 1200

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, k: string) => (k in values ? String(values[k]) : match))
}

export function pageLabel(lang: Lang, page: number): string {
  return fill(prompts.pageLabel[lang], { page })
}

/** The page label as a heading or a link starts with a capital ("Sayfa 4"); prompts use it as written. */
export function pageTitle(lang: Lang, page: number): string {
  return pageLabel(lang, page).replace(/^\p{Ll}/u, (c) => c.toLocaleUpperCase(lang))
}

export function chapterLabel(lang: Lang, chapter: number): string {
  return fill(prompts.chapterLabel[lang], { chapter })
}

export function chapterTitle(lang: Lang, chapter: number): string {
  return chapterLabel(lang, chapter).replace(/^\p{Ll}/u, (c) => c.toLocaleUpperCase(lang))
}

export function anchorLocation(lang: Lang, anchor: PdfYarnAnchor): string {
  if (anchor.sourceType === 'card') return '—'
  return anchor.sourceType === 'epub_text' ? chapterLabel(lang, anchor.pageNumber) : pageLabel(lang, anchor.pageNumber)
}

/** The most of a book title that goes into a prompt. */
export const PROMPT_TITLE_LENGTH = 200

/**
 * A book title as it goes into a prompt. The title comes from the file (PDF info, EPUB metadata), so it
 * is kept to one plain line: no control characters or line breaks to start new "instructions", runs of
 * spaces collapsed, at most PROMPT_TITLE_LENGTH characters.
 */
export function promptTitle(title: string): string {
  const line = String(title ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...line]
  return chars.length > PROMPT_TITLE_LENGTH ? `${chars.slice(0, PROMPT_TITLE_LENGTH).join('').trimEnd()}…` : line
}

export function systemPrompt(lang: Lang, bookTitle: string, pages: number[]): string {
  const unique = [...new Set(pages)].sort((a, b) => a - b)
  const label = unique.length ? unique.map((p) => pageLabel(lang, p)).join(', ') : ''
  return fill(prompts.system[lang], { bookTitle: promptTitle(bookTitle), pageLabel: label, language: LANGUAGE_NAMES[lang] })
}

/** The system prompt for Pery's summary of the Book Journal. */
export function journalSummarySystem(lang: Lang, bookTitle: string): string {
  return fill(prompts.journalSummary[lang], { bookTitle: promptTitle(bookTitle) })
}

/** The instruction a quick action sends; empty for the reader's own note. */
export function kindPrompt(lang: Lang, kind: YarnCard['kind']): string {
  if (kind === 'bridge') return yarnKinds.bridge.prompt[lang]
  if (kind === 'translate') return fill(yarnKinds.translate.prompt[lang], { language: LANGUAGE_NAMES[lang] })
  if (kind === 'question') return ''
  return yarnKinds.kinds[kind].prompt[lang]
}

export function kindTitle(lang: Lang, card: Pick<YarnCard, 'kind' | 'color'>): string {
  if (card.kind === 'bridge') return yarnKinds.bridge.cardTitle[lang]
  if (card.kind === 'translate') return yarnKinds.translate.cardTitle[lang]
  if (card.kind === 'question') return yarnKinds.custom.cardTitle[lang]
  return yarnKinds.kinds[card.kind].cardTitle[lang]
}

export function kindLabel(lang: Lang, color: YarnColor): string {
  return yarnKinds.kinds[color].label[lang]
}

export function runsAI(kind: YarnCard['kind']): boolean {
  return kind === 'question' || kind === 'bridge' || kind === 'translate' || yarnKinds.kinds[kind].runsAI
}

/** A `data:` URL as an image part. */
export function imagePart(dataUrl: string): AiPart | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  return match ? { type: 'image', mimeType: match[1]!, base64: match[2]! } : null
}

function anchorParts(lang: Lang, anchors: readonly PdfYarnAnchor[]): AiPart[] {
  const parts: AiPart[] = []
  anchors.forEach((a, i) => {
    const header = fill(a.sourceType === 'pdf_area' ? prompts.areaHeader[lang] : prompts.passageHeader[lang], {
      index: i + 1,
      pageLabel: anchorLocation(lang, a),
    })
    parts.push({ type: 'text', text: `${header}\n${a.selectedText.trim() || '—'}` })
    const image = a.croppedImage?.startsWith('data:image/png;base64,') ? imagePart(a.croppedImage) : null
    if (image) parts.push(image)
  })
  return parts
}

/**
 * The first message of a thread: the selection, what surrounds it and the request, in one message; for
 * a region of a page, its picture first and a placeholder in place of the text.
 */
export function contextParts(lang: Lang, anchors: readonly PdfYarnAnchor[], request: string): AiPart[] {
  const parts: AiPart[] = []
  const area = anchors.find((a) => a.sourceType === 'pdf_area')
  const image = area?.croppedImage ? imagePart(area.croppedImage) : null
  if (image) parts.push(image)
  const selected = area
    ? fill(prompts.areaSelection[lang], { page: area.pageNumber })
    : anchors
        .map((a) => a.selectedText.trim())
        .filter(Boolean)
        .join(' ')
  const context = anchors.map((a) => a.context?.trim()).find(Boolean)
  parts.push({
    type: 'text',
    text: fill(prompts.contextTemplate[lang], { selected, context: context ? context.slice(0, CONTEXT_LENGTH) : '—', request }),
  })
  return parts
}

/**
 * Turns a card into a provider conversation: the first user turn carries the selection (with its
 * context) and the first instruction; later messages alternate as written. Failed answers are left out.
 */
export function composeTurns(lang: Lang, card: YarnCard): AiTurn[] {
  const turns: AiTurn[] = []
  const messages = card.messages.filter((m) => m.state !== 'error' && (m.role === 'user' || m.content.trim()))
  messages.forEach((m, i) => {
    if (i === 0 && m.role === 'user') {
      // A bridge compares two passages and keeps its headed form; every other thread sends the
      // selection, its context and the request together.
      const parts = card.kind === 'bridge' ? [...anchorParts(lang, card.anchors), { type: 'text' as const, text: m.content }] : contextParts(lang, card.anchors, m.content)
      turns.push({ role: 'user', parts })
    } else {
      turns.push({ role: m.role, parts: [{ type: 'text', text: m.content }] })
    }
  })
  // The provider must answer a user turn; drop a trailing assistant turn that is being regenerated.
  while (turns.length && turns[turns.length - 1]!.role === 'assistant') turns.pop()
  return turns
}

/**
 * Whole-page translation into `target`: the editor's rules. With `explainTerms` (the reader's choice,
 * on by default) hard terms get a short explanation in brackets; without it the same rules leave that out.
 */
export function pageTranslationSystem(target: Lang, explainTerms = true): string {
  return (explainTerms ? prompts.pageTranslateSystem : prompts.pageTranslateSystemNoTerms)[target]
}

/** The page: its text, or its picture with an OCR-and-translate instruction when it has no text layer. */
export function pageTranslationTurns(target: Lang, file: string, page: number, pages: number, text: string, imageDataUrl?: string, explainTerms = true): AiTurn[] {
  const values = { file: promptTitle(file), page, pages: Math.max(pages, page) }
  const image = imageDataUrl ? imagePart(imageDataUrl) : null
  if (image) {
    const scanned = explainTerms ? prompts.pageTranslateScanned : prompts.pageTranslateScannedNoTerms
    return [{ role: 'user', parts: [image, { type: 'text', text: fill(scanned[target], values) }] }]
  }
  const instruction = explainTerms ? prompts.pageTranslate : prompts.pageTranslateNoTerms
  return [{ role: 'user', parts: [{ type: 'text', text: fill(instruction[target], { ...values, text }) }] }]
}

/** Reading a scanned page's text from its picture ("extract page text" without a text layer). */
export function pageTranscriptionTurns(lang: Lang, file: string, page: number, pages: number, imageDataUrl: string): AiTurn[] {
  const image = imagePart(imageDataUrl)
  const text = fill(prompts.pageTranscribe[lang], { file: promptTitle(file), page, pages: Math.max(pages, page) })
  return [{ role: 'user', parts: image ? [image, { type: 'text', text }] : [{ type: 'text', text }] }]
}

export function pageTranscriptionSystem(lang: Lang): string {
  return prompts.pageTranscribeSystem[lang]
}
