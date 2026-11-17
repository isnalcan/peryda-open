import { describe, expect, it } from 'vitest'
import { AI_TASKS, DEFAULT_SETTINGS, effortFor, modelFor } from '../ai/provider'
import { batchApplies, estimatedDollars, formatDollars } from './costEstimates'

describe('cost estimates (owner, 17 Nov 2026)', () => {
  it('has a measured estimate for every recommended job of the tested providers', () => {
    const s = { ...DEFAULT_SETTINGS, choices: {} }
    for (const p of ['gemini', 'openai', 'claude'] as const)
      for (const t of AI_TASKS) {
        const d = estimatedDollars(modelFor(s, p, t), effortFor(s, p, t), t)
        expect(d, `${p} ${t}`).not.toBeNull()
        expect(d!).toBeGreaterThan(0)
        expect(d!).toBeLessThan(0.05)
      }
    // DeepSeek was not measured.
    expect(estimatedDollars(modelFor(s, 'deepseek', 'thread'), effortFor(s, 'deepseek', 'thread'), 'thread')).toBeNull()
  })

  it('formats small amounts and knows where a Gemini batch applies', () => {
    expect(formatDollars(0.0058, 'en')).toBe('$0.0058')
    expect(formatDollars(0.0058, 'tr')).toMatch(/0,0058/)
    expect(batchApplies('gemini', 'translation')).toBe(true)
    expect(batchApplies('openai', 'translation')).toBe(false)
    expect(batchApplies('gemini', 'thread')).toBe(false)
  })
})
