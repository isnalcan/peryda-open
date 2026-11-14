// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, getPref } from '../data/db'
import type { BatchStatus, PageBatching } from './batch'
import { releaseJobsOfOldKey } from './oldKeyJobs'
import { CardsStore } from '../ilmek/cardsStore'
import { DEFAULT_SETTINGS } from './provider'
import type { YarnCard } from '../ilmek/types'

class KeyRecordingBatcher implements PageBatching {
  calls: string[] = []
  async create() {
    return 'batches/x'
  }
  async status(): Promise<BatchStatus> {
    return { state: 'waiting' }
  }
  async cancel(key: string, name: string) {
    this.calls.push(`cancel ${key} ${name}`)
  }
  async delete(key: string, name: string) {
    this.calls.push(`delete ${key} ${name}`)
  }
}

const waitingCard = (id: string, bookId: string, job: string): YarnCard =>
  ({
    id, bookId, color: 'sky', kind: 'translate', anchors: [], x: 0, y: 0, width: 760, isPinned: false, collapsed: false, translatedPage: 1, translationLanguage: 'tr', batchJob: job,
    messages: [{ id: 'u', role: 'user', content: 'ÇEVİRİ', createdAt: 1 }, { id: 'a', role: 'assistant', content: '', createdAt: 2, state: 'streaming' }], createdAt: 1, updatedAt: 1,
  }) as YarnCard

// Audit 15 Nov (K-3): a changed or removed Gemini key lets go of the jobs made with the old one.
describe('Jobs of an old Gemini key', () => {
  beforeEach(async () => {
    await db.cards.clear()
    await db.prefs.clear()
  })

  it('are cancelled and removed with the old key across the library, and their pages can be sent again', async () => {
    await db.cards.put(waitingCard('c1', 'b1', 'batches/one'))
    await db.prefs.put({ key: 'readings:b2', value: [{ page: 3, text: '', state: 'waiting', job: 'batches/two', createdAt: 1 }, { page: 4, text: 'Dört', state: 'done', createdAt: 1 }] })
    const batcher = new KeyRecordingBatcher()
    expect(await releaseJobsOfOldKey('OLD-KEY-0000000000', batcher)).toBe(2)
    expect(batcher.calls.sort()).toEqual(['cancel OLD-KEY-0000000000 batches/one', 'cancel OLD-KEY-0000000000 batches/two', 'delete OLD-KEY-0000000000 batches/one', 'delete OLD-KEY-0000000000 batches/two'])
    const card = (await db.cards.get('c1'))!
    expect(card.batchJob).toBeUndefined()
    expect(card.messages[1]).toMatchObject({ state: 'error', content: 'expired' })
    const readings = await getPref<{ page: number; state: string; job?: string }[]>('readings:b2', [])
    expect(readings[0]).toMatchObject({ page: 3, state: 'failed', error: 'expired' })
    expect(readings[0]!.job).toBeUndefined()
    expect(readings[1]).toMatchObject({ page: 4, state: 'done' })
  })

  it('in the open book too, when the key changes there', async () => {
    const batcher = new KeyRecordingBatcher()
    const store = new CardsStore({ bookId: 'b1', bookTitle: 'K', lang: 'tr', settings: { ...DEFAULT_SETTINGS, geminiApiKey: 'OLD-KEY-0000000000' }, batcher })
    await db.cards.put(waitingCard('c1', 'b1', 'batches/one'))
    await store.load()
    store.settings = { ...DEFAULT_SETTINGS, geminiApiKey: 'NEW-KEY-0000000000' }
    await new Promise((r) => setTimeout(r, 20))
    expect(store.cards[0]!.batchJob).toBeUndefined()
    expect(store.cards[0]!.messages[1]).toMatchObject({ state: 'error', content: 'expired' })
    expect(batcher.calls).toContain('cancel OLD-KEY-0000000000 batches/one')
  })
})
