import { db } from '../data/db'
import { KEY_CHANGED, abandonBatchJob, geminiBatch, isBatchName, type BatchStatus, type PageBatching } from './batch'
import type { YarnCard, YarnMessage } from '../ilmek/types'
import type { PageReading } from '../reading/pageReadings'
import { withoutPageImage } from '../ilmek/cardsStore'

export interface ReleaseOptions {
  /** The open book: its own stores collect or let go of what they hold. */
  except?: string
  batcher?: PageBatching
}

/**
 * A new or removed Gemini key cannot ask Google about jobs made with the old one, so they would never be
 * collected or removed. When the key changes, each waiting job in the library (page translations and page
 * readings, in books that are not open) is asked about ONCE with the OLD key: a finished job's results are
 * kept (they are paid for), saved here first and only then deleted at Google; an unfinished job is
 * cancelled and removed with the old key, and its pages say the key changed so they can be sent again
 * (audit 15 Nov, K-3, KR-2, WR-2, WR-5). The old key goes to Google only. Returns how many jobs were
 * handled.
 */
export async function releaseJobsOfOldKey(oldKey: string, options: ReleaseOptions = {}): Promise<number> {
  if (!oldKey) return 0
  const batcher = options.batcher ?? geminiBatch
  const except = options.except
  const exceptReadings = except === undefined ? undefined : `readings:${except}`
  const jobs = new Set<string>()
  const cards = await db.cards.filter((c: YarnCard) => typeof c.batchJob === 'string' && c.batchJob.length > 0 && c.bookId !== except).toArray()
  for (const c of cards) jobs.add(c.batchJob!)
  const readingKeys = ((await db.prefs.toCollection().primaryKeys()) as string[]).filter((k) => typeof k === 'string' && k.startsWith('readings:') && k !== exceptReadings)
  for (const key of readingKeys) {
    const kept = (await db.prefs.get(key))?.value
    if (Array.isArray(kept)) for (const r of kept as PageReading[]) if (typeof r?.job === 'string' && r.job) jobs.add(r.job)
  }
  for (const job of jobs) {
    let status: BatchStatus | null = null
    if (isBatchName(job)) {
      try {
        status = await batcher.status(oldKey, job)
      } catch {
        status = null
      }
    }
    const finished = status?.state === 'done' ? status : null
    await db.transaction('rw', [db.cards, db.prefs], async () => {
      const onJob = await db.cards.filter((c: YarnCard) => c.batchJob === job && c.bookId !== except).toArray()
      for (const c of onJob) {
        const text = finished?.texts[c.id]?.trim()
        const messages = [...c.messages]
        const i = messages.map((m) => m.role).lastIndexOf('assistant')
        const content = text ? text : finished ? (finished.errors[c.id] ?? 'unknown') : KEY_CHANGED
        if (i >= 0) {
          const next: YarnMessage = { ...messages[i]!, content, state: text ? undefined : 'error' }
          if (text) delete next.state
          messages[i] = next
        }
        const next: YarnCard = { ...(text ? withoutPageImage(c) : c), messages }
        delete next.batchJob
        await db.cards.put(next)
      }
      for (const key of readingKeys) {
        const kept = (await db.prefs.get(key))?.value
        if (!Array.isArray(kept) || !kept.some((r: PageReading) => r?.job === job)) continue
        const next = (kept as PageReading[]).map((r): PageReading => {
          if (r?.job !== job) return r
          const text = finished?.texts[String(r.page)]?.trim()
          if (text) return { ...r, text, state: 'done', job: undefined, error: undefined }
          return { ...r, job: undefined, state: 'failed', error: finished ? (finished.errors[String(r.page)] ?? 'unknown') : KEY_CHANGED }
        })
        await db.prefs.put({ key, value: next })
      }
    })
    // Saved above; only now is the job let go at Google, with the key that made it.
    if (finished) await batcher.delete(oldKey, job).catch(() => undefined)
    else await abandonBatchJob(oldKey, job, batcher).catch(() => undefined)
  }
  return jobs.size
}
