import { describe, expect, it } from 'vitest'
import { batchCreateBody } from './batch'
import { buildRequest } from './client'
import {
  AI_TASKS,
  DEFAULT_SETTINGS,
  ModelAdvice,
  effortFor,
  modelFor,
  normalizeSettings,
  usesRecommended,
  withEffort,
  withModel,
  withRecommended,
  type ByokSettings,
} from './provider'

/** Owner, 17 Nov 2026: each job has its own model and thinking level, the blind test's choice by default. */
describe('jobs: recommended model and thinking level', () => {
  const s: ByokSettings = { ...DEFAULT_SETTINGS, choices: {} }

  it('defaults to the blind test of 17 Nov 2026', () => {
    const table = Object.fromEntries(
      (['gemini', 'openai', 'claude'] as const).map((p) => [p, Object.fromEntries(AI_TASKS.map((t) => [t, `${modelFor(s, p, t)} ${effortFor(s, p, t)}`]))]),
    )
    expect(table).toEqual({
      gemini: {
        thread: 'gemini-4-hydrogen medium',
        area: 'gemini-3.8-flash low',
        translation: 'gemini-4-hydrogen low',
        scan: 'gemini-4-hydrogen low',
        summary: 'gemini-3.8-flash low',
      },
      openai: {
        thread: 'gpt-6.1-sol low',
        area: 'gpt-6.1-sol medium',
        translation: 'gpt-6.1-sol low',
        scan: 'gpt-6.1-sol low',
        summary: 'gpt-6.1-sol low',
      },
      claude: {
        thread: 'claude-sonnet-5-5 medium',
        area: 'claude-sonnet-5-5 low',
        translation: 'claude-haiku-5-5 medium',
        scan: 'claude-haiku-5-5 medium',
        summary: 'claude-sonnet-5-5 low',
      },
    })
    // DeepSeek was not tested: no level is sent unless the reader picks one.
    for (const t of AI_TASKS) expect(effortFor(s, 'deepseek', t)).toBeNull()
  })

  it("sends DeepSeek's pictures to deepseek-flash even when the reasoning model is chosen", () => {
    const chosen = withModel(withModel(s, 'deepseek', 'area', 'deepseek-v4-pro'), 'deepseek', 'thread', 'deepseek-v4-pro')
    expect(modelFor(chosen, 'deepseek', 'area')).toBe('deepseek-flash')
    expect(modelFor(chosen, 'deepseek', 'scan')).toBe('deepseek-flash')
    expect(modelFor(chosen, 'deepseek', 'thread')).toBe('deepseek-v4-pro')
  })

  it("keeps the reader's choices, goes back to the recommended ones, and loads old settings", () => {
    let c = withModel(s, 'openai', 'translation', 'gpt-6-luna')
    c = withEffort(c, 'openai', 'translation', 'high')
    c = withModel(c, 'gemini', 'summary', 'gemini-4-hydrogen')
    expect(modelFor(c, 'openai', 'translation')).toBe('gpt-6-luna')
    expect(effortFor(c, 'openai', 'translation')).toBe('high')
    expect(modelFor(c, 'gemini', 'summary')).toBe('gemini-4-hydrogen')
    expect(usesRecommended(c, 'openai')).toBe(false)
    const back = withRecommended(c, 'openai')
    expect(usesRecommended(back, 'openai')).toBe(true)
    expect(modelFor(back, 'gemini', 'summary')).toBe('gemini-4-hydrogen')
    // Saved and loaded again; junk keys and values are dropped.
    const loaded = normalizeSettings(JSON.parse(JSON.stringify({ ...c, choices: { ...c.choices, 'x.y.z': 'a', 'openai.thread.effort': 7 } })))
    expect(loaded.choices).toEqual(c.choices)
    expect(normalizeSettings({ geminiModel: 'gemini-3.8-flash' }).choices).toEqual({})
  })

  it('sends no level to a model that does not take one', () => {
    const old = withModel(s, 'openai', 'thread', 'gpt-4o')
    expect(effortFor(old, 'openai', 'thread')).toBeNull()
    expect(ModelAdvice.acceptsEffort('claude', 'claude-haiku-4-5')).toBe(false)
    expect(ModelAdvice.acceptsEffort('claude', 'claude-sonnet-5-5')).toBe(true)
    expect(ModelAdvice.acceptsEffort('gemini', 'gemini-2.5-flash')).toBe(false)
  })
})

describe('jobs: the level in each request', () => {
  const base = { apiKey: 'k'.repeat(20), system: 's', turns: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'q' }] }] }

  it('OpenAI reasoning_effort, Claude output_config.effort, Gemini thinkingLevel', () => {
    const o = buildRequest({ ...base, provider: 'openai', model: 'gpt-6.1-sol', effort: 'low' }, { model: 'gpt-6.1-sol', thinking: null }, 0.55).body as any
    expect(o.reasoning_effort).toBe('low')
    expect(o.temperature).toBeUndefined()
    const c = buildRequest({ ...base, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, { model: 'claude-sonnet-5-5', thinking: null }, 0.55).body as any
    expect(c.output_config).toEqual({ effort: 'medium' })
    const g = buildRequest({ ...base, provider: 'gemini', model: 'gemini-4-hydrogen', effort: 'low' }, ModelAdvice.geminiChain('gemini-4-hydrogen', 'low')[0]!, undefined).body as any
    expect(g.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    const none = buildRequest({ ...base, provider: 'openai', model: 'gpt-6.1-sol' }, { model: 'gpt-6.1-sol', thinking: null }, undefined).body as any
    expect(none.reasoning_effort).toBeUndefined()
    const older = buildRequest({ ...base, provider: 'claude', model: 'claude-haiku-4-5', effort: 'low' }, { model: 'claude-haiku-4-5', thinking: null }, undefined).body as any
    expect(older.output_config).toBeUndefined()
  })

  it('a Gemini batch job carries the level', () => {
    const body = batchCreateBody([{ key: '1', system: 's', turns: base.turns }], 'gemini-4-hydrogen', 'low') as any
    expect(body.batch.input_config.requests.requests[0].request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })
})
