// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getPref } from '../data/db'
import { KEY_CHANGED, type BatchItem, type BatchStatus, type PageBatching } from './batch'
import { releaseJobsOfOldKey } from './oldKeyJobs'
import { CardsStore } from '../ilmek/cardsStore'
import { DEFAULT_SETTINGS } from './provider'
import type { YarnCard } from '../ilmek/types'

class KeyRecordingBatcher implements PageBatching {
  calls: string[] = []
  /** Status by job name (default: still waiting). */
  states = new Map<string, BatchStatus>()
  created: { key: string; items: BatchItem[] }[] = []
  /** Holds `create` until released, to change the key while a job is being made. */
  gate: Promise<void> | null = null
  /** What the stored page said when the job was deleted (a result must be saved first). */
  storedAtDelete = new Map<string, string | undefined>()
  async create(key: string, _model: string, items: BatchItem[]) {
    this.calls.push(`create ${key}`)
    if (this.gate) await this.gate
    this.created.push({ key, items })
    return `batches/made-${this.created.length}`
  }
  async status(key: string, name: string): Promise<BatchStatus> {
    this.calls.push(`status ${key} ${name}`)
    return this.states.get(name) ?? { state: 'waiting' }
  }
  async cancel(key: string, name: string) {
    this.calls.push(`cancel ${key} ${name}`)
  }
  async delete(key: string, name: string) {
    this.calls.push(`delete ${key} ${name}`)
    const card = await db.cards.filter((c: YarnCard) => c.messages.some((m) => m.content === 'Bitti.')).first()
    this.storedAtDelete.set(name, card?.messages[1]?.content)
  }
}

const OLD = 'OLD-KEY-0000000000'
const NEW = 'NEW-KEY-0000000000'

const waitingCard = (id: string, bookId: string, job: string): YarnCard =>
  ({
    id, bookId, color: 'sky', kind: 'translate', anchors: [], x: 0, y: 0, width: 760, isPinned: false, collapsed: false, translatedPage: 1, translationLanguage: 'tr', batchJob: job,
    messages: [{ id: 'u', role: 'user', content: 'ÇEVİRİ', createdAt: 1 }, { id: 'a', role: 'assistant', content: '', createdAt: 2, state: 'streaming' }], createdAt: 1, updatedAt: 1,
  }) as YarnCard

// Audit 15 Nov (K-3, KR-1, KR-2, WR-2, WR-5): a changed or removed Gemini key collects or lets go of the
// jobs made with the old one, with the old key, and never sends the old key anywhere else.
describe('Jobs of an old Gemini key', () => {
  beforeEach(async () => {
    await db.cards.clear()
    await db.prefs.clear()
  })

  it('across the library: unfinished jobs are cancelled and removed with the old key; their pages say the key changed', async () => {
    await db.cards.put(waitingCard('c1', 'b1', 'batches/one'))
    await db.prefs.put({ key: 'readings:b2', value: [{ page: 3, text: '', state: 'waiting', job: 'batches/two', createdAt: 1 }, { page: 4, text: 'Dört', state: 'done', createdAt: 1 }] })
    const batcher = new KeyRecordingBatcher()
    expect(await releaseJobsOfOldKey(OLD, { batcher })).toBe(2)
    expect(batcher.calls.every((c) => c.includes(OLD))).toBe(true)
    expect(batcher.calls.filter((c) => c.startsWith('cancel')).sort()).toEqual([`cancel ${OLD} batches/one`, `cancel ${OLD} batches/two`])
    const card = (await db.cards.get('c1'))!
    expect(card.batchJob).toBeUndefined()
    expect(card.messages[1]).toMatchObject({ state: 'error', content: KEY_CHANGED })
    const readings = await getPref<{ page: number; state: string; job?: string; error?: string }[]>('readings:b2', [])
    expect(readings[0]).toMatchObject({ page: 3, state: 'failed', error: KEY_CHANGED })
    expect(readings[0]!.job).toBeUndefined()
    expect(readings[1]).toMatchObject({ page: 4, state: 'done' })
  })

  it('a finished job is collected and saved first, then deleted (KR-2, WR-2)', async () => {
    await db.cards.put(waitingCard('c1', 'b1', 'batches/one'))
    await db.prefs.put({ key: 'readings:b2', value: [{ page: 3, text: '', state: 'waiting', job: 'batches/two', createdAt: 1 }] })
    const batcher = new KeyRecordingBatcher()
    batcher.states.set('batches/one', { state: 'done', texts: { c1: 'Bitti.' }, errors: {} })
    batcher.states.set('batches/two', { state: 'done', texts: { '3': 'Üç' }, errors: {} })
    await releaseJobsOfOldKey(OLD, { batcher })
    expect(batcher.calls.some((c) => c.startsWith('cancel'))).toBe(false)
    expect(batcher.calls).toContain(`delete ${OLD} batches/one`)
    expect(batcher.storedAtDelete.get('batches/one')).toBe('Bitti.')
    expect((await db.cards.get('c1'))!.messages[1]).toMatchObject({ content: 'Bitti.' })
    expect((await db.cards.get('c1'))!.messages[1]!.state).toBeUndefined()
    expect((await getPref<{ state: string; text: string }[]>('readings:b2', []))[0]).toMatchObject({ state: 'done', text: 'Üç' })
  })

  it('leaves the open book to its own stores', async () => {
    await db.cards.put(waitingCard('c1', 'open-book', 'batches/one'))
    await db.prefs.put({ key: 'readings:open-book', value: [{ page: 3, text: '', state: 'waiting', job: 'batches/two', createdAt: 1 }] })
    const batcher = new KeyRecordingBatcher()
    expect(await releaseJobsOfOldKey(OLD, { batcher, except: 'open-book' })).toBe(0)
    expect(batcher.calls).toEqual([])
    expect((await db.cards.get('c1'))!.batchJob).toBe('batches/one')
  })

  it('in the open book: an unfinished job goes with the old key, a finished one is collected', async () => {
    const batcher = new KeyRecordingBatcher()
    batcher.states.set('batches/done', { state: 'done', texts: { c2: 'Bitti.' }, errors: {} })
    const store = new CardsStore({ bookId: 'b1', bookTitle: 'K', lang: 'tr', settings: { ...DEFAULT_SETTINGS, geminiApiKey: OLD }, batcher })
    await db.cards.bulkPut([waitingCard('c1', 'b1', 'batches/one'), waitingCard('c2', 'b1', 'batches/done')])
    await store.load()
    store.settings = { ...DEFAULT_SETTINGS, geminiApiKey: NEW }
    await store.waitForIdle()
    const byId = (id: string) => store.cards.find((c) => c.id === id)!
    expect(byId('c1').batchJob).toBeUndefined()
    expect(byId('c1').messages[1]).toMatchObject({ state: 'error', content: KEY_CHANGED })
    expect(byId('c2').messages[1]).toMatchObject({ content: 'Bitti.' })
    expect(batcher.calls).toContain(`cancel ${OLD} batches/one`)
    expect(batcher.calls).toContain(`delete ${OLD} batches/done`)
    expect(batcher.calls.some((c) => c.includes(NEW))).toBe(false)
    expect(batcher.storedAtDelete.get('batches/done')).toBe('Bitti.')
  })

  it('in the open book: a job still being made when the key changes is removed with the key that made it (KR-1)', async () => {
    const batcher = new KeyRecordingBatcher()
    let release!: () => void
    batcher.gate = new Promise((r) => (release = r))
    const store = new CardsStore({ bookId: 'b1', bookTitle: 'K', lang: 'tr', settings: { ...DEFAULT_SETTINGS, geminiApiKey: OLD }, batcher })
    store.pageCount = 20
    await store.load()
    const sources = [1, 2, 3, 4].map((page) => ({ page, text: `Page ${page}: concepts become clear at their borders.`, width: 760, height: 983 }))
    const ids = store.translatePages(sources, 'tr')
    await new Promise((r) => setTimeout(r, 10))
    expect(batcher.calls).toEqual([`create ${OLD}`])
    store.settings = { ...DEFAULT_SETTINGS, geminiApiKey: NEW }
    release()
    await store.waitForIdle()
    for (const id of ids) {
      const card = store.cards.find((c) => c.id === id)!
      expect(card.batchJob).toBeUndefined()
      expect(card.messages[1]).toMatchObject({ state: 'error', content: KEY_CHANGED })
    }
    expect(batcher.calls).toContain(`cancel ${OLD} batches/made-1`)
    expect(batcher.calls).toContain(`delete ${OLD} batches/made-1`)
    expect(batcher.calls.some((c) => c.includes(NEW))).toBe(false)
  })

  it('saving the same key again lets go of nothing', async () => {
    const batcher = new KeyRecordingBatcher()
    const store = new CardsStore({ bookId: 'b1', bookTitle: 'K', lang: 'tr', settings: { ...DEFAULT_SETTINGS, geminiApiKey: OLD }, batcher })
    await db.cards.put(waitingCard('c1', 'b1', 'batches/one'))
    await store.load()
    store.settings = { ...DEFAULT_SETTINGS, geminiApiKey: OLD, geminiModel: 'gemini-other' }
    await store.waitForIdle()
    expect(batcher.calls).toEqual([])
    expect(store.cards[0]!.batchJob).toBe('batches/one')
  })

  // Audit final F-2: a book opened while the old key's jobs are asked about leaves them alone and takes
  // the saved outcome, instead of failing the paid pages with the new key and writing that over them.
  it('a book opened meanwhile leaves the job to it and takes the saved result', async () => {
    await db.books.put({ id: 'late', title: 'L', addedAt: 1, openedAt: 1 } as never)
    await db.cards.put(waitingCard('c1', 'late', 'batches/slow'))
    const batcher = new KeyRecordingBatcher()
    batcher.states.set('batches/slow', { state: 'done', texts: { c1: 'Bitti.' }, errors: {} })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const status = batcher.status.bind(batcher)
    batcher.status = async (key: string, name: string) => {
      if (key === OLD) await held
      return status(key, name)
    }
    const releasing = releaseJobsOfOldKey(OLD, { batcher })
    await new Promise((r) => setTimeout(r, 20))
    // The book opens now, with the new key, and polls.
    const store = new CardsStore({ bookId: 'late', bookTitle: 'L', lang: 'tr', settings: { ...DEFAULT_SETTINGS, geminiApiKey: NEW }, batcher })
    await store.load()
    await store.pollBatches()
    expect(batcher.calls.filter((c) => c.startsWith(`status ${NEW}`))).toEqual([])
    expect(store.getSnapshot()[0]!.messages[1]!.state).toBe('streaming')
    release()
    await releasing
    for (let i = 0; i < 50 && store.getSnapshot()[0]!.messages[1]!.content !== 'Bitti.'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(store.getSnapshot()[0]!.messages[1]!.content).toBe('Bitti.')
    expect((await db.cards.get('c1'))!.messages[1]!.content).toBe('Bitti.')
    store.dispose()
    await db.books.delete('late')
  })
})
