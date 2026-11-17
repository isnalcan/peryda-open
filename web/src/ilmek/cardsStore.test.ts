// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../data/db'
import { AiError, type AiRequest } from '../ai/client'
import { JobGone, BatchUnavailable, batchCreateBody, abandonBatchJobs, geminiBatch, isBatchName, parseBatchStatus, type BatchItem, type BatchStatus, type PageBatching } from '../ai/batch'
import { DEFAULT_SETTINGS, type ByokSettings } from '../ai/provider'
import { BATCH_MAX_BYTES, CardsStore, RANGE_LIMIT, batchItemBytes, splitBatch, type PageSource } from './cardsStore'

/** A stand-in for Google's batch service: records what was sent and answers as told. */
class FakeBatcher implements PageBatching {
  created: { model: string; items: BatchItem[] }[] = []
  state: BatchStatus = { state: 'waiting' }
  createError: Error | null = null
  statusError: Error | null = null
  async create(_key: string, model: string, items: BatchItem[]) {
    if (this.createError) throw this.createError
    this.created.push({ model, items })
    return `batches/job-${this.created.length}`
  }
  cancelled: string[] = []
  deleted: string[] = []
  async status() {
    if (this.statusError) throw this.statusError
    return this.state
  }
  async cancel(_key: string, name: string) {
    this.cancelled.push(name)
  }
  async delete(_key: string, name: string) {
    this.deleted.push(name)
  }
}

/** Records the requests it is asked to stream and answers each with a short text. */
function recorder() {
  const requests: AiRequest[] = []
  const streamer = async function* (req: AiRequest) {
    requests.push(req)
    yield 'Kavramlar, sınırlarında netleşir.'
  }
  return { requests, streamer }
}

const keyed: ByokSettings = { ...DEFAULT_SETTINGS, geminiApiKey: 'AIza-placeholder-000000' }

function page(n: number, image?: string): PageSource {
  return { page: n, text: image ? '' : `Page ${n}: concepts become clear at their borders.`, imageDataUrl: image, width: 760, height: 983 }
}

function store(settings = keyed, streamer = recorder().streamer, batcher = new FakeBatcher()) {
  const s = new CardsStore({ bookId: 'book', bookTitle: 'Freud', lang: 'tr', settings, streamer, batcher })
  s.pageCount = 20
  return s
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
}

beforeEach(async () => {
  await db.cards.clear()
})

describe('batch requests', () => {
  it('carry the model’s thinking and the translation temperature where the model takes one', () => {
    const item: BatchItem = { key: 'card-1', system: 'SYS', turns: [{ role: 'user', parts: [{ type: 'text', text: 'PAGE' }] }] }
    const req = (model: string) => batchCreateBody([item], model).batch.input_config.requests.requests[0]!
    expect(req('gemini-3.8-flash').metadata.key).toBe('card-1')
    expect((req('gemini-3.8-flash').request as any).generationConfig).toEqual({ maxOutputTokens: 16384, thinkingConfig: { thinkingLevel: 'high' } })
    expect((req('gemini-2.5-flash').request as any).generationConfig).toEqual({ maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 8192 }, temperature: 0.35 })
  })

  it('read both documented result shapes', () => {
    expect(parseBatchStatus({ name: 'batches/1', metadata: { state: 'JOB_STATE_RUNNING' } })).toEqual({ state: 'waiting' })
    const nested = {
      metadata: { state: 'JOB_STATE_SUCCEEDED' },
      done: true,
      response: {
        inlinedResponses: {
          inlinedResponses: [
            { metadata: { key: 'a' }, response: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Çeviri A' }] } }] } },
            { metadata: { key: 'b' }, error: { code: 400, message: 'bad' } },
          ],
        },
      },
    }
    expect(parseBatchStatus(nested)).toEqual({ state: 'done', texts: { a: 'Çeviri A' }, errors: { b: 'unknown' } })
    const flat = { state: 'BATCH_STATE_SUCCEEDED', dest: { inlinedResponses: [{ metadata: { key: 'c' }, response: { candidates: [{ content: { parts: [{ text: 'Çeviri C' }] } }] } }] } }
    expect(parseBatchStatus(flat)).toEqual({ state: 'done', texts: { c: 'Çeviri C' }, errors: {} })
    expect(parseBatchStatus({ metadata: { state: 'JOB_STATE_EXPIRED' } })).toEqual({ state: 'failed', code: 'expired' })
  })
})

describe('page translation', () => {
  it('"translate this page": this page and the next, directly and at once', async () => {
    const { requests, streamer } = recorder()
    const batcher = new FakeBatcher()
    const s = store(keyed, streamer, batcher)
    const ids = s.translatePages([page(4), page(5)], 'tr')
    expect(ids).toHaveLength(2)
    await s.waitForIdle()
    expect(batcher.created).toHaveLength(0)
    expect(requests).toHaveLength(2)
    const req = requests[0]!
    expect(req.provider).toBe('gemini')
    // Blind test of 17 Nov 2026: page translation with Gemini 4 Hydrogen at low thinking.
    expect(req.candidates?.[0]).toEqual({ model: 'gemini-4-hydrogen', thinking: { level: 'low' } })
    expect(req.temperature).toBe(0.35)
    expect(req.system.startsWith('Sen okuma ve çalışma atölyesinin baş çevirmeni')).toBe(true)
    const prompt = req.turns[0]!.parts[0]!
    expect(prompt.type === 'text' && prompt.text.startsWith('[Freud · Sayfa 4/20]')).toBe(true)
    expect(prompt.type === 'text' && prompt.text.endsWith('Page 4: concepts become clear at their borders.')).toBe(true)
    expect(s.pageTranslation(5, 'tr')?.messages.at(-1)?.content).toBe('Kavramlar, sınırlarında netleşir.')
    expect(s.pageTranslation(5, 'tr')?.height).toBe(983)
    expect(s.translatePages([page(4)], 'tr')).toEqual([])
  })

  it('leaves out the bracket explanations of terms when the reader turned them off', async () => {
    const { requests, streamer } = recorder()
    const s = store(keyed, streamer, new FakeBatcher())
    s.explainTerms = false
    s.translatePages([page(4)], 'tr')
    await s.waitForIdle()
    expect(requests).toHaveLength(1)
    for (const req of requests) {
      expect(req.system.startsWith('Sen okuma ve çalışma atölyesinin baş çevirmeni')).toBe(true)
      expect(req.system).not.toMatch(/parantez/i)
      const prompt = req.turns[0]!.parts[0]!
      expect(prompt.type === 'text' && !/parantez/i.test(prompt.text)).toBe(true)
    }
  })

  it('more than two pages with Gemini go as one batch job, which keeps waiting across a reload', async () => {
    const { requests, streamer } = recorder()
    const batcher = new FakeBatcher()
    const s = store(keyed, streamer, batcher)
    const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
    await s.waitForIdle()
    expect(batcher.created).toHaveLength(1)
    expect(batcher.created[0]!.model).toBe('gemini-4-hydrogen')
    expect(batcher.created[0]!.items.map((i) => i.key)).toEqual(ids)
    expect(requests).toHaveLength(0)
    expect(s.waitingTranslations).toHaveLength(3)

    const reopened = store(keyed, streamer, batcher)
    await reopened.load()
    expect(reopened.waitingTranslations).toHaveLength(3)

    batcher.state = { state: 'done', texts: { [ids[0]!]: 'Bir.', [ids[1]!]: 'İki.' }, errors: { [ids[2]!]: 'blocked' } }
    await s.pollBatches()
    expect(s.pageTranslation(1, 'tr')?.messages.at(-1)?.content).toBe('Bir.')
    expect(s.pageTranslation(1, 'tr')?.batchJob).toBeUndefined()
    expect(s.pageTranslation(3, 'tr')?.messages.at(-1)).toMatchObject({ state: 'error', content: 'blocked' })
  })

  it('other providers translate in waves of four', async () => {
    const { requests, streamer } = recorder()
    const claude = { ...DEFAULT_SETTINGS, activeProvider: 'claude' as const, claudeApiKey: 'sk-ant-placeholder-0000' }
    const s = store(claude, streamer)
    s.translatePages([1, 2, 3, 4, 5, 6].map((n) => page(n)), 'tr')
    await s.waitForIdle()
    expect(requests).toHaveLength(6)
    expect(requests.every((r) => r.provider === 'claude' && r.model === 'claude-haiku-5-5')).toBe(true)
    expect(requests[0]!.maxOutputTokens).toBe(16000)
    expect(s.cards.filter((c) => c.messages.at(-1)?.role === 'assistant' && !c.messages.at(-1)?.state)).toHaveLength(6)
  })

  it('when the batch cannot be made, nothing is sent at full price: each page offers a retry', async () => {
    for (const failure of [new BatchUnavailable('no batch'), new AiError('network', 'down'), new AiError('quota', 'limit')]) {
      await db.cards.clear()
      const { requests, streamer } = recorder()
      const batcher = new FakeBatcher()
      batcher.createError = failure
      const s = store(keyed, streamer, batcher)
      const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
      await s.waitForIdle()
      expect(requests).toHaveLength(0)
      expect(s.waitingTranslations).toHaveLength(0)
      expect(s.cards.map((c) => c.messages.at(-1))).toEqual(ids.map(() => expect.objectContaining({ state: 'error', content: 'batch' })))
      // Retry on one page translates that page directly.
      s.retranslate(ids[0]!)
      await s.waitForIdle()
      expect(requests).toHaveLength(1)
      expect(s.pageTranslation(1, 'tr')?.messages.at(-1)?.content).toBe('Kavramlar, sınırlarında netleşir.')
    }
  })

  it('a rejected key on the batch says so', async () => {
    const batcher = new FakeBatcher()
    batcher.createError = new AiError('key', 'rejected')
    const s = store(keyed, recorder().streamer, batcher)
    s.translatePages([page(1), page(2), page(3)], 'tr')
    await s.waitForIdle()
    expect(s.pageTranslation(2, 'tr')?.messages.at(-1)).toMatchObject({ state: 'error', content: 'key' })
  })

  it('one request translates at most RANGE_LIMIT pages', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages(Array.from({ length: RANGE_LIMIT + 10 }, (_, i) => page(i + 1)), 'tr')
    await s.waitForIdle()
    expect(RANGE_LIMIT).toBe(200)
    expect(ids).toHaveLength(RANGE_LIMIT)
    // Text pages are small: all of them fit in one job.
    expect(batcher.created).toHaveLength(1)
    expect(batcher.created[0]!.items).toHaveLength(RANGE_LIMIT)
  })

  it('a long scanned range is split into several jobs that each stay under the size limit', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    // Each scanned page is a ~4 MB picture here, so three fit in one 15 MB job.
    const picture = `data:image/jpeg;base64,${'A'.repeat(4_000_000)}`
    const ids = s.translatePages(Array.from({ length: 7 }, (_, i) => page(i + 1, picture)), 'tr')
    await s.waitForIdle()
    expect(batcher.created.map((job) => job.items.length)).toEqual([3, 3, 1])
    expect(batcher.created.flatMap((job) => job.items.map((item) => item.key))).toEqual(ids)
    for (const job of batcher.created) expect(job.items.reduce((sum, item) => sum + batchItemBytes(item), 0)).toBeLessThan(BATCH_MAX_BYTES)
    // Each page waits on its own job.
    expect(new Set(s.waitingTranslations.map((c) => c.batchJob)).size).toBe(3)
  })

  it('when one of several jobs cannot start, only its pages say so', async () => {
    const batcher = new FakeBatcher()
    let calls = 0
    const create = batcher.create.bind(batcher)
    batcher.create = async (key, model, items) => {
      calls += 1
      if (calls === 2) throw new AiError('quota', 'busy')
      return create(key, model, items)
    }
    const s = store(keyed, recorder().streamer, batcher)
    const picture = `data:image/jpeg;base64,${'A'.repeat(6_000_000)}`
    s.translatePages(Array.from({ length: 4 }, (_, i) => page(i + 1, picture)), 'tr')
    await s.waitForIdle()
    expect(s.waitingTranslations.map((c) => c.translatedPage)).toEqual([1, 2])
    expect(s.pageTranslation(3, 'tr')?.messages.at(-1)).toMatchObject({ state: 'error', content: 'batch' })
    expect(s.pageTranslation(4, 'tr')?.messages.at(-1)).toMatchObject({ state: 'error', content: 'batch' })
  })

  it('stopping translation cancels the batch jobs and drops waiting pages, keeping finished ones', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    s.translatePages([page(1), page(2)], 'tr')
    await s.waitForIdle()
    const ids = s.translatePages([3, 4, 5, 6].map((n) => page(n)), 'tr')
    await s.waitForIdle()
    expect(s.unfinishedTranslations).toHaveLength(4)
    expect(s.stopTranslations()).toBe(4)
    await s.waitForIdle()
    expect(s.unfinishedTranslations).toHaveLength(0)
    expect(s.pageTranslation(1, 'tr')?.messages.at(-1)?.content).toBe('Kavramlar, sınırlarında netleşir.')
    expect(s.pageTranslation(2, 'tr')).toBeDefined()
    for (const id of ids) expect(s.cards.some((c) => c.id === id)).toBe(false)
    expect(batcher.cancelled).toEqual(['batches/job-1'])
    expect(batcher.deleted).toEqual(['batches/job-1'])
  })

  it('stopping translation keeps pages waiting their turn from starting', async () => {
    const requests: AiRequest[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const streamer = async function* (req: AiRequest) {
      requests.push(req)
      await gate
      yield 'Bitti.'
    }
    const claude = { ...DEFAULT_SETTINGS, activeProvider: 'claude' as const, claudeApiKey: 'sk-ant-placeholder-0000' }
    const s = store(claude, streamer)
    s.translatePages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => page(n)), 'tr')
    await until(() => requests.length === 4)
    expect(s.stopTranslations()).toBe(10)
    release()
    await s.waitForIdle()
    expect(requests).toHaveLength(4)
    expect(s.cards.filter((c) => c.translatedPage !== undefined)).toHaveLength(0)
  })

  it('splitBatch keeps the order and puts an oversized page on its own', () => {
    expect(splitBatch([1, 2, 3, 20, 4], (n) => n, 10)).toEqual([[1, 2, 3], [20], [4]])
    expect(splitBatch([], (n: number) => n, 10)).toEqual([])
  })

  it('a scanned page goes as a picture, and to deepseek-flash with DeepSeek', async () => {
    const { requests, streamer } = recorder()
    const deepseek = { ...DEFAULT_SETTINGS, activeProvider: 'deepseek' as const, deepseekApiKey: 'sk-placeholder-0000000' }
    const s = store(deepseek, streamer)
    s.translatePages([page(7, 'data:image/jpeg;base64,/9j/')], 'tr')
    await s.waitForIdle()
    expect(requests[0]!.model).toBe('deepseek-flash')
    expect(requests[0]!.turns[0]!.parts[0]).toEqual({ type: 'image', mimeType: 'image/jpeg', base64: '/9j/' })
  })

  it('without any key it says so', async () => {
    const s = store(DEFAULT_SETTINGS)
    s.translatePages([page(1)], 'tr')
    await s.waitForIdle()
    expect(s.pageTranslation(1, 'tr')?.messages.at(-1)).toMatchObject({ state: 'error', content: 'no-key' })
  })

  it('"translate now" takes a page out of the batch', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
    // Offered from the start, while the job is still being made (owner, 15 Nov).
    expect(ids.every((id) => s.isWaitingForBatch(id))).toBe(true)
    await s.waitForIdle()
    expect(s.isWaitingForBatch(ids[1]!)).toBe(true)
    s.translateNow(ids[1]!)
    expect(s.isWaitingForBatch(ids[1]!)).toBe(false)
    await s.waitForIdle()
    const card = s.pageTranslation(2, 'tr')!
    expect(card.batchJob).toBeUndefined()
    expect(card.messages.at(-1)?.content).toBe('Kavramlar, sınırlarında netleşir.')
    expect(card.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(s.waitingTranslations).toHaveLength(2)
    // Two pages still wait on the job, so it keeps running.
    expect(batcher.cancelled).toEqual([])
    expect(batcher.deleted).toEqual([])
  })

  it('a job is cancelled once the last page waiting on it is translated now, translated again or closed', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
    await s.waitForIdle()
    s.translateNow(ids[0]!)
    s.remove(ids[1]!)
    await s.waitForIdle()
    expect(batcher.cancelled).toEqual([])
    s.retranslate(ids[2]!)
    await s.waitForIdle()
    expect(batcher.cancelled).toEqual(['batches/job-1'])
    expect(batcher.deleted).toEqual(['batches/job-1'])

    // Closing the last waiting page cancels too.
    const more = s.translatePages([page(4), page(5), page(6)], 'tr')
    await s.waitForIdle()
    for (const id of more) s.remove(id)
    await s.waitForIdle()
    expect(batcher.cancelled).toEqual(['batches/job-1', 'batches/job-2'])
    expect(batcher.deleted).toEqual(['batches/job-1', 'batches/job-2'])
  })

  it('a job made after every page was closed is cancelled at once', async () => {
    let release!: (name: string) => void
    const batcher = new FakeBatcher()
    batcher.create = () => new Promise<string>((r) => (release = r))
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
    await until(() => Boolean(release))
    for (const id of ids) s.remove(id)
    release('batches/orphan')
    await s.waitForIdle()
    expect(batcher.cancelled).toEqual(['batches/orphan'])
    expect(batcher.deleted).toEqual(['batches/orphan'])
  })

  it('a collected job is deleted at Google, and a scanned page drops its picture once translated', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages([page(1, 'data:image/jpeg;base64,/9j/'), page(2), page(3)], 'tr')
    await s.waitForIdle()
    expect(batcher.created[0]!.items[0]!.turns[0]!.parts[0]).toMatchObject({ type: 'image' })
    batcher.state = { state: 'done', texts: { [ids[0]!]: 'Bir.', [ids[1]!]: 'İki.', [ids[2]!]: 'Üç.' }, errors: {} }
    await s.pollBatches()
    await s.waitForIdle()
    expect(batcher.deleted).toEqual(['batches/job-1'])
    const scanned = s.pageTranslation(1, 'tr')!
    expect(scanned.anchors[0]!.croppedImage).toBeUndefined()
    expect(scanned.anchors[0]!.sourceType).toBe('pdf_area')
    expect((await db.cards.get(ids[0]!))?.anchors[0]?.croppedImage).toBeUndefined()
    expect(s.needsPageImage(ids[0]!)).toBe(true)
    expect(s.needsPageImage(ids[1]!)).toBe(false)
  })

  // Audit final F-4: a status answer that arrives after the book was deleted writes nothing back.
  it('a late answer for a deleted book is not written back as its rows', async () => {
    await db.books.put({ id: 'book', title: 'K', addedAt: 1, openedAt: 1 } as never)
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
    await s.waitForIdle()
    expect(await db.cards.where('bookId').equals('book').count()).toBe(3)
    // The reader goes back to the library (the store closes) and deletes the book while a status
    // question is out; the answer arrives after that.
    s.dispose()
    await db.books.delete('book')
    await db.cards.where('bookId').equals('book').delete()
    batcher.state = { state: 'done', texts: { [ids[0]!]: 'Bir.', [ids[1]!]: 'İki.', [ids[2]!]: 'Üç.' }, errors: {} }
    await s.pollBatches()
    await s.waitForIdle()
    await new Promise((r) => setTimeout(r, 50))
    expect(await db.cards.where('bookId').equals('book').count()).toBe(0)
  })

  it('a direct translation of a scanned page drops its picture; translating again sends a new one', async () => {
    const { requests, streamer } = recorder()
    const s = store(keyed, streamer)
    const [id] = s.translatePages([page(7, 'data:image/jpeg;base64,/9j/')], 'tr')
    await s.waitForIdle()
    expect(s.cards[0]!.anchors[0]!.croppedImage).toBeUndefined()
    s.retranslate(id!, page(7, 'data:image/jpeg;base64,/9k/'))
    await s.waitForIdle()
    expect(requests[1]!.turns[0]!.parts[0]).toEqual({ type: 'image', mimeType: 'image/jpeg', base64: '/9k/' })
    expect(s.cards[0]!.anchors[0]!.croppedImage).toBeUndefined()
  })

  it('a waiting page says when the job cannot be answered; a network hiccup keeps waiting', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    s.translatePages([page(1), page(2), page(3)], 'tr')
    await s.waitForIdle()
    batcher.statusError = new AiError('network', 'down')
    await s.pollBatches()
    expect(s.waitingTranslations).toHaveLength(3)
    batcher.statusError = new JobGone('gone')
    await s.pollBatches()
    expect(s.waitingTranslations).toHaveLength(0)
    expect(s.pageTranslation(1, 'tr')?.messages.at(-1)?.content).toBe('expired')
  })

  it('a late reply from an older submission is ignored', async () => {
    let release!: (name: string) => void
    const batcher = new FakeBatcher()
    batcher.create = () => new Promise<string>((r) => (release = r))
    const s = store(keyed, recorder().streamer, batcher)
    const ids = s.translatePages([page(1), page(2), page(3)], 'tr')
    await until(() => Boolean(release))
    s.translateNow(ids[0]!)
    release('batches/late')
    await s.waitForIdle()
    expect(s.cards.find((c) => c.id === ids[0])?.batchJob).toBeUndefined()
    expect(s.cards.find((c) => c.id === ids[1])?.batchJob).toBe('batches/late')
  })
})

describe('threads', () => {
  it('use the thread model, its temperature, the fallback chain and the context template', async () => {
    const { requests, streamer } = recorder()
    const s = store(keyed, streamer)
    s.create({
      color: 'lavender',
      kind: 'lavender',
      anchors: [{ id: 'a', sourceType: 'pdf_text', bookId: 'book', pageNumber: 3, selectedText: 'Bilinçdışı', lineRects: [], boundingRect: { x: 0, y: 0, width: 0, height: 0 }, context: 'Sayfanın başı.' }],
    })
    await s.waitForIdle()
    const req = requests[0]!
    expect(req.temperature).toBe(0.55)
    expect(req.candidates?.map((c) => c.model)).toEqual(['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash'])
    expect(req.candidates?.[0]!.thinking).toEqual({ level: 'medium' })
    const first = req.turns[0]!.parts[0]!
    expect(first.type === 'text' && first.text.startsWith('Seçilen Metin: "Bilinçdışı"')).toBe(true)
    expect(first.type === 'text' && first.text.includes('Sayfanın başı.')).toBe(true)
  })

  it('resize stays within limits; no height follows the content again', async () => {
    const s = store()
    const card = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'not' })
    s.resize(card.id, 2000, 20)
    expect(s.cards[0]).toMatchObject({ width: 640, height: 150 })
    s.resize(card.id, 100, undefined)
    expect(s.cards[0]!.width).toBe(300)
    expect('height' in s.cards[0]!).toBe(false)
  })

  // Owner, 16 Nov: a card's side edges change its width; from the left edge the right edge stays.
  it('resizing from the left edge keeps the right edge and places the card there', async () => {
    const s = store()
    const card = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'not' })
    s.resizeFrom(card.id, 500, 1200, 340)
    expect(s.cards[0]).toMatchObject({ width: 500, x: 700, y: 340, isPinned: true })
    s.resizeFrom(card.id, 2000, 1200, 340)
    expect(s.cards[0]).toMatchObject({ width: 640, x: 560 })
    await s.waitForIdle()
    expect(await db.cards.get(card.id)).toMatchObject({ width: 640, x: 560, isPinned: true })
  })

  it('moves several placed cards at once (the pages were resized)', async () => {
    const s = store()
    const a = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'a' })
    const b = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'b' })
    const c = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'c' })
    await s.waitForIdle()
    let changes = 0
    const stop = s.subscribe(() => (changes += 1))
    s.placeMany(new Map([[a.id, { x: 1300, y: 40 }], [b.id, { x: -400, y: 900 }]]))
    stop()
    expect(changes).toBe(1)
    expect(s.cards.find((x) => x.id === a.id)).toMatchObject({ x: 1300, y: 40 })
    expect(s.cards.find((x) => x.id === b.id)).toMatchObject({ x: -400, y: 900 })
    expect(s.cards.find((x) => x.id === c.id)).toBe(s.cards[2])
    await s.waitForIdle()
    expect(await db.cards.get(b.id)).toMatchObject({ x: -400, y: 900 })
  })

  it('removing a card removes every thread opened from it', async () => {
    const s = store()
    const a = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'a' })
    const b = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'b', parentCardId: a.id })
    s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'c', parentCardId: b.id })
    const other = s.create({ color: 'cream', kind: 'cream', anchors: [], text: 'd' })
    s.remove(a.id)
    await s.waitForIdle()
    expect(s.cards.map((c) => c.id)).toEqual([other.id])
    expect(await db.cards.count()).toBe(1)
  })
})

describe('batch job names', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('only Google-shaped names are accepted', () => {
    expect(isBatchName('batches/abc_DEF-123')).toBe(true)
    for (const bad of ['', 'batches/', 'batches/../models', 'batches/a/b', 'batches/a?x=1', 'batches/a#x', 'https://evil.example/x', 'models/gemini', `batches/${'a'.repeat(129)}`, 12, null]) {
      expect(isBatchName(bad)).toBe(false)
    }
  })

  it('a bad name never reaches a URL; a good one is cancelled, deleted and checked at its own address', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    await expect(geminiBatch.status('AIza-placeholder-000000', 'batches/../../evil')).rejects.toBeInstanceOf(JobGone)
    await geminiBatch.cancel('AIza-placeholder-000000', 'batches/x?y')
    await geminiBatch.delete('AIza-placeholder-000000', '//evil.example/batches/x')
    expect(fetchFn).not.toHaveBeenCalled()

    await geminiBatch.cancel('AIza-placeholder-000000', 'batches/job1')
    await geminiBatch.delete('AIza-placeholder-000000', 'batches/job1')
    expect(fetchFn.mock.calls.map(([url, init]) => [init?.method, url])).toEqual([
      ['POST', 'https://generativelanguage.googleapis.com/v1beta/batches/job1:cancel'],
      ['DELETE', 'https://generativelanguage.googleapis.com/v1beta/batches/job1'],
    ])
  })

  it('a job whose name is not Google\'s shape is refused when it is made', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'batches/../x' }), { status: 200 })))
    await expect(geminiBatch.create('AIza-placeholder-000000', 'gemini-3.8-flash', [])).rejects.toMatchObject({ kind: 'unknown' })
  })

  it('a deleted book\'s jobs are cancelled and removed with the Gemini key', async () => {
    const batcher = new FakeBatcher()
    await abandonBatchJobs('AIza-placeholder-000000', ['batches/a', 'batches/a', 'batches/b', 'batches/../x'], batcher)
    expect(batcher.cancelled).toEqual(['batches/a', 'batches/b'])
    expect(batcher.deleted).toEqual(['batches/a', 'batches/b'])
    await abandonBatchJobs('', ['batches/c'], batcher)
    expect(batcher.cancelled).toHaveLength(2)
  })

  it('a failed job is removed from Google too', async () => {
    const batcher = new FakeBatcher()
    const s = store(keyed, recorder().streamer, batcher)
    s.translatePages([page(1), page(2), page(3)], 'tr')
    await s.waitForIdle()
    batcher.state = { state: 'failed', code: 'expired' }
    await s.pollBatches()
    await s.waitForIdle()
    expect(s.waitingTranslations).toHaveLength(0)
    expect(batcher.deleted).toEqual(['batches/job-1'])
  })

  it('a waiting page from a backup with a bad job name says the job is gone', async () => {
    const real: PageBatching = { create: async () => 'batches/x', status: geminiBatch.status, cancel: async () => {}, delete: async () => {} }
    const s = new CardsStore({ bookId: 'book', bookTitle: 'Freud', lang: 'tr', settings: keyed, streamer: recorder().streamer, batcher: real })
    await db.cards.add({
      id: 'restored', bookId: 'book', color: 'sky', kind: 'translate', anchors: [], x: 0, y: 0, width: 760, translatedPage: 3, translationLanguage: 'tr', batchJob: 'batches/../../evil',
      isPinned: false, collapsed: false, createdAt: Date.now(), updatedAt: Date.now(),
      messages: [{ id: 'u', role: 'user', content: 'x', createdAt: 1 }, { id: 'a', role: 'assistant', content: '', createdAt: 2, state: 'streaming' }],
    })
    await s.load()
    await s.pollBatches()
    expect(s.cards[0]!.messages.at(-1)).toMatchObject({ state: 'error', content: 'expired' })
  })
})
