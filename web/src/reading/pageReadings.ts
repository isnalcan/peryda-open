import { AiError, streamAnswer, type AiRequest } from '../ai/client'
import { fakeStream } from '../ai/fake'
import { JobGone, KEY_CHANGED, abandonBatchJob, geminiBatch, isBatchName, type BatchItem, type BatchStatus, type PageBatching } from '../ai/batch'
import { pageTranscriptionSystem, pageTranscriptionTurns } from '../ai/compose'
import { ModelAdvice, effortFor, keyFor, modelFor, resolveActiveProvider, type ByokSettings, type ProviderId } from '../ai/provider'
import { db, getPref } from '../data/db'
import { isSettlingElsewhere, onJobSettled } from '../ai/settlingJobs'
import type { Lang } from '../i18n/strings'
import { BATCH_MAX_BYTES, DIRECT_LIMIT, RANGE_LIMIT, WAVE_SIZE, batchItemBytes } from '../ilmek/cardsStore'

/** One page read with Pery: its text as the reader's AI wrote it out from the page's picture. */
export interface PageReading {
  page: number
  text: string
  /** waiting: its turn, or a Gemini batch job (`job`); reading: streaming in; failed: `error` says why. */
  state: 'waiting' | 'reading' | 'done' | 'failed'
  /** "no-key", "key", "quota", "network", "blocked", "batch", "expired", "key-changed", "interrupted", "unknown". */
  error?: string
  job?: string
  createdAt: number
}

export type Streamer = (request: AiRequest) => AsyncGenerator<string>

export interface PageReadingsOptions {
  bookId: string
  bookTitle: string
  pageCount: number
  settings: ByokSettings
  /** The page's picture as a JPEG `data:` URL. */
  picture: (page: number) => Promise<string | null>
  streamer?: Streamer
  batcher?: PageBatching
  /** Development only: answer with canned text instead of a provider. */
  fake?: boolean
  /** The first wait before asking Google about a job (ms); later waits grow to 30 s. */
  pollStart?: number
}

/** Where a book's readings are kept (a preference row, so no new database table is needed). */
export const readingsKey = (bookId: string) => `readings:${bookId}`

/** Batch jobs a book's kept readings still wait on (to cancel them when the book is deleted). */
export async function readingJobs(bookId: string): Promise<string[]> {
  const kept = await getPref<PageReading[]>(readingsKey(bookId), [])
  return [...new Set(kept.map((r) => r.job).filter((j): j is string => typeof j === 'string'))]
}

/**
 * "Read with Pery" in "Extract page text": a page, or a range of pages, read from their pictures by the
 * reader's AI when the page's own text reads badly (owner test 14 Nov). One or two pages are read
 * directly; more go to Gemini as batch jobs (half the price) or, with other providers, four at a time.
 * Readings are kept with the book, so a job that finishes later still lands. Mirrors the Mac app's
 * PageReadings.swift. Plain TypeScript; the extract dialog subscribes to it.
 */
export class PageReadingsStore {
  private readings = new Map<number, PageReading>()
  private snapshot: PageReading[] = []
  private listeners = new Set<() => void>()
  private controllers = new Map<number, AbortController>()
  private generation = 0
  /**
   * Bumped when a batch being drawn and sent must not go on: stopped, closed, or the Gemini key it started
   * with changed (audit 15 Nov, KR-1). Pages read directly with any provider are not affected by a key change.
   */
  private batchGeneration = 0
  /** Pages of a batch not yet given a job name (drawn, waiting their group, or in a create request). */
  private sending = new Set<number>()
  /** Jobs being collected or let go with an old Gemini key; polling with the new key leaves them alone. */
  private releasing = new Set<string>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private pollWait: number
  private closed = false
  readonly ready: Promise<void>

  constructor(private options: PageReadingsOptions) {
    this.pollWait = options.pollStart ?? 5000
    this.ready = this.load()
  }

  private async load() {
    const kept = await getPref<PageReading[]>(readingsKey(this.options.bookId), [])
    for (const r of Array.isArray(kept) ? kept : []) {
      if (!r || typeof r.page !== 'number' || r.page < 1 || r.page > this.options.pageCount) continue
      // A page that was streaming when the tab closed did not finish.
      const unfinished = r.state === 'reading' || (r.state === 'waiting' && !r.job)
      this.readings.set(r.page, unfinished ? { ...r, state: 'failed', error: 'interrupted' } : { ...r })
    }
    this.emit()
    this.ensurePolling()
  }

  /**
   * A new or removed Gemini key cannot ask about jobs made with the old one. A batch still being drawn
   * and sent stops, and its pages not sent yet say the key changed (a job whose request is already on its
   * way is removed with the key that made it). Jobs that have a name are asked about once with the old
   * key: finished pages are kept and saved before the job is deleted at Google; unfinished jobs are
   * cancelled and removed with the old key (audit 15 Nov, K-3, KR-1, KR-2, WR-2).
   */
  set settings(settings: ByokSettings) {
    const before = keyFor(this.options.settings, 'gemini')
    this.options = { ...this.options, settings }
    if (!before || before === keyFor(settings, 'gemini')) return
    this.batchGeneration++
    for (const p of this.sending) {
      const r = this.readings.get(p)
      if (r?.state === 'waiting' && !r.job) this.fail(p, KEY_CHANGED)
    }
    this.sending.clear()
    const jobs = new Set([...this.readings.values()].filter((r) => r.job && r.state === 'waiting').map((r) => r.job!))
    for (const job of jobs) {
      this.releasing.add(job)
      void this.collectOrRelease(before, job).finally(() => this.releasing.delete(job))
    }
    this.emit()
    void this.save()
  }

  /** One question to Google with the key that made the job: keep what finished, let go of the rest. */
  private async collectOrRelease(oldKey: string, job: string) {
    const batcher = this.options.batcher ?? geminiBatch
    let status: BatchStatus | null = null
    if (isBatchName(job)) {
      try {
        status = await batcher.status(oldKey, job)
      } catch {
        status = null
      }
    }
    const pages = [...this.readings.values()].filter((r) => r.job === job && r.state === 'waiting').map((r) => r.page)
    if (status?.state === 'done') {
      this.collect(pages, job, status)
      this.emit()
      await this.save()
      await batcher.delete(oldKey, job).catch(() => undefined)
      return
    }
    for (const p of pages) if (this.readings.get(p)?.job === job) this.fail(p, KEY_CHANGED)
    this.emit()
    await this.save()
    await abandonBatchJob(oldKey, job, batcher).catch(() => undefined)
  }

  /** Copies a finished job's texts into the pages still waiting on it. */
  private collect(pages: number[], job: string, status: Extract<BatchStatus, { state: 'done' }>) {
    for (const p of pages) {
      if (this.readings.get(p)?.job !== job) continue
      const text = (status.texts[String(p)] ?? '').trim()
      if (text) this.update(p, { text, state: 'done', job: undefined })
      else this.fail(p, status.errors[String(p)] ?? 'unknown')
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  private emit() {
    this.snapshot = [...this.readings.values()].sort((a, b) => a.page - b.page)
    for (const l of this.listeners) l()
  }

  /**
   * Writes the readings, merged with what is stored: another window on the same book may have collected a
   * finished (paid) result, which an older wait or failure here never replaces. Nothing is written once
   * the book is gone, so a deleted book leaves no readings behind (audit 15 Nov, WW-4).
   */
  private save(): Promise<void> {
    const bookId = this.options.bookId
    const key = readingsKey(bookId)
    return db
      .transaction('rw', [db.books, db.prefs], async () => {
        if (!(await db.books.get(bookId))) {
          await db.prefs.delete(key)
          return false
        }
        const stored = (await db.prefs.get(key))?.value
        let merged = false
        if (Array.isArray(stored)) {
          for (const s of stored as PageReading[]) {
            if (!s || typeof s.page !== 'number') continue
            const mine = this.readings.get(s.page)
            // Kept when this window has nothing for the page (stopped here), or only an older wait or failure.
            const older = !mine || ((mine.state === 'waiting' || mine.state === 'failed') && mine.createdAt <= s.createdAt)
            if (s?.state === 'done' && typeof s.text === 'string' && s.page >= 1 && s.page <= this.options.pageCount && older) {
              this.readings.set(s.page, { ...s, job: undefined })
              merged = true
            }
          }
        }
        await db.prefs.put({ key, value: [...this.readings.values()].sort((a, b) => a.page - b.page) })
        return merged
      })
      .then((merged) => {
        if (merged) this.emit()
      })
      .catch(() => undefined)
  }

  reading(page: number): PageReading | undefined {
    return this.readings.get(page)
  }

  /** Pages waiting or streaming. */
  get pending(): number {
    return this.snapshot.filter((r) => r.state === 'waiting' || r.state === 'reading').length
  }

  /** Pages waiting on a batch job. */
  get inBatch(): number {
    return this.snapshot.filter((r) => r.state === 'waiting' && r.job).length
  }

  /** Pages read, in page order. */
  get done(): PageReading[] {
    return this.snapshot.filter((r) => r.state === 'done' && r.text)
  }

  private update(page: number, change: Partial<PageReading>) {
    const r = this.readings.get(page)
    if (!r) return
    this.readings.set(page, { ...r, ...change })
  }

  private fail(page: number, error: string) {
    this.update(page, { state: 'failed', error, job: undefined })
  }

  /** Reads these pages again from their pictures (a page read before is replaced); at most RANGE_LIMIT. */
  read(from: number, to: number, lang: Lang) {
    const lower = Math.max(1, from)
    const upper = Math.min(this.options.pageCount, to, lower + RANGE_LIMIT - 1)
    if (lower > upper) return
    const pages = Array.from({ length: upper - lower + 1 }, (_, i) => lower + i)
    const oldJobs = new Set<string>()
    for (const p of pages) {
      this.controllers.get(p)?.abort()
      this.controllers.delete(p)
      const job = this.readings.get(p)?.job
      if (job) oldJobs.add(job)
      this.readings.set(p, { page: p, text: '', state: 'waiting', createdAt: Date.now() })
    }
    this.abandonUnwaited(oldJobs)
    const provider = this.options.fake ? 'gemini' : resolveActiveProvider(this.options.settings)
    if (!provider) {
      for (const p of pages) this.fail(p, 'no-key')
      this.emit()
      void this.save()
      return
    }
    this.emit()
    void this.save()
    if (provider === 'gemini' && pages.length > DIRECT_LIMIT && !this.options.fake) void this.submitBatch(pages, lang)
    else void this.runWaves(pages, provider, lang)
  }

  /** Whether a page waits on a Gemini batch (being drawn, the job being made, or the job running). */
  isWaitingForBatch(page: number): boolean {
    const r = this.readings.get(page)
    return !!r && r.state === 'waiting' && (!!r.job || this.sending.has(page))
  }

  /**
   * "Extract now": stops waiting for the batch and reads this page straight away, at the normal price; the
   * other pages stay in their job. The page leaves the job, so the job's later answer for it is ignored, and a
   * page still being drawn for a job is not sent to it (owner, 15 Nov). Mirrors the Mac's PageReadings.readNow.
   */
  readNow(page: number, lang: Lang) {
    if (!this.isWaitingForBatch(page)) return
    const job = this.readings.get(page)?.job
    this.sending.delete(page)
    const provider = this.options.fake ? 'gemini' : resolveActiveProvider(this.options.settings)
    if (!provider) {
      this.fail(page, 'no-key')
      this.emit()
      void this.save()
      return
    }
    this.readings.set(page, { page, text: '', state: 'waiting', createdAt: Date.now() })
    if (job) this.abandonUnwaited(new Set([job]))
    this.emit()
    void this.save()
    void this.run(page, provider, lang)
  }

  /** Stops every page still on its way (a batch job is cancelled and removed at Google); pages already read stay. */
  stop(): number {
    this.generation++
    this.batchGeneration++
    const stopped = this.snapshot.filter((r) => r.state === 'waiting' || r.state === 'reading')
    for (const r of stopped) {
      this.controllers.get(r.page)?.abort()
      this.controllers.delete(r.page)
      this.readings.delete(r.page)
    }
    this.abandonUnwaited(new Set(stopped.map((r) => r.job).filter((j): j is string => !!j)))
    this.sending.clear()
    this.emit()
    void this.save()
    return stopped.length
  }

  /** The book is on screen (again): waiting jobs are asked about. (React may close and reopen a store.) */
  open() {
    this.closed = false
    this.stopSettledListener?.()
    this.stopSettledListener = onJobSettled((job) => void this.reloadSettled(job))
    this.ensurePolling()
  }

  private stopSettledListener: (() => void) | null = null

  /** A job of an old key was settled for this book while it opened: its saved pages replace the stale ones. */
  private async reloadSettled(job: string) {
    const pages = new Set(this.snapshot.filter((r) => r.job === job).map((r) => r.page))
    if (!pages.size || this.closed) return
    const kept = await getPref<PageReading[]>(readingsKey(this.options.bookId), [])
    if (this.closed) return
    for (const r of Array.isArray(kept) ? kept : []) {
      if (r && pages.has(r.page) && r.job !== job && this.readings.get(r.page)?.job === job) this.readings.set(r.page, { ...r })
    }
    this.emit()
  }

  /** The reader left the book: nothing more is asked or saved from here. Jobs stay with Google and land next time. */
  close() {
    this.closed = true
    this.stopSettledListener?.()
    this.stopSettledListener = null
    this.generation++
    this.batchGeneration++
    for (const c of this.controllers.values()) c.abort()
    this.controllers.clear()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private request(page: number, image: string, provider: ProviderId, lang: Lang, signal?: AbortSignal): AiRequest {
    const { settings } = this.options
    // Reading a page from its picture is the "scan" job (DeepSeek's pictures go to deepseek-flash).
    const model = modelFor(settings, provider, 'scan')
    const effort = effortFor(settings, provider, 'scan', model)
    return {
      provider,
      apiKey: keyFor(settings, provider),
      model,
      system: pageTranscriptionSystem(lang),
      turns: pageTranscriptionTurns(lang, this.options.bookTitle, page, this.options.pageCount, image),
      maxOutputTokens: ModelAdvice.maxOutputTokens(provider, 'scan'),
      temperature: ModelAdvice.temperature('scan'),
      effort,
      candidates: provider === 'gemini' ? ModelAdvice.geminiChain(model, effort ?? 'high') : undefined,
      signal,
    }
  }

  private async runWaves(pages: number[], provider: ProviderId, lang: Lang) {
    const generation = this.generation
    for (let i = 0; i < pages.length; i += WAVE_SIZE) {
      if (generation !== this.generation) return
      await Promise.all(pages.slice(i, i + WAVE_SIZE).map((p) => this.run(p, provider, lang)))
    }
  }

  private async run(page: number, provider: ProviderId, lang: Lang) {
    const r = this.readings.get(page)
    if (!r || r.state !== 'waiting' || r.job) return
    const ac = new AbortController()
    this.controllers.set(page, ac)
    this.update(page, { state: 'reading' })
    this.emit()
    let out = ''
    try {
      const image = await this.options.picture(page)
      if (!image) throw new AiError('unknown', 'no picture')
      const stream = this.options.fake ? fakeStream(ac.signal, true) : (this.options.streamer ?? streamAnswer)(this.request(page, image, provider, lang, ac.signal))
      for await (const piece of stream) {
        if (ac.signal.aborted) return
        out += piece
        this.update(page, { text: out })
        this.emit()
      }
      if (ac.signal.aborted) return
      const text = out.trim()
      if (text) this.update(page, { text, state: 'done' })
      else this.fail(page, 'unknown')
    } catch (e) {
      if (ac.signal.aborted) return
      const kind = e instanceof AiError ? e.kind : 'network'
      if (kind === 'aborted') return
      this.fail(page, kind === 'browser' ? 'network' : kind)
    } finally {
      if (this.controllers.get(page) === ac) this.controllers.delete(page)
    }
    this.emit()
    if (!this.closed) void this.save()
  }

  /**
   * Pictures are made and sent one job at a time, each job kept under Google's size limit, so a long
   * scanned range never holds every page's picture in memory at once (audit 15 Nov, WW-5).
   */
  private async submitBatch(pages: number[], lang: Lang) {
    const generation = this.batchGeneration
    for (const p of pages) this.sending.add(p)
    const { settings } = this.options
    const key = keyFor(settings, 'gemini')
    const model = modelFor(settings, 'gemini', 'scan')
    let group: BatchItem[] = []
    let bytes = 0
    const send = async () => {
      // A page read now while its group filled is left out: never sent twice.
      const items = group.filter((item) => this.sending.has(Number(item.key)))
      group = []
      bytes = 0
      if (!items.length) return
      await this.submitGroup(items, key, model, generation)
    }
    for (const p of pages) {
      if (generation !== this.batchGeneration) return
      if (!this.sending.has(p)) continue
      const image = await this.options.picture(p).catch(() => null)
      if (generation !== this.batchGeneration) return
      if (!image) {
        this.sending.delete(p)
        this.fail(p, 'unknown')
        continue
      }
      const r = this.request(p, image, 'gemini', lang)
      const item: BatchItem = { key: String(p), system: r.system, turns: r.turns }
      const size = batchItemBytes(item)
      if (group.length && bytes + size > BATCH_MAX_BYTES) await send()
      group.push(item)
      bytes += size
    }
    await send()
    this.emit()
    void this.save()
  }

  private async submitGroup(items: BatchItem[], key: string, model: string, generation: number) {
    const batcher = this.options.batcher ?? geminiBatch
    const pages = items.map((i) => Number(i.key))
    try {
      const name = await batcher.create(key, model, items, effortFor(this.options.settings, 'gemini', 'scan', model) ?? undefined)
      const still = pages.filter((p) => this.sending.has(p) && this.readings.get(p)?.state === 'waiting' && !this.readings.get(p)?.job)
      for (const p of pages) this.sending.delete(p)
      // Stopped, read again, or the key changed while the job was being made: nobody waits for it, and it is
      // removed with the key that made it (audit 15 Nov, KR-1).
      if (generation !== this.batchGeneration || still.length === 0) {
        await abandonBatchJob(key, name, batcher)
        return
      }
      for (const p of still) this.update(p, { job: name })
      this.emit()
      void this.save()
      this.ensurePolling()
    } catch (e) {
      const mine = pages.filter((p) => this.sending.has(p))
      for (const p of pages) this.sending.delete(p)
      if (generation !== this.batchGeneration) return
      // No silent fallback to full-price requests (as with page translation): each page says so.
      const code = e instanceof AiError && e.kind === 'key' ? 'key' : 'batch'
      for (const p of mine) this.fail(p, code)
      this.emit()
      void this.save()
    }
  }

  /** Asks Google about waiting jobs: often at first, then less often, while pages wait. */
  ensurePolling() {
    if (this.pollTimer || this.closed || this.inBatch === 0) return
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null
      if (this.closed) return
      await this.poll()
      this.pollWait = Math.min(30_000, this.pollWait * 1.25)
      this.ensurePolling()
    }, this.pollWait)
  }

  async poll() {
    const batcher = this.options.batcher ?? geminiBatch
    const key = keyFor(this.options.settings, 'gemini')
    if (!key) return
    const now = Date.now()
    for (const job of new Set(this.snapshot.map((r) => r.job).filter((j): j is string => !!j))) {
      // Being collected or let go with an old key (the key changed), here or for the whole library
      // while this book opened: not asked with the new one (audit F-2).
      if (this.releasing.has(job) || isSettlingElsewhere(job)) continue
      const waiting = this.snapshot.filter((r) => r.job === job && r.state === 'waiting').map((r) => r.page)
      // A page read again meanwhile waits on another job: only pages still on this one are touched.
      const failAll = (code: string) => {
        for (const p of waiting) if (this.readings.get(p)?.job === job) this.fail(p, code)
      }
      if (!isBatchName(job)) {
        failAll('expired')
        continue
      }
      let status
      try {
        status = await batcher.status(key, job)
      } catch (e) {
        if (e instanceof AiError && e.kind === 'key') failAll('key')
        else if (e instanceof JobGone) failAll('expired')
        else {
          // A network hiccup: ask again next time, unless Google's 48-hour limit has passed.
          const oldest = Math.min(...waiting.map((p) => this.readings.get(p)?.createdAt ?? now))
          if (now - oldest > 48 * 3600 * 1000) failAll('expired')
        }
        continue
      }
      if (this.closed) return
      if (status.state === 'waiting') continue
      if (status.state === 'failed') failAll(status.code)
      else this.collect(waiting, job, status)
      // Saved first, even if the reader left the book meanwhile; only then need Google not keep the pages
      // or what it read (audit 15 Nov, WR-2).
      this.emit()
      await this.save()
      await batcher.delete(key, job).catch(() => undefined)
    }
    this.emit()
    if (!this.closed) void this.save()
  }

  /** Removes jobs no page waits for any more. */
  private abandonUnwaited(jobs: Set<string>) {
    const waited = new Set([...this.readings.values()].map((r) => r.job))
    const key = keyFor(this.options.settings, 'gemini')
    const batcher = this.options.batcher ?? geminiBatch
    for (const job of jobs) if (!waited.has(job)) void abandonBatchJob(key, job, batcher)
  }
}
