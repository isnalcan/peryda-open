import yarnKinds from '@shared/yarn-kinds.json'
import { db, newId } from '../data/db'
import { AiError, streamAnswer, type AiRequest } from '../ai/client'
import { fakeStream } from '../ai/fake'
import { JobGone, abandonBatchJob, geminiBatch, isBatchName, type BatchItem, type PageBatching } from '../ai/batch'
import { composeTurns, kindPrompt, pageTranslationSystem, pageTranslationTurns, runsAI, systemPrompt } from '../ai/compose'
import { ModelAdvice, keyFor, modelFor, resolveActiveProvider, type ByokSettings, type ProviderId } from '../ai/provider'
import type { Lang } from '../i18n/strings'
import { GEOMETRY } from './geometry'
import type { PdfYarnAnchor, YarnCard, YarnColor, YarnMessage } from './types'

/**
 * Threads of one book: create, stream answers, continue, stop, retry, fold, pin, resize, remove; and
 * whole-page translations. Mirrors the Mac app's CardsModel (mac/PerydaKit/.../Ilmek/CardsModel.swift).
 * Plain TypeScript so it can be tested without React; `useCards` subscribes to it.
 */

export type Streamer = (request: AiRequest) => AsyncGenerator<string>

export interface CardsOptions {
  bookId: string
  bookTitle: string
  lang: Lang
  settings: ByokSettings
  streamer?: Streamer
  batcher?: PageBatching
  /** Development only: answer with canned text instead of a provider. */
  fake?: boolean
}

export type CreateCardInput = {
  color: YarnColor
  kind: YarnCard['kind']
  anchors: PdfYarnAnchor[]
  parentCardId?: string
  /** Free question or the reader's note. Quick actions use their built-in instruction. */
  text?: string
}

/** A page to translate: its text layer, or (for a scanned page) its picture. */
export interface PageSource {
  page: number
  text: string
  imageDataUrl?: string
  width: number
  height: number
}

/** Limits for resizing a card by its corner, in world units. */
export const CARD_WIDTH_RANGE = [300, 640] as const
export const CARD_HEIGHT_RANGE = [150, 1000] as const

/** Up to two pages are translated directly, in parallel; more go to Gemini as one batch job, or in waves. */
export const DIRECT_LIMIT = 2
export const WAVE_SIZE = 4
/** One request translates at most this many pages, so a slip of the finger cannot translate a whole book. */
export const RANGE_LIMIT = 200

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))

/**
 * Google takes at most 20 MB in one batch request sent inline. Text pages are a few kB, but a scanned
 * page travels as a picture (a few hundred kB), so a long scanned range is split into several jobs,
 * each kept well under the limit.
 */
export const BATCH_MAX_BYTES = 15_000_000

/** Roughly how many bytes one page adds to a batch request. */
export function batchItemBytes(item: BatchItem): number {
  let bytes = item.system.length + 512
  for (const turn of item.turns) for (const part of turn.parts) bytes += part.type === 'text' ? part.text.length * 2 : part.base64.length
  return bytes
}

/** Splits pages into consecutive groups that each stay under `maxBytes` (a page larger than that goes alone). */
export function splitBatch<T>(items: readonly T[], sizeOf: (item: T) => number, maxBytes = BATCH_MAX_BYTES): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let size = 0
  for (const item of items) {
    const bytes = sizeOf(item)
    if (current.length && size + bytes > maxBytes) {
      groups.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += bytes
  }
  if (current.length) groups.push(current)
  return groups
}

/** A page translation with no answer yet (a failed one has its error as an answer). */
export function isUnfinishedTranslation(card: YarnCard): boolean {
  if (card.translatedPage === undefined) return false
  const last = card.messages[card.messages.length - 1]
  return !last || last.role === 'user' || last.state === 'streaming'
}

export class CardsStore {
  cards: YarnCard[] = []
  loaded = false
  bookTitle: string
  lang: Lang
  private currentSettings: ByokSettings
  /** The book's page count, for the "page n of m" line sent with a page. */
  pageCount = 0
  /** Page translations explain hard terms in brackets (the reader's choice; pages already translated keep theirs). */
  explainTerms = true
  readonly bookId: string

  private readonly streamer: Streamer
  private readonly batcher: PageBatching
  private readonly fake: boolean
  private listeners = new Set<() => void>()
  private controllers = new Map<string, AbortController>()
  private running = new Map<string, Promise<void>>()
  private background = new Set<Promise<unknown>>()
  /**
   * The batch submission each page translation is waiting for; a later choice (translate now, translate
   * again) replaces it, so a late reply from an older submission is ignored.
   */
  private submissions = new Map<string, symbol>()
  private disposed = false
  /** Bumped when the reader stops translating, so waves already planned do not go on. */
  private waveGeneration = 0

  constructor(options: CardsOptions) {
    this.bookId = options.bookId
    this.bookTitle = options.bookTitle
    this.lang = options.lang
    this.currentSettings = options.settings
    this.streamer = options.streamer ?? streamAnswer
    this.batcher = options.batcher ?? geminiBatch
    this.fake = options.fake ?? false
  }

  get settings(): ByokSettings {
    return this.currentSettings
  }

  /**
   * A new or removed Gemini key cannot ask about jobs made with the old one: those jobs are cancelled and
   * removed at Google with the old key, and their pages say so and can be translated again (audit
   * 15 Nov, K-3).
   */
  set settings(next: ByokSettings) {
    const before = keyFor(this.currentSettings, 'gemini')
    this.currentSettings = next
    if (!before || before === keyFor(next, 'gemini')) return
    const waiting = this.cards.filter((c) => c.batchJob)
    if (!waiting.length) return
    for (const job of new Set(waiting.map((c) => c.batchJob!))) this.track(abandonBatchJob(before, job, this.batcher).catch(() => undefined))
    for (const c of waiting) this.failTranslation(c.id, 'expired')
  }

  // ---- Subscription (React) ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.cards

  private commit(next: YarnCard[]) {
    this.cards = next
    for (const l of this.listeners) l()
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.background.add(promise)
    void promise.finally(() => this.background.delete(promise)).catch(() => undefined)
    return promise
  }

  private persist(card: YarnCard) {
    if (this.disposed) return
    this.track(db.cards.put(card).catch(() => undefined))
  }

  private patch(id: string, change: (card: YarnCard) => YarnCard, save = true): YarnCard | undefined {
    let updated: YarnCard | undefined
    const next = this.cards.map((c) => {
      if (c.id !== id) return c
      updated = { ...change(c), updatedAt: Date.now() }
      return updated
    })
    if (!updated) return undefined
    this.commit(next)
    if (save) this.persist(updated)
    return updated
  }

  /**
   * Loads the book's cards. An answer still streaming when the page closed: keep what arrived, or offer
   * a retry. A page translation waiting on a batch job keeps waiting; the job carries on at Google.
   */
  async load() {
    this.disposed = false
    const rows = await db.cards.where('bookId').equals(this.bookId).sortBy('createdAt')
    const repaired = rows.map((c) => ({
      ...c,
      messages: c.messages.map((m): YarnMessage => {
        if (m.state !== 'streaming' || c.batchJob) return m
        return m.content.trim() ? { ...m, state: undefined, content: `${m.content.trimEnd()} …` } : { ...m, state: 'error', content: 'network' }
      }),
    }))
    this.loaded = true
    this.commit(repaired)
  }

  /** Stops every running answer (the reader is closing). Batch jobs carry on at Google. */
  dispose() {
    this.disposed = true
    for (const c of this.controllers.values()) c.abort()
    this.controllers.clear()
  }

  // ---- Threads ----

  create = (input: CreateCardInput): YarnCard => {
    const now = Date.now()
    const firstText = input.text?.trim() || kindPrompt(this.lang, input.kind)
    const card: YarnCard = {
      id: newId(),
      bookId: this.bookId,
      color: input.color,
      kind: input.kind,
      anchors: input.anchors,
      parentCardId: input.parentCardId,
      x: 0,
      y: 0,
      width: GEOMETRY.cardWidth,
      isPinned: false,
      collapsed: false,
      messages: firstText ? [{ id: newId(), role: 'user', content: firstText, createdAt: now }] : [],
      createdAt: now,
      updatedAt: now,
    }
    this.commit([...this.cards, card])
    this.persist(card)
    if (runsAI(input.kind)) this.run(card.id)
    return card
  }

  ask = (cardId: string, text: string) => {
    const body = text.trim()
    const card = this.cards.find((c) => c.id === cardId)
    if (!body || !card) return
    this.patch(cardId, (c) => ({ ...c, messages: [...c.messages, { id: newId(), role: 'user', content: body, createdAt: Date.now() }] }))
    if (runsAI(card.kind)) this.run(cardId)
  }

  retry = (cardId: string) => {
    this.patch(cardId, (c) => ({ ...c, messages: c.messages.filter((m) => m.state !== 'error') }))
    this.run(cardId)
  }

  stop = (cardId: string) => this.controllers.get(cardId)?.abort()

  /** Removes a card and every thread opened from it. */
  remove = (cardId: string) => this.removeAll([cardId])

  /** Removes cards and every thread opened from them, in one step. */
  private removeAll(cardIds: readonly string[]) {
    const doomed = new Set(cardIds)
    let grew = true
    while (grew) {
      grew = false
      for (const c of this.cards) {
        if (c.parentCardId && doomed.has(c.parentCardId) && !doomed.has(c.id)) {
          doomed.add(c.id)
          grew = true
        }
      }
    }
    const jobs = this.cards.filter((c) => doomed.has(c.id) && c.batchJob).map((c) => c.batchJob!)
    for (const id of doomed) {
      this.controllers.get(id)?.abort()
      this.submissions.delete(id)
    }
    this.commit(this.cards.filter((c) => !doomed.has(c.id)))
    this.track(db.cards.bulkDelete([...doomed]).catch(() => undefined))
    for (const job of new Set(jobs)) this.releaseJob(job)
  }

  update = (cardId: string, change: Partial<Pick<YarnCard, 'isPinned' | 'collapsed' | 'x' | 'y' | 'color'>>) => {
    this.patch(cardId, (c) => ({ ...c, ...change }))
  }

  /** Resizes a card within the limits; no height lets it follow its content again. */
  resize = (cardId: string, width: number, height?: number) => {
    this.patch(cardId, (c) => {
      const next: YarnCard = { ...c, width: clamp(width, CARD_WIDTH_RANGE) }
      if (height === undefined) delete next.height
      else next.height = clamp(height, CARD_HEIGHT_RANGE)
      return next
    })
  }

  isStreaming = (cardId: string) => this.running.has(cardId)

  // ---- Whole-page translation ----

  pageTranslation(page: number, target: Lang): YarnCard | undefined {
    return this.cards.find((c) => c.translatedPage === page && c.translationLanguage === target)
  }

  /** Translates the pages that have no translation in `target` yet (at most RANGE_LIMIT); returns the new cards' ids. */
  translatePages = (sources: readonly PageSource[], target: Lang): string[] => {
    const now = Date.now()
    const created: YarnCard[] = []
    for (const s of sources.slice(0, RANGE_LIMIT)) {
      if (this.pageTranslation(s.page, target) || created.some((c) => c.translatedPage === s.page)) continue
      const anchor: PdfYarnAnchor = {
        id: newId(),
        sourceType: s.imageDataUrl ? 'pdf_area' : 'pdf_text',
        bookId: this.bookId,
        pageNumber: s.page,
        selectedText: s.text,
        lineRects: [],
        boundingRect: { x: 0, y: 0, width: 0, height: 0 },
        croppedImage: s.imageDataUrl,
      }
      created.push({
        id: newId(),
        bookId: this.bookId,
        color: (yarnKinds.translate.color as YarnColor) ?? 'sky',
        kind: 'translate',
        anchors: [anchor],
        x: 0,
        y: 0,
        width: s.width,
        height: s.height,
        translatedPage: s.page,
        translationLanguage: target,
        isPinned: false,
        collapsed: false,
        messages: [{ id: newId(), role: 'user', content: yarnKinds.translate.cardTitle[target], createdAt: now }],
        createdAt: now,
        updatedAt: now,
      })
    }
    if (!created.length) return []
    this.commit([...this.cards, ...created])
    for (const c of created) this.persist(c)
    const ids = created.map((c) => c.id)
    if (ids.length > DIRECT_LIMIT && !this.fake && resolveActiveProvider(this.settings) === 'gemini') this.submitBatch(ids)
    else this.runWaves(ids)
    return ids
  }

  /** Pages in waves of four at once; each page streams in as it is translated. */
  private runWaves(ids: readonly string[]) {
    const waves: string[][] = []
    for (let i = 0; i < ids.length; i += WAVE_SIZE) waves.push(ids.slice(i, i + WAVE_SIZE))
    const generation = this.waveGeneration
    this.track(
      (async () => {
        for (const wave of waves) {
          // Stopped by the reader (or the book closed): pages still waiting their turn never start.
          if (this.disposed || generation !== this.waveGeneration) return
          for (const id of wave) this.run(id)
          await Promise.all(wave.map((id) => this.running.get(id) ?? Promise.resolve()))
        }
      })(),
    )
  }

  /** The request for a page translation with the reader's provider and translation model. */
  private translationRequest(card: YarnCard, provider: ProviderId): AiRequest {
    const anchor = card.anchors[0]
    const target = (card.translationLanguage as Lang | undefined) ?? this.lang
    let model = modelFor(this.settings, provider, 'translation')
    // DeepSeek's reasoning model takes no pictures; scanned pages always go to deepseek-flash.
    if (provider === 'deepseek' && anchor?.croppedImage) model = 'deepseek-flash'
    return {
      provider,
      apiKey: keyFor(this.settings, provider),
      model,
      system: pageTranslationSystem(target, this.explainTerms),
      turns: pageTranslationTurns(target, this.bookTitle, card.translatedPage ?? anchor?.pageNumber ?? 1, this.pageCount, anchor?.selectedText ?? '', anchor?.croppedImage, this.explainTerms),
      maxOutputTokens: ModelAdvice.maxOutputTokens(provider, 'translation'),
      temperature: ModelAdvice.temperature('translation'),
      candidates: provider === 'gemini' ? ModelAdvice.geminiChain(model) : undefined,
    }
  }

  private submitBatch(ids: readonly string[]) {
    const key = keyFor(this.settings, 'gemini')
    const model = modelFor(this.settings, 'gemini', 'translation')
    for (const id of ids) {
      this.patch(id, (c) => ({
        ...c,
        messages: [...c.messages.slice(0, 1), { id: newId(), role: 'assistant', content: '', createdAt: Date.now(), state: 'streaming', provider: 'gemini', model }],
      }))
    }
    const items: BatchItem[] = []
    for (const id of ids) {
      const card = this.cards.find((c) => c.id === id)
      if (!card) continue
      const r = this.translationRequest(card, 'gemini')
      items.push({ key: id, system: r.system, turns: r.turns })
    }
    // One job per group that fits Google's size limit; each group goes on (or fails) on its own.
    for (const group of splitBatch(items, batchItemBytes)) this.submitGroup(key, model, group)
  }

  private submitGroup(key: string, model: string, items: BatchItem[]) {
    const ids = items.map((item) => item.key)
    const token = Symbol('submission')
    for (const id of ids) this.submissions.set(id, token)
    this.track(
      (async () => {
        let name: string
        try {
          name = await this.batcher.create(key, model, items)
        } catch (error) {
          // Never a silent fall back to full-price direct requests: each page says the batch could not
          // start, and its Retry translates that page directly.
          const code = error instanceof AiError && error.kind === 'key' ? 'key' : 'batch'
          for (const id of ids) if (this.submissions.get(id) === token) this.failTranslation(id, code)
          return
        }
        const still = ids.filter((id) => this.submissions.get(id) === token)
        if (!isBatchName(name)) {
          for (const id of still) this.failTranslation(id, 'batch')
          return
        }
        if (!still.length) {
          // Every page was closed or translated another way while the job was being made.
          this.track(abandonBatchJob(key, name, this.batcher).catch(() => undefined))
          return
        }
        for (const id of still) this.patch(id, (c) => ({ ...c, batchJob: name }))
        // The reader closed the book meanwhile: keep the job's name on the stored pages so it is collected later.
        if (this.disposed) for (const id of still) this.track(db.cards.update(id, { batchJob: name }).catch(() => undefined))
      })(),
    )
  }

  /**
   * Cancels and removes a batch job once no page waits on it any more (translated now, translated again,
   * closed), so Google stops working, and billing, for nothing.
   */
  private releaseJob(job: string | undefined) {
    if (!job || this.cards.some((c) => c.batchJob === job)) return
    this.track(abandonBatchJob(keyFor(this.settings, 'gemini'), job, this.batcher).catch(() => undefined))
  }

  private failTranslation(cardId: string, code: string) {
    this.patch(cardId, (c) => {
      const messages = [...c.messages]
      const i = messages.map((m) => m.role).lastIndexOf('assistant')
      if (i >= 0) messages[i] = { ...messages[i]!, state: 'error', content: code }
      else messages.push({ id: newId(), role: 'assistant', content: code, createdAt: Date.now(), state: 'error' })
      const next: YarnCard = { ...c, messages }
      delete next.batchJob
      return next
    })
  }

  /** Page translations that have not got their answer yet: waiting their turn, streaming in, or in a batch job. */
  get unfinishedTranslations(): YarnCard[] {
    return this.cards.filter(isUnfinishedTranslation)
  }

  /**
   * Stops every page translation still on its way in this book: pages waiting their turn, answers
   * streaming in and batch jobs at Google (cancelled and removed there). Pages already translated
   * stay. Returns how many pages were stopped.
   */
  stopTranslations = (): number => {
    this.waveGeneration += 1
    const ids = this.unfinishedTranslations.map((c) => c.id)
    if (ids.length) this.removeAll(ids)
    return ids.length
  }

  /** Page translations still waiting on a batch job. */
  get waitingTranslations(): YarnCard[] {
    return this.cards.filter((c) => c.batchJob && c.messages[c.messages.length - 1]?.state === 'streaming')
  }

  /** A page translation sent and waiting for its answer (directly or in a batch). */
  get hasPendingTranslation(): boolean {
    return this.cards.some((c) => c.translatedPage !== undefined && c.messages[c.messages.length - 1]?.state === 'streaming')
  }

  /** Asks Google about every batch job this book is waiting on and fills in what has finished. */
  pollBatches = async () => {
    const key = keyFor(this.settings, 'gemini')
    if (key.length <= 10) return
    const now = Date.now()
    const jobs = new Set(this.waitingTranslations.map((c) => c.batchJob!))
    for (const job of jobs) {
      const waiting = this.waitingTranslations.filter((c) => c.batchJob === job)
      // Only a name Google could have given goes into a request (a backup may carry anything).
      if (!isBatchName(job)) {
        for (const c of waiting) this.failTranslation(c.id, 'expired')
        continue
      }
      let status
      try {
        status = await this.batcher.status(key, job)
      } catch (error) {
        if (error instanceof AiError && error.kind === 'key') {
          for (const c of waiting) this.failTranslation(c.id, 'key')
        } else if (error instanceof JobGone) {
          for (const c of waiting) this.failTranslation(c.id, 'expired')
        } else if (Math.min(...waiting.map((c) => c.createdAt)) < now - 48 * 3600 * 1000) {
          // A network hiccup: ask again next time, unless Google's 48-hour limit has passed.
          for (const c of waiting) this.failTranslation(c.id, 'expired')
        }
        continue
      }
      if (status.state === 'waiting') continue
      if (status.state === 'failed') {
        for (const c of waiting) this.failTranslation(c.id, status.code)
        this.track(this.batcher.delete(key, job).catch(() => undefined))
        continue
      }
      for (const c of waiting) {
        const text = status.texts[c.id]
        if (text === undefined) {
          this.failTranslation(c.id, status.errors[c.id] ?? 'unknown')
          continue
        }
        this.patch(c.id, (card) => {
          const messages = [...card.messages]
          const i = messages.map((m) => m.role).lastIndexOf('assistant')
          if (i >= 0) messages[i] = { ...messages[i]!, content: text.trim(), state: undefined }
          const next: YarnCard = { ...withoutPageImage(card), messages }
          delete next.batchJob
          return next
        })
      }
      // The results are copied into the pages; the job (pages and translations) need not stay at Google.
      this.track(this.batcher.delete(key, job).catch(() => undefined))
    }
  }

  /**
   * Stops waiting for the batch and translates this page straight away. `source` gives the page again
   * when its picture was dropped after an earlier translation.
   */
  translateNow = (cardId: string, source?: PageSource) => {
    const job = this.cards.find((c) => c.id === cardId)?.batchJob
    this.submissions.delete(cardId)
    this.patch(cardId, (c) => {
      const next: YarnCard = { ...c, messages: c.messages.filter((m) => m.role !== 'assistant') }
      delete next.batchJob
      if (source && next.anchors[0]) {
        const anchor: PdfYarnAnchor = { ...next.anchors[0], selectedText: source.text, sourceType: source.imageDataUrl ? 'pdf_area' : 'pdf_text' }
        if (source.imageDataUrl) anchor.croppedImage = source.imageDataUrl
        else delete anchor.croppedImage
        next.anchors = [anchor, ...next.anchors.slice(1)]
      }
      return next
    })
    this.releaseJob(job)
    this.run(cardId)
  }

  /** Translates a page again, directly. */
  retranslate = (cardId: string, source?: PageSource) => this.translateNow(cardId, source)

  /** A scanned page whose picture was dropped after its translation; it must be drawn again to be re-sent. */
  needsPageImage(cardId: string): boolean {
    const anchor = this.cards.find((c) => c.id === cardId)?.anchors[0]
    return anchor?.sourceType === 'pdf_area' && !anchor.croppedImage
  }

  // ---- Streaming ----

  private run(cardId: string) {
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) return
    const answerId = newId()
    this.patch(cardId, (c) => ({ ...c, messages: [...c.messages, { id: answerId, role: 'assistant', content: '', createdAt: Date.now(), state: 'streaming' }] }), false)
    const provider = resolveActiveProvider(this.settings)
    if (!provider && !this.fake) {
      this.setAnswer(cardId, answerId, 'no-key', 'error')
      return
    }
    const p = provider ?? 'gemini'
    let request: AiRequest
    if (card.translatedPage !== undefined) {
      request = this.translationRequest(card, p)
    } else {
      const pages = card.anchors.filter((a) => a.sourceType !== 'card').map((a) => a.pageNumber)
      const model = modelFor(this.settings, p, 'thread')
      request = {
        provider: p,
        apiKey: keyFor(this.settings, p),
        model,
        system: systemPrompt(this.lang, this.bookTitle, pages),
        turns: composeTurns(this.lang, card),
        maxOutputTokens: ModelAdvice.maxOutputTokens(p, 'thread'),
        temperature: ModelAdvice.temperature('thread'),
        candidates: p === 'gemini' ? ModelAdvice.geminiChain(model) : undefined,
      }
    }
    this.stream(cardId, answerId, request, card.translatedPage !== undefined)
  }

  private stream(cardId: string, answerId: string, request: AiRequest, translation: boolean) {
    this.controllers.get(cardId)?.abort()
    const controller = new AbortController()
    this.controllers.set(cardId, controller)
    const task = (async () => {
      let text = ''
      let lastSave = Date.now()
      try {
        const source = this.fake ? fakeStream(controller.signal, translation) : this.streamer({ ...request, signal: controller.signal })
        for await (const piece of source) {
          if (controller.signal.aborted) throw new AiError('aborted', 'aborted')
          text += piece
          const save = Date.now() - lastSave > 1500
          if (save) lastSave = Date.now()
          this.setAnswer(cardId, answerId, text, 'streaming', save)
        }
        if (controller.signal.aborted) throw new AiError('aborted', 'aborted')
        this.setAnswer(cardId, answerId, text, undefined, true, request.provider, request.model)
        if (translation && this.cards.find((c) => c.id === cardId)?.anchors[0]?.croppedImage) this.patch(cardId, withoutPageImage)
      } catch (error) {
        const kind = error instanceof AiError ? error.kind : 'unknown'
        if (kind === 'aborted' && text) this.setAnswer(cardId, answerId, text, undefined)
        else this.setAnswer(cardId, answerId, kind, 'error')
      } finally {
        // A newer run for the same card has its own controller; only this run's entries are cleared.
        if (this.controllers.get(cardId) === controller) {
          this.controllers.delete(cardId)
          this.running.delete(cardId)
        }
      }
    })()
    this.running.set(cardId, task)
  }

  private setAnswer(cardId: string, messageId: string, content: string, state: YarnMessage['state'], save = true, provider?: ProviderId, model?: string) {
    this.patch(
      cardId,
      (c) => ({
        ...c,
        messages: c.messages.map((m) => {
          if (m.id !== messageId) return m
          const next: YarnMessage = { ...m, content, state }
          if (!state) delete next.state
          if (provider) next.provider = provider
          if (model) next.model = model
          return next
        }),
      }),
      save || state !== 'streaming',
    )
  }

  /** Waits until every running answer and background step has finished (tests). */
  async waitForIdle() {
    while (this.running.size || this.background.size) {
      await Promise.allSettled([...this.running.values(), ...this.background])
    }
  }
}

/**
 * A translated scanned page no longer keeps its picture: it can be drawn again from the PDF, and kept it
 * would swell the library and every backup.
 */
function withoutPageImage(card: YarnCard): YarnCard {
  if (card.translatedPage === undefined || !card.anchors.some((a) => a.croppedImage)) return card
  return {
    ...card,
    anchors: card.anchors.map((a) => {
      if (!a.croppedImage) return a
      const rest = { ...a }
      delete rest.croppedImage
      return rest
    }),
  }
}
