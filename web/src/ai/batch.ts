import { AiError, GEMINI_BASE, fetchOrFail, geminiBody, type AiTurn } from './client'
import { ModelAdvice, thinkingFor } from './provider'

/**
 * Whole-page translation of more than two pages runs as one Gemini batch job (half the price of direct
 * requests; Google's target turnaround is 24 hours, most jobs finish much sooner). Requests go from
 * this device straight to Google with the reader's own key. Same as the Mac app's GeminiBatch.swift.
 */

export interface BatchItem {
  key: string
  system: string
  turns: AiTurn[]
}

export type BatchStatus =
  | { state: 'waiting' }
  /** Finished: translated text by key, and an error code for keys that failed. */
  | { state: 'done'; texts: Record<string, string>; errors: Record<string, string> }
  /** The job failed, expired or was cancelled as a whole. */
  | { state: 'failed'; code: string }

/** Google no longer knows the job (deleted, or older than its 48-hour limit). */
export class JobGone extends Error {}

/** Google has no batch for this model or request (for example a request too large for one job). */
export class BatchUnavailable extends Error {}

export interface PageBatching {
  create(apiKey: string, model: string, items: BatchItem[]): Promise<string>
  status(apiKey: string, name: string): Promise<BatchStatus>
  /** Stops a job nobody waits for any more, so it is not billed. Never throws. */
  cancel(apiKey: string, name: string): Promise<void>
  /** Removes a collected job (its pages and translations) from Google. Never throws. */
  delete(apiKey: string, name: string): Promise<void>
}

/**
 * Google names a job `batches/<id>`. Names are kept in cards (and so in backups); anything else is never
 * put in a request URL.
 */
const BATCH_NAME = /^batches\/[A-Za-z0-9_-]{1,128}$/

export function isBatchName(name: unknown): name is string {
  return typeof name === 'string' && BATCH_NAME.test(name)
}

/** The error a page shows when its batch went with a Gemini key the reader changed or removed (Mac: "key-changed"). */
export const KEY_CHANGED = 'key-changed'

export const BATCH_MAX_OUTPUT_TOKENS = 16_384

/** Each request carries the model's thinking and the translation temperature where the model takes one. */
export function batchCreateBody(items: readonly BatchItem[], model: string) {
  const temperature = ModelAdvice.acceptsTemperature('gemini', model) ? ModelAdvice.temperature('translation') : undefined
  return {
    batch: {
      display_name: 'peryda-page-translation',
      input_config: {
        requests: {
          requests: items.map((item) => ({
            request: geminiBody(item.system, item.turns, BATCH_MAX_OUTPUT_TOKENS, thinkingFor(model), temperature),
            metadata: { key: item.key },
          })),
        },
      },
    },
  }
}

async function send(url: string, init: RequestInit): Promise<any> {
  const res = await fetchOrFail(url, init)
  if (!res.ok) {
    let body = ''
    try {
      body = (await res.text()).toLowerCase()
    } catch {
      /* ignore */
    }
    if (res.status === 401 || res.status === 403) throw new AiError('key', 'key rejected', res.status)
    if (res.status === 400 && (body.includes('api key') || body.includes('api_key'))) throw new AiError('key', 'key rejected', res.status)
    if (res.status === 400) throw new BatchUnavailable(`batch ${res.status}`)
    if (res.status === 404) throw new JobGone('job gone')
    if (res.status === 429) throw new AiError('quota', 'limit reached', res.status)
    throw new AiError('network', `batch ${res.status}`, res.status)
  }
  try {
    return await res.json()
  } catch {
    return {}
  }
}

function inlined(json: any): any[] {
  for (const container of [json?.response, json?.dest, json?.output]) {
    if (!container || typeof container !== 'object') continue
    const list = container.inlinedResponses
    if (Array.isArray(list)) return list
    if (Array.isArray(list?.inlinedResponses)) return list.inlinedResponses
  }
  return []
}

/**
 * Reads a batch job. The documented examples differ on nesting (`metadata.state` or `state`;
 * `response.inlinedResponses` or `dest.inlinedResponses`), so both are accepted.
 */
export function parseBatchStatus(json: any): BatchStatus {
  const state: string = json?.metadata?.state ?? json?.state ?? ''
  if (/(FAILED|CANCELLED|EXPIRED)$/.test(state)) return { state: 'failed', code: state.endsWith('EXPIRED') ? 'expired' : 'unknown' }
  const finished = state.endsWith('SUCCEEDED') || json?.done === true
  if (!finished) return { state: 'waiting' }
  if (json?.error?.message) return { state: 'failed', code: 'unknown' }
  const texts: Record<string, string> = {}
  const errors: Record<string, string> = {}
  for (const item of inlined(json)) {
    const key: string = item?.metadata?.key ?? item?.key ?? ''
    if (!key) continue
    if (item?.error) {
      errors[key] = 'unknown'
      continue
    }
    const candidate = item?.response?.candidates?.[0]
    const text = (candidate?.content?.parts ?? [])
      .filter((p: any) => p?.thought !== true && typeof p?.text === 'string')
      .map((p: any) => p.text as string)
      .join('')
    if (text.trim()) texts[key] = text
    else errors[key] = candidate?.finishReason === 'SAFETY' ? 'blocked' : 'unknown'
  }
  return { state: 'done', texts, errors }
}

export const geminiBatch: PageBatching = {
  async create(apiKey, model, items) {
    let json: any
    try {
      json = await send(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:batchGenerateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(batchCreateBody(items, model)),
      })
    } catch (error) {
      // No such model or endpoint for batches.
      if (error instanceof JobGone) throw new BatchUnavailable('no batch')
      throw error
    }
    const name: unknown = json?.name
    if (!isBatchName(name)) throw new AiError('unknown', 'no job name')
    return name
  },
  async status(apiKey, name) {
    // A name that is not Google's shape cannot be asked about; the page says the job is gone.
    if (!isBatchName(name)) throw new JobGone('bad job name')
    return parseBatchStatus(await send(`${GEMINI_BASE}/${name}`, { headers: { 'x-goog-api-key': apiKey } }))
  },
  async cancel(apiKey, name) {
    if (!isBatchName(name)) return
    try {
      await send(`${GEMINI_BASE}/${name}:cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: '{}' })
    } catch {
      /* finished, already gone or unreachable: nothing more to do */
    }
  },
  async delete(apiKey, name) {
    if (!isBatchName(name)) return
    try {
      await send(`${GEMINI_BASE}/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': apiKey } })
    } catch {
      /* Google removes old jobs by itself in the end */
    }
  },
}

/** Stops a job nobody waits for any more and removes it from Google (as the Mac app's `abandon`). */
export async function abandonBatchJob(apiKey: string, name: string, batcher: PageBatching = geminiBatch): Promise<void> {
  if (!isBatchName(name) || apiKey.trim().length <= 10) return
  await batcher.cancel(apiKey, name)
  await batcher.delete(apiKey, name)
}

/** Abandons the jobs a deleted book's pages were still waiting on (with the reader's Gemini key, if any). */
export async function abandonBatchJobs(apiKey: string, names: readonly string[], batcher: PageBatching = geminiBatch): Promise<void> {
  for (const name of new Set(names)) await abandonBatchJob(apiKey, name, batcher)
}
