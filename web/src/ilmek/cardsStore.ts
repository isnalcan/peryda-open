import yarnKinds from '@shared/yarn-kinds.json'
import { db, newId } from '../data/db'
import { AiError, streamAnswer, type AiRequest } from '../ai/client'
import { fakeStream } from '../ai/fake'
import { JobGone, KEY_CHANGED, abandonBatchJob, geminiBatch, isBatchName, type BatchItem, type BatchStatus, type PageBatching } from '../ai/batch'
import { composeTurns, kindPrompt, pageTranslationSystem, pageTranslationTurns, runsAI, systemPrompt } from '../ai/compose'
import { ModelAdvice, keyFor, modelFor, resolveActiveProvider, type ByokSettings, type ProviderId } from '../ai/provider'
import { isSettlingElsewhere, onJobSettled } from '../ai/settlingJobs'
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

/**
 * A page to translate: its text layer, or (for a scanned page) its picture. A scanned page may come
 * without its picture (`scanned`): the store draws it when the request is made, so a long range never
 * holds every page's picture at once (audit 15 Nov, WW-5).
 */
export interface PageSource {
  page: number
  text: string
  imageDataUrl?: string
  scanned?: boolean
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
  /**
   * Bumped when a batch being drawn and sent must not go on: the reader stopped, closed the book, or
   * changed the Gemini key the batch started with (audit 15 Nov, KR-1).
   */
  private batchGeneration = 0
  /** Jobs being collected or let go with an old Gemini key; polling with the new key leaves them alone. */
  private releasing = new Set<string>()
  /** Draws a scanned page's picture (JPEG data URL) when its translation is sent; set by the PDF reader. */
  pagePicture: ((page: number) => Promise<string | null>) | null = null

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
   * A new or removed Gemini key cannot ask about jobs made with the old one. A batch still being drawn
   * and sent stops, and its pages not sent yet say the key changed (a job whose request is already on
   * its way is removed with the key that made it, in `submitGroup`). Jobs that have a name are asked
   * about once with the old key: finished results are kept and saved before the job is deleted at
   * Google; unfinished jobs are cancelled and removed with the old key (audit 15 Nov, K-3, KR-1, KR-2).
   * React sets this from an effect, never while rendering.
   */
  set settings(next: ByokSettings) {
    const before = keyFor(this.currentSettings, 'gemini')
    this.currentSettings = next
    if (!before || before === keyFor(next, 'gemini')) return
    this.batchGeneration += 1
    for (const id of [...this.submissions.keys()]) {
      this.submissions.delete(id)
      const card = this.cards.find((c) => c.id === id)
      if (card && !card.batchJob && isUnfinishedTranslation(card)) this.failTranslation(id, KEY_CHANGED)
    }
    for (const job of new Set(this.cards.filter((c) => c.batchJob).map((c) => c.batchJob!))) {
      this.releasing.add(job)
      this.track(this.collectOrRelease(before, job).finally(() => this.releasing.delete(job)))
    }
  }

  /** One question to Google with the key that made the job: keep what finished, let go of the rest. */
  private async collectOrRelease(oldKey: string, job: string) {
    let status: BatchStatus | null = null
    if (isBatchName(job)) {
      try {
        status = await this.batcher.status(oldKey, job)
      } catch {
        status = null
      }
    }
    const waiting = this.cards.filter((c) => c.batchJob === job)
    if (status?.state === 'done') {
      this.applyResults(waiting, status)
      await this.saveNow(waiting.map((c) => c.id))
      await this.batcher.delete(oldKey, job).catch(() => undefined)
      return
    }
    for (const c of waiting) this.failTranslation(c.id, KEY_CHANGED)
    await this.saveNow(waiting.map((c) => c.id))
    await abandonBatchJob(oldKey, job, this.batcher).catch(() => undefined)
  }

  /** Writes these cards as they are now and waits for it (a collected result is saved before its job goes). */
  private async saveNow(ids: readonly string[]) {
    const cards = ids.map((id) => this.cards.find((c) => c.id === id)).filter((c): c is YarnCard => !!c)
    if (!cards.length) return
    // A late answer for a book deleted meanwhile is not written back as rows of a book that no longer
    // exists (audit final F-4; the readings store checks the same way).
    await db
      .transaction('rw', [db.books, db.cards], async () => {
        if (!(await db.books.get(this.bookId))) return
        await db.cards.bulkPut(cards)
      })
      .catch(() => undefined)
  }

  /** Copies a finished job's texts into its pages; a page with no text says why. */
  private applyResults(waiting: readonly YarnCard[], status: Extract<BatchStatus, { state: 'done' }>) {
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
  }

  // ---- Subscription (React) ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.cards

  private stopSettledListener: (() => void) | null = null

  /** A job of an old key was settled for this book while it opened: its saved pages replace the stale ones. */
  private async reloadSettled(job: string) {
    const ids = this.cards.filter((c) => c.batchJob === job).map((c) => c.id)
    if (!ids.length || this.disposed) return
    const rows = (await db.cards.bulkGet(ids)).filter((c): c is YarnCard => !!c && c.batchJob !== job)
    if (!rows.length || this.disposed) return
    const byId = new Map(rows.map((r) => [r.id, r]))
    this.commit(this.cards.map((c) => (c.batchJob === job ? (byId.get(c.id) ?? c) : c)))
  }

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
    this.stopSettledListener?.()
    this.stopSettledListener = onJobSettled((job) => void this.reloadSettled(job))
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
    this.stopSettledListener?.()
    this.stopSettledListener = null
    // A batch still being drawn stops: the document it draws from is closing.
    this.batchGeneration += 1
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

  /**
   * Resizes a card from its left edge: its right edge stays, so it is placed (pinned) at the new left
   * edge, at `y`. One write.
   */
  resizeFrom = (cardId: string, width: number, right: number, y: number) => {
    this.patch(cardId, (c) => {
      const w = clamp(width, CARD_WIDTH_RANGE)
      return { ...c, width: w, isPinned: true, x: right - w, y }
    })
  }

  /** Moves several placed cards at once (the pages were resized), in one write. */
  placeMany = (positions: ReadonlyMap<string, { x: number; y: number }>) => {
    if (!positions.size) return
    const now = Date.now()
    const changed: YarnCard[] = []
    const next = this.cards.map((c) => {
      const p = positions.get(c.id)
      if (!p || (p.x === c.x && p.y === c.y)) return c
      const updated = { ...c, x: p.x, y: p.y, updatedAt: now }
      changed.push(updated)
      return updated
    })
    if (!changed.length) return
    this.commit(next)
    if (!this.disposed) this.track(db.cards.bulkPut(changed).catch(() => undefined))
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
        sourceType: s.imageDataUrl || s.scanned ? 'pdf_area' : 'pdf_text',
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

  /**
   * A scanned page's picture: the one kept with an older card, or drawn now from the PDF. Null when the
   * page has its own text.
   */
  private async pictureFor(card: YarnCard): Promise<string | null> {
    const anchor = card.anchors[0]
    if (anchor?.sourceType !== 'pdf_area') return null
    if (anchor.croppedImage) return anchor.croppedImage
    const page = card.translatedPage ?? anchor.pageNumber
    const picture = this.pagePicture ? await this.pagePicture(page).catch(() => null) : null
    if (!picture) throw new AiError('unknown', 'no picture of the page')
    return picture
  }

  /** The request for a page translation with the reader's provider and translation model. */
  private async translationRequest(card: YarnCard, provider: ProviderId): Promise<AiRequest> {
    const anchor = card.anchors[0]
    const picture = await this.pictureFor(card)
    const target = (card.translationLanguage as Lang | undefined) ?? this.lang
    let model = modelFor(this.settings, provider, 'translation')
    // DeepSeek's reasoning model takes no pictures; scanned pages always go to deepseek-flash.
    if (provider === 'deepseek' && picture) model = 'deepseek-flash'
    return {
      provider,
      apiKey: keyFor(this.settings, provider),
      model,
      system: pageTranslationSystem(target, this.explainTerms),
      turns: pageTranslationTurns(target, this.bookTitle, card.translatedPage ?? anchor?.pageNumber ?? 1, this.pageCount, anchor?.selectedText ?? '', picture ?? undefined, this.explainTerms),
      maxOutputTokens: ModelAdvice.maxOutputTokens(provider, 'translation'),
      temperature: ModelAdvice.temperature('translation'),
      candidates: provider === 'gemini' ? ModelAdvice.geminiChain(model) : undefined,
    }
  }

  /**
   * Sends pages as Gemini batch jobs. Pictures of scanned pages are drawn one job at a time, each job kept
   * under Google's size limit, so a long scanned range never holds every picture at once (audit 15 Nov,
   * WW-5). The whole range belongs to the key it started with (KR-1).
   */
  private submitBatch(ids: readonly string[]) {
    const key = keyFor(this.settings, 'gemini')
    const model = modelFor(this.settings, 'gemini', 'translation')
    const token = Symbol('submission')
    for (const id of ids) {
      this.submissions.set(id, token)
      this.patch(id, (c) => ({
        ...c,
        messages: [...c.messages.slice(0, 1), { id: newId(), role: 'assistant', content: '', createdAt: Date.now(), state: 'streaming', provider: 'gemini', model }],
      }))
    }
    const generation = this.batchGeneration
    this.track(
      (async () => {
        let group: BatchItem[] = []
        let bytes = 0
        const send = async () => {
          // A page translated now while its group filled is left out: never sent twice.
          const items = group.filter((item) => this.submissions.get(item.key) === token)
          group = []
          bytes = 0
          if (!items.length) return
          await this.submitGroup(key, model, items, token, generation)
        }
        for (const id of ids) {
          if (generation !== this.batchGeneration) return
          // Translated now, translated again or closed meanwhile.
          if (this.submissions.get(id) !== token) continue
          const card = this.cards.find((c) => c.id === id)
          if (!card) continue
          let item: BatchItem
          try {
            const r = await this.translationRequest(card, 'gemini')
            item = { key: id, system: r.system, turns: r.turns }
          } catch {
            if (generation !== this.batchGeneration) return
            this.submissions.delete(id)
            this.failTranslation(id, 'unknown')
            continue
          }
          if (generation !== this.batchGeneration) return
          const size = batchItemBytes(item)
          if (group.length && size + bytes > BATCH_MAX_BYTES) await send()
          group.push(item)
          bytes += size
        }
        await send()
      })(),
    )
  }

  private async submitGroup(key: string, model: string, items: BatchItem[], token: symbol, generation: number) {
    const ids = items.map((item) => item.key)
    let name: string
    try {
      name = await this.batcher.create(key, model, items)
    } catch (error) {
      // Never a silent fall back to full-price direct requests: each page says the batch could not
      // start, and its Retry translates that page directly.
      if (generation !== this.batchGeneration && !this.disposed) return
      const code = error instanceof AiError && error.kind === 'key' ? 'key' : 'batch'
      for (const id of ids) {
        if (this.submissions.get(id) !== token) continue
        this.submissions.delete(id)
        this.failTranslation(id, code)
      }
      return
    }
    const still = ids.filter((id) => this.submissions.get(id) === token)
    for (const id of still) this.submissions.delete(id)
    if (!isBatchName(name)) {
      for (const id of still) this.failTranslation(id, 'batch')
      return
    }
    if (!still.length) {
      // Every page was closed, translated another way, or let go with a changed key while the job was
      // being made: it is removed with the key that made it.
      await abandonBatchJob(key, name, this.batcher).catch(() => undefined)
      return
    }
    for (const id of still) this.patch(id, (c) => ({ ...c, batchJob: name }))
    // The reader closed the book meanwhile: keep the job's name on the stored pages so it is collected later.
    if (this.disposed) await Promise.all(still.map((id) => db.cards.update(id, { batchJob: name }).catch(() => undefined)))
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
    this.batchGeneration += 1
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
      // Being collected or let go with an old key (the key changed), here or for the whole library
      // while this book opened: not asked with the new one (audit F-2).
      if (this.releasing.has(job) || isSettlingElsewhere(job)) continue
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
      this.applyResults(waiting, status)
      // The results are saved first; only then need the job (pages and translations) not stay at Google
      // (audit 15 Nov, WR-2).
      await this.saveNow(waiting.map((c) => c.id))
      await this.batcher.delete(key, job).catch(() => undefined)
    }
  }

  /** Whether a page translation waits on a Gemini batch: "Translate now" is offered at once (owner, 15 Nov). */
  isWaitingForBatch(cardId: string): boolean {
    const card = this.cards.find((c) => c.id === cardId)
    if (!card || card.messages[card.messages.length - 1]?.state !== 'streaming') return false
    return !!card.batchJob || this.submissions.has(cardId)
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
    return anchor?.sourceType === 'pdf_area' && !anchor.croppedImage && !this.pagePicture
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
    const translation = card.translatedPage !== undefined
    // A page translation may need its picture drawn first; the request is made inside the run.
    const makeRequest = async (): Promise<AiRequest> => {
      if (translation) return this.translationRequest(card, p)
      const pages = card.anchors.filter((a) => a.sourceType !== 'card').map((a) => a.pageNumber)
      const model = modelFor(this.settings, p, 'thread')
      return {
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
    this.stream(cardId, answerId, makeRequest, translation)
  }

  private stream(cardId: string, answerId: string, makeRequest: () => Promise<AiRequest>, translation: boolean) {
    this.controllers.get(cardId)?.abort()
    const controller = new AbortController()
    this.controllers.set(cardId, controller)
    const task = (async () => {
      let text = ''
      let lastSave = Date.now()
      try {
        const request = this.fake ? null : await makeRequest()
        if (controller.signal.aborted) throw new AiError('aborted', 'aborted')
        const source = this.fake || !request ? fakeStream(controller.signal, translation) : this.streamer({ ...request, signal: controller.signal })
        for await (const piece of source) {
          if (controller.signal.aborted) throw new AiError('aborted', 'aborted')
          text += piece
          const save = Date.now() - lastSave > 1500
          if (save) lastSave = Date.now()
          this.setAnswer(cardId, answerId, text, 'streaming', save)
        }
        if (controller.signal.aborted) throw new AiError('aborted', 'aborted')
        this.setAnswer(cardId, answerId, text, undefined, true, request?.provider, request?.model)
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
export function withoutPageImage(card: YarnCard): YarnCard {
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
