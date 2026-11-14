import { db } from '../data/db'
import { abandonBatchJob, geminiBatch, type PageBatching } from './batch'
import type { YarnCard } from '../ilmek/types'
import type { PageReading } from '../reading/pageReadings'

/**
 * A new or removed Gemini key cannot ask Google about jobs made with the old one, so they would never be
 * collected or removed. When the key changes, every waiting job in the library (page translations and page
 * readings, in books that are not open too) is cancelled and removed at Google with the OLD key, and its
 * pages say the job is gone so they can be sent again (audit 15 Nov, K-3). The open book's stores do the
 * same for what they hold in memory. Returns how many jobs were let go.
 */
export async function releaseJobsOfOldKey(oldKey: string, batcher: PageBatching = geminiBatch): Promise<number> {
  if (!oldKey) return 0
  const jobs = new Set<string>()
  await db.transaction('rw', [db.cards, db.prefs], async () => {
    const cards = await db.cards.filter((c: YarnCard) => typeof c.batchJob === 'string' && c.batchJob.length > 0).toArray()
    for (const c of cards) {
      jobs.add(c.batchJob!)
      const messages = [...c.messages]
      const i = messages.map((m) => m.role).lastIndexOf('assistant')
      if (i >= 0) messages[i] = { ...messages[i]!, state: 'error', content: 'expired' }
      const next: YarnCard = { ...c, messages }
      delete next.batchJob
      await db.cards.put(next)
    }
    const keys = ((await db.prefs.toCollection().primaryKeys()) as string[]).filter((k) => typeof k === 'string' && k.startsWith('readings:'))
    for (const key of keys) {
      const kept = (await db.prefs.get(key))?.value
      if (!Array.isArray(kept) || !kept.some((r: PageReading) => r?.job)) continue
      const next = (kept as PageReading[]).map((r) => {
        if (!r?.job) return r
        jobs.add(r.job)
        return { ...r, job: undefined, state: 'failed' as const, error: 'expired' }
      })
      await db.prefs.put({ key, value: next })
    }
  })
  await Promise.all([...jobs].map((job) => abandonBatchJob(oldKey, job, batcher).catch(() => undefined)))
  return jobs.size
}
