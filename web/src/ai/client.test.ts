import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiError, listModels, readSse, streamAnswer, type AiRequest } from './client'
import { ModelAdvice } from './provider'

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

function mockFetch(response: Response) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', fn)
  return fn
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const piece of gen) out += piece
  return out
}

const base: Omit<AiRequest, 'provider' | 'model'> = {
  apiKey: 'test-key-not-real-000',
  system: 'Be brief.',
  turns: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }, { type: 'image', mimeType: 'image/png', base64: 'AAAA' }] }],
}

afterEach(() => vi.unstubAllGlobals())

describe('readSse', () => {
  it('joins records split across chunks and multi-line data', async () => {
    const records = []
    for await (const r of readSse(sseStream(['event: a\nda', 'ta: 1\n\n', 'data: x\ndata: y\r\n\r\n', 'data: tail']))) records.push(r)
    expect(records).toEqual([
      { event: 'a', data: '1' },
      { event: 'message', data: 'x\ny' },
      { event: 'message', data: 'tail' },
    ])
  })
})

describe('Gemini', () => {
  it('streams text, sends the key only in the header and the image inline', async () => {
    const body = sseStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"Mer"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"haba"},{"text":"secret","thought":true}]},"finishReason":"STOP"}]}\n\n',
    ])
    const fetchFn = mockFetch(new Response(body, { status: 200 }))
    const text = await collect(streamAnswer({ ...base, provider: 'gemini', model: 'gemini-x' }))
    expect(text).toBe('Merhaba')
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toContain('/models/gemini-x:streamGenerateContent?alt=sse')
    expect(url).not.toContain(base.apiKey)
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe(base.apiKey)
    const sent = JSON.parse(String(init!.body))
    expect(sent.systemInstruction.parts[0].text).toBe('Be brief.')
    expect(sent.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } })
  })

  it('reports a blocked prompt', async () => {
    mockFetch(new Response(sseStream(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n']), { status: 200 }))
    await expect(collect(streamAnswer({ ...base, provider: 'gemini', model: 'g' }))).rejects.toMatchObject({ kind: 'blocked' })
  })
})

describe('OpenAI and DeepSeek (Chat Completions)', () => {
  it('streams delta content and asks OpenAI not to store the conversation', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])
    const fetchFn = mockFetch(new Response(body, { status: 200 }))
    const text = await collect(streamAnswer({ ...base, provider: 'openai', model: 'gpt-6.1-sol', temperature: 0.55, maxOutputTokens: 900 }))
    expect(text).toBe('Hello')
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${base.apiKey}`)
    const sent = JSON.parse(String(init!.body))
    expect(sent.store).toBe(false)
    expect(sent.stream).toBe(true)
    expect(sent.temperature).toBe(0.55)
    expect(sent.max_completion_tokens).toBe(900)
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'Be brief.' })
    expect(sent.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
  })

  it('leaves DeepSeek thinking out and never sends store', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Yanıt"}}]}\n\n',
    ])
    const fetchFn = mockFetch(new Response(body, { status: 200 }))
    const text = await collect(streamAnswer({ ...base, provider: 'deepseek', model: 'deepseek-flash' }))
    expect(text).toBe('Yanıt')
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(JSON.parse(String(init!.body)).store).toBeUndefined()
  })

  it('asks once more without the temperature when the model refuses it', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      fetchFn.mock.calls.length === 1
        ? new Response('{"error":{"message":"Unsupported value: temperature"}}', { status: 400 })
        : new Response(sseStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchFn)
    expect(await collect(streamAnswer({ ...base, provider: 'openai', model: 'o9', temperature: 0.55 }))).toBe('ok')
    expect(JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)).temperature).toBe(0.55)
    expect(JSON.parse(String(fetchFn.mock.calls[1]![1]!.body)).temperature).toBeUndefined()
  })
})

describe('Claude', () => {
  it('sends the browser header, no temperature to current models, and streams text deltas only', async () => {
    const body = sseStream([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Mer"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"haba"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    const fetchFn = mockFetch(new Response(body, { status: 200 }))
    const text = await collect(streamAnswer({ ...base, provider: 'claude', model: 'claude-sonnet-5-5', temperature: 0.55, maxOutputTokens: 8000 }))
    expect(text).toBe('Merhaba')
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init!.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(base.apiKey)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    const sent = JSON.parse(String(init!.body))
    expect(sent.temperature).toBeUndefined()
    expect(sent.max_tokens).toBe(8000)
    expect(sent.system).toBe('Be brief.')
    expect(sent.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
  })

  it('a refusal with no text is reported as blocked', async () => {
    mockFetch(new Response(sseStream(['data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n']), { status: 200 }))
    await expect(collect(streamAnswer({ ...base, provider: 'claude', model: 'claude-haiku-5-5' }))).rejects.toMatchObject({ kind: 'blocked' })
  })
})

describe('Gemini models and settings', () => {
  it('thinks high on Gemini 3 without a temperature; budget and temperature on 2.5', async () => {
    const fetchFn = vi.fn(async () => new Response(sseStream(['data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n']), { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    await collect(streamAnswer({ ...base, provider: 'gemini', model: 'gemini-3.8-flash', temperature: 0.35 }))
    await collect(streamAnswer({ ...base, provider: 'gemini', model: 'gemini-2.5-flash', temperature: 0.35 }))
    const three = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body)).generationConfig
    const two = JSON.parse(String((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body)).generationConfig
    expect(three).toEqual({ thinkingConfig: { thinkingLevel: 'high' } })
    expect(two).toEqual({ thinkingConfig: { thinkingBudget: 8192 }, temperature: 0.35 })
  })

  it('a missing model hands over to the next in the chain', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return urls.length < 3
          ? new Response('{"error":{"message":"models/x is not found"}}', { status: 404 })
          : new Response(sseStream(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']), { status: 200 })
      }),
    )
    const text = await collect(streamAnswer({ ...base, provider: 'gemini', model: 'gemini-old', candidates: ModelAdvice.geminiChain('gemini-old') }))
    expect(text).toBe('ok')
    expect(urls.map((u) => u.split('/models/')[1]!.split(':')[0])).toEqual(['gemini-old', 'gemini-3.8-flash', 'gemini-3-flash-preview'])
  })

  it('a rejected key does not try other models', async () => {
    const fetchFn = mockFetch(new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }))
    await expect(collect(streamAnswer({ ...base, provider: 'gemini', model: 'g', candidates: ModelAdvice.geminiChain('g') }))).rejects.toMatchObject({ kind: 'key' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('listModels', () => {
  it('keeps text models and talks to each provider its own way', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('anthropic')) return Response.json({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'other' }] })
      if (url.includes('deepseek')) return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] })
      return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'text-embedding-3' }, { id: 'gpt-image-2' }] })
    })
    vi.stubGlobal('fetch', fetchFn)
    expect(await listModels('claude', 'k')).toEqual(['claude-sonnet-5-5'])
    expect(await listModels('deepseek', 'k')).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(await listModels('openai', 'k')).toEqual(['gpt-6.1-sol'])
    const claudeHeaders = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(claudeHeaders['anthropic-dangerous-direct-browser-access']).toBe('true')
  })
})

describe('errors', () => {
  it.each([
    [401, '{"error":{"message":"Incorrect API key"}}', 'key'],
    [400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}', 'key'],
    [429, '{"error":{"code":"insufficient_quota"}}', 'quota'],
    [500, 'oops', 'unknown'],
  ])('HTTP %i maps to %s', async (status, text, kind) => {
    mockFetch(new Response(text, { status }))
    const error = await collect(streamAnswer({ ...base, provider: 'openai', model: 'm' })).catch((e) => e)
    expect(error).toBeInstanceOf(AiError)
    expect(error.kind).toBe(kind)
  })

  it('treats a refused cross-origin request as a browser problem', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const error = await collect(streamAnswer({ ...base, provider: 'openai', model: 'm' })).catch((e) => e)
    expect(error.kind).toBe('browser')
  })
})
