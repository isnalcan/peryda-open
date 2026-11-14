// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getPref } from '../data/db'
import type { AiRequest } from '../ai/client'
import type { BatchItem, BatchStatus, PageBatching } from '../ai/batch'
import { DEFAULT_SETTINGS, type ByokSettings } from '../ai/provider'
import { pageTranscriptionSystem } from '../ai/compose'
import { PageReadingsStore, readingJobs, readingsKey, type PageReading } from './pageReadings'

class FakeBatcher implements PageBatching {
  created: { model: string; items: BatchItem[] }[] = []
  state: BatchStatus = { state: 'waiting' }
  cancelled: string[] = []
  deleted: string[] = []
  async create(_key: string, model: string, items: BatchItem[]) {
    this.created.push({ model, items })
    return `batches/job-${this.created.length}`
  }
  async status() {
    return this.state
  }
  async cancel(_key: string, name: string) {
    this.cancelled.push(name)
  }
  async delete(_key: string, name: string) {
    this.deleted.push(name)
  }
}

function recorder() {
  const requests: AiRequest[] = []
  const streamer = async function* (req: AiRequest) {
    requests.push(req)
    yield 'Kavramlar, sınırlarında netleşir.'
  }
  return { requests, streamer }
}

const keyed: ByokSettings = { ...DEFAULT_SETTINGS, geminiApiKey: 'AIza-placeholder-000000' }
const picture = async () => 'data:image/jpeg;base64,' + 'QUJD'.repeat(400)

function readings(settings = keyed, streamer = recorder().streamer, batcher = new FakeBatcher()) {
  return new PageReadingsStore({ bookId: 'book', bookTitle: 'Freud', pageCount: 20, settings, picture, streamer, batcher, pollStart: 10 })
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe('Read with Pery (pages and ranges)', () => {
  beforeEach(async () => {
    await db.prefs.clear()
  })

  it('reads one page directly from its picture', async () => {
    const rec = recorder()
    const r = readings(keyed, rec.streamer)
    await r.ready
    r.read(3, 3, 'tr')
    await until(() => r.reading(3)?.state === 'done')
    expect(r.reading(3)?.text).toBe('Kavramlar, sınırlarında netleşir.')
    expect(rec.requests[0]!.system).toBe(pageTranscriptionSystem('tr'))
    expect(rec.requests[0]!.turns[0]!.parts[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    r.close()
  })

  it('sends a range to Gemini as a batch that fills in by itself', async () => {
    const rec = recorder()
    const batcher = new FakeBatcher()
    const r = readings(keyed, rec.streamer, batcher)
    await r.ready
    r.read(2, 5, 'tr')
    await until(() => r.inBatch === 4)
    expect(rec.requests).toHaveLength(0)
    expect(batcher.created[0]!.items.map((i) => i.key)).toEqual(['2', '3', '4', '5'])
    batcher.state = { state: 'done', texts: { '2': 'İki', '3': 'Üç', '5': 'Beş' }, errors: { '4': 'blocked' } }
    await until(() => r.pending === 0)
    expect(r.done.map((x) => x.page)).toEqual([2, 3, 5])
    expect(r.reading(4)).toMatchObject({ state: 'failed', error: 'blocked' })
    expect(batcher.deleted).toEqual(['batches/job-1'])
    r.close()
  })

  it('reads a range four at a time with other providers', async () => {
    const rec = recorder()
    const r = readings({ ...DEFAULT_SETTINGS, activeProvider: 'openai', openaiApiKey: 'sk-placeholder-not-real-123' }, rec.streamer)
    await r.ready
    r.read(1, 6, 'en')
    await until(() => r.done.length === 6)
    expect(rec.requests.map((q) => q.provider)).toEqual(Array(6).fill('openai'))
    r.close()
  })

  it('says so without a key', async () => {
    const r = readings(DEFAULT_SETTINGS)
    await r.ready
    r.read(1, 2, 'tr')
    expect(r.reading(1)).toMatchObject({ state: 'failed', error: 'no-key' })
    r.close()
  })

  it('stops a job and keeps what was read', async () => {
    const batcher = new FakeBatcher()
    const r = readings(keyed, recorder().streamer, batcher)
    await r.ready
    r.read(1, 1, 'tr')
    await until(() => r.reading(1)?.state === 'done')
    r.read(4, 8, 'tr')
    await until(() => r.inBatch === 5)
    expect(r.stop()).toBe(5)
    expect(r.pending).toBe(0)
    expect(r.done.map((x) => x.page)).toEqual([1])
    await until(() => batcher.cancelled.length > 0)
    expect(batcher.cancelled).toEqual(['batches/job-1'])
    r.close()
  })

  it('keeps readings with the book, so a job still lands after reopening', async () => {
    const batcher = new FakeBatcher()
    const first = readings(keyed, recorder().streamer, batcher)
    await first.ready
    first.read(5, 7, 'tr')
    await until(() => first.inBatch === 3)
    await new Promise((r) => setTimeout(r, 20))
    first.close()
    expect(await readingJobs('book')).toEqual(['batches/job-1'])
    batcher.state = { state: 'done', texts: { '5': 'Beş', '6': 'Altı', '7': 'Yedi' }, errors: {} }
    const again = readings(keyed, recorder().streamer, batcher)
    await again.ready
    await until(() => again.done.length === 3)
    expect(again.done.map((x) => x.text)).toEqual(['Beş', 'Altı', 'Yedi'])
    again.close()
  })

  it('marks a page that was streaming when the tab closed as unfinished', async () => {
    const kept: PageReading[] = [{ page: 2, text: 'Yarım', state: 'reading', createdAt: 1 }, { page: 3, text: '', state: 'waiting', createdAt: 1 }]
    await db.prefs.put({ key: readingsKey('book'), value: kept })
    const r = readings()
    await r.ready
    expect(r.reading(2)).toMatchObject({ state: 'failed', error: 'interrupted' })
    expect(r.reading(3)).toMatchObject({ state: 'failed', error: 'interrupted' })
    expect(await getPref(readingsKey('other'), null)).toBeNull()
    r.close()
  })
})
