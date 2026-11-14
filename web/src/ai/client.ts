import { ModelAdvice, thinkingFor, type GeminiThinking, type ModelCandidate, type ProviderId } from './provider'

/**
 * Bring-your-own-key streaming clients. Requests go straight from this device to the reader's provider;
 * the key is sent only to the provider it belongs to and is never logged or stored by this module.
 * Same request shapes as the Mac app (mac/PerydaKit/Sources/PerydaKit/AI/AIClient.swift).
 */

export type AiPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }

export interface AiTurn {
  role: 'user' | 'assistant'
  parts: AiPart[]
}

export interface AiRequest {
  provider: ProviderId
  apiKey: string
  /** The first model to use; `candidates` (Gemini) adds fallbacks. */
  model: string
  system: string
  turns: AiTurn[]
  signal?: AbortSignal
  maxOutputTokens?: number
  /** The wanted temperature; left out for models that refuse or are better without one. */
  temperature?: number
  candidates?: ModelCandidate[]
}

export type AiErrorKind = 'network' | 'key' | 'quota' | 'blocked' | 'browser' | 'aborted' | 'unknown'

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly status?: number
  constructor(kind: AiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
    this.status = status
  }
}

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const OPENAI_BASE = 'https://api.openai.com/v1'
const DEEPSEEK_BASE = 'https://api.deepseek.com'
const CLAUDE_BASE = 'https://api.anthropic.com/v1'
const CLAUDE_VERSION = '2023-06-01'

/** Splits a server-sent-events byte stream into { event, data } records. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
        const record = parseSseRecord(chunk)
        if (record) yield record
      }
    }
    const tail = parseSseRecord(buffer)
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

function parseSseRecord(chunk: string): { event: string; data: string } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length ? { event, data: data.join('\n') } : null
}

/** An HTTP error before any text arrived, with what is needed to decide on a fallback. */
export class HttpFailure extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string) {
    super(`http ${status}`)
    this.status = status
    this.body = body
  }
}

export async function fetchOrFail(url: string, init: RequestInit): Promise<Response> {
  try {
    // A redirect is refused rather than followed: a key header must never go on to another address, and
    // nothing a provider sends back is kept in the browser's cache (audit 15 Nov, K-1).
    return await fetch(url, { ...init, ...REQUEST_RULES })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new AiError('aborted', 'aborted')
    // A browser that blocks the request for CORS reasons reports it as a plain network failure.
    throw new AiError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'network' : 'browser', 'request failed')
  }
}

/** How every request to a provider is made (exported for tests). */
export const REQUEST_RULES = { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' } as const satisfies RequestInit

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 4000)
  } catch {
    return ''
  }
}

export function errorFromStatus(status: number, body: string): AiError {
  const lower = body.toLowerCase()
  if (status === 401 || status === 403 || lower.includes('api_key_invalid') || lower.includes('invalid api key') || lower.includes('incorrect api key') || lower.includes('invalid x-api-key')) {
    return new AiError('key', 'key rejected', status)
  }
  if (status === 429 || lower.includes('quota') || lower.includes('insufficient_quota')) return new AiError('quota', 'limit reached', status)
  return new AiError('unknown', `provider error ${status}`, status)
}

function textOf(turn: AiTurn): string {
  return turn.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** A Gemini generateContent request body (also used inside batch jobs). */
export function geminiBody(system: string, turns: AiTurn[], maxOutputTokens: number | undefined, thinking: GeminiThinking, temperature: number | undefined) {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: turn.parts.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.base64 } })),
    })),
  }
  const config: Record<string, unknown> = {}
  if (maxOutputTokens) config.maxOutputTokens = maxOutputTokens
  if (thinking && 'level' in thinking) config.thinkingConfig = { thinkingLevel: thinking.level }
  if (thinking && 'budget' in thinking) config.thinkingConfig = { thinkingBudget: thinking.budget }
  if (temperature !== undefined) config.temperature = temperature
  if (Object.keys(config).length) body.generationConfig = config
  return body
}

/** OpenAI and DeepSeek share the Chat Completions shape. */
export function chatBody(model: string, system: string, turns: AiTurn[], maxOutputTokens: number | undefined, temperature: number | undefined) {
  const messages: unknown[] = [{ role: 'system', content: system }]
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      messages.push({ role: 'assistant', content: textOf(turn) })
    } else {
      messages.push({
        role: 'user',
        content: turn.parts.map((p) =>
          p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}` } },
        ),
      })
    }
  }
  const body: Record<string, unknown> = { model, messages, stream: true }
  if (maxOutputTokens) body.max_completion_tokens = maxOutputTokens
  if (temperature !== undefined) body.temperature = temperature
  return body
}

export function claudeBody(model: string, system: string, turns: AiTurn[], maxOutputTokens: number | undefined, temperature: number | undefined) {
  const body: Record<string, unknown> = {
    model,
    system,
    max_tokens: maxOutputTokens ?? 8000,
    stream: true,
    messages: turns.map((turn) =>
      turn.role === 'assistant'
        ? { role: 'assistant', content: textOf(turn) }
        : {
            role: 'user',
            content: turn.parts.map((p) =>
              p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.base64 } },
            ),
          },
    ),
  }
  if (temperature !== undefined) body.temperature = temperature
  return body
}

/** URL, headers and body for one attempt. */
export function buildRequest(req: AiRequest, candidate: ModelCandidate, temperature: number | undefined): { url: string; headers: Record<string, string>; body: unknown } {
  const model = candidate.model
  const temp = temperature !== undefined && ModelAdvice.acceptsTemperature(req.provider, model) ? temperature : undefined
  const json = { 'content-type': 'application/json' }
  switch (req.provider) {
    case 'gemini':
      return {
        url: `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        headers: { ...json, 'x-goog-api-key': req.apiKey },
        body: geminiBody(req.system, req.turns, req.maxOutputTokens, candidate.thinking, temp),
      }
    case 'openai':
      // OpenAI is asked not to keep the conversation; it stays on this device.
      return {
        url: `${OPENAI_BASE}/chat/completions`,
        headers: { ...json, authorization: `Bearer ${req.apiKey}` },
        body: { ...chatBody(model, req.system, req.turns, req.maxOutputTokens, temp), store: false },
      }
    case 'deepseek':
      return {
        url: `${DEEPSEEK_BASE}/chat/completions`,
        headers: { ...json, authorization: `Bearer ${req.apiKey}` },
        body: chatBody(model, req.system, req.turns, req.maxOutputTokens, temp),
      }
    case 'claude':
      return {
        url: `${CLAUDE_BASE}/messages`,
        // Anthropic accepts requests from a browser only with this header; the key is the reader's own.
        headers: { ...json, 'x-api-key': req.apiKey, 'anthropic-version': CLAUDE_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' },
        body: claudeBody(model, req.system, req.turns, req.maxOutputTokens, temp),
      }
  }
}

/** Text pieces carried by one SSE record; `state.produced` notes whether any answer text arrived. */
export function piecesOf(provider: ProviderId, event: string, data: string, state: { produced: boolean }): string[] {
  if (data === '[DONE]') return []
  let json: any
  try {
    json = JSON.parse(data)
  } catch {
    return []
  }
  switch (provider) {
    case 'gemini': {
      if (json?.error) throw new AiError('unknown', 'provider error', json.error.code)
      if (json?.promptFeedback?.blockReason) throw new AiError('blocked', 'blocked')
      const candidate = json?.candidates?.[0]
      const out: string[] = []
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part?.text === 'string' && !part.thought) {
          out.push(part.text)
          state.produced = true
        }
      }
      if (!state.produced && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(candidate?.finishReason)) throw new AiError('blocked', 'blocked')
      return out
    }
    case 'openai':
    case 'deepseek': {
      // Only `delta.content` is the answer; DeepSeek's thinking arrives in `reasoning_content` and is left out.
      if (json?.error) {
        const code = String(json.error.code ?? json.error.type ?? '')
        throw new AiError(code.includes('quota') || code.includes('rate') ? 'quota' : 'unknown', 'provider error')
      }
      const choice = json?.choices?.[0]
      const delta = choice?.delta
      if (typeof delta?.refusal === 'string' && delta.refusal) throw new AiError('blocked', 'refused')
      if (choice?.finish_reason === 'content_filter' && !state.produced) throw new AiError('blocked', 'blocked')
      if (typeof delta?.content === 'string' && delta.content) {
        state.produced = true
        return [delta.content]
      }
      return []
    }
    case 'claude': {
      const type: string = json?.type ?? event
      if (type === 'content_block_delta') {
        // Only text; thinking deltas are left out.
        if (json?.delta?.type === 'text_delta' && typeof json.delta.text === 'string') {
          state.produced = true
          return [json.delta.text]
        }
        return []
      }
      if (type === 'message_delta') {
        if (json?.delta?.stop_reason === 'refusal' && !state.produced) throw new AiError('blocked', 'refused')
        return []
      }
      if (type === 'error') {
        const kind = String(json?.error?.type ?? '')
        throw new AiError(kind.includes('rate_limit') || kind.includes('overloaded') ? 'quota' : kind.includes('authentication') ? 'key' : 'unknown', 'provider error')
      }
      return []
    }
  }
}

async function* attempt(req: AiRequest, candidate: ModelCandidate, temperature: number | undefined): AsyncGenerator<string> {
  const { url, headers, body } = buildRequest(req, candidate, temperature)
  const res = await fetchOrFail(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal })
  if (!res.ok) throw new HttpFailure(res.status, await bodyText(res))
  if (!res.body) throw new AiError('unknown', 'empty response', res.status)
  const state = { produced: false }
  for await (const { event, data } of readSse(res.body)) {
    for (const piece of piecesOf(req.provider, event, data, state)) yield piece
  }
}

/**
 * Streams the answer as text pieces; throws AiError. A Gemini model that is not available (404, or a
 * 400 naming the model) hands over to the next candidate; a model that refuses the temperature is asked
 * once more without it.
 */
export async function* streamAnswer(req: AiRequest): AsyncGenerator<string> {
  const candidates = req.candidates?.length
    ? req.candidates
    : [{ model: req.model, thinking: req.provider === 'gemini' ? thinkingFor(req.model) : null }]
  let last: HttpFailure | null = null
  try {
    for (const candidate of candidates) {
      let temperature = req.temperature
      for (;;) {
        try {
          yield* attempt(req, candidate, temperature)
          return
        } catch (error) {
          if (!(error instanceof HttpFailure)) throw error
          last = error
          const lower = error.body.toLowerCase()
          if (error.status === 400 && temperature !== undefined && lower.includes('temperature')) {
            temperature = undefined
            continue
          }
          const modelMissing = error.status === 404 || (error.status === 400 && lower.includes('model'))
          if (req.provider === 'gemini' && modelMissing) break
          throw errorFromStatus(error.status, error.body)
        }
      }
    }
    if (last) throw errorFromStatus(last.status, last.body)
  } catch (error) {
    if (error instanceof AiError) throw error
    if ((error as Error)?.name === 'AbortError') throw new AiError('aborted', 'aborted')
    throw new AiError('network', 'stream failed')
  }
}

/** Models that can answer text questions, for "Load models". */
export async function listModels(provider: ProviderId, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  let url: string
  let headers: Record<string, string>
  switch (provider) {
    case 'gemini':
      url = `${GEMINI_BASE}/models?pageSize=1000`
      headers = { 'x-goog-api-key': apiKey }
      break
    case 'openai':
      url = `${OPENAI_BASE}/models`
      headers = { authorization: `Bearer ${apiKey}` }
      break
    case 'deepseek':
      url = `${DEEPSEEK_BASE}/models`
      headers = { authorization: `Bearer ${apiKey}` }
      break
    case 'claude':
      url = `${CLAUDE_BASE}/models?limit=1000`
      headers = { 'x-api-key': apiKey, 'anthropic-version': CLAUDE_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }
      break
  }
  const res = await fetchOrFail(url, { headers, signal })
  if (!res.ok) throw errorFromStatus(res.status, await bodyText(res))
  const json: any = await res.json()
  const ids: string[] = (json?.data ?? []).map((m: any) => String(m?.id ?? ''))
  switch (provider) {
    case 'gemini':
      return (json?.models ?? [])
        .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m: any) => String(m.name).replace(/^models\//, ''))
        .filter((id: string) => id.startsWith('gemini-') && !/embedding|aqa|imagen|tts|image-generation|live/.test(id))
    case 'openai':
      return ids
        .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|search|moderation|instruct/.test(id))
        .sort()
    case 'deepseek':
      return ids.filter((id) => id.startsWith('deepseek')).sort()
    case 'claude':
      return ids.filter((id) => id.startsWith('claude-'))
  }
}
