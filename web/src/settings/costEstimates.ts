import estimates from '@shared/cost-estimates.json'
import type { AiTask, Effort, ProviderId } from '../ai/provider'

/**
 * Measured cost of one request (blind test of 17 Nov 2026, shared/cost-estimates.json), for the (i)
 * next to each job in Settings. Only an estimate: the real cost shows in the provider's console.
 */
const CENTS = estimates.cents as Record<string, Record<string, Record<string, number>>>

/** Dollars for one request with this model, level and job; null when it was not measured. */
export function estimatedDollars(model: string, effort: Effort | null, task: AiTask): number | null {
  if (!effort) return null
  const cents = CENTS[model]?.[effort]?.[task]
  return typeof cents === 'number' ? cents / 100 : null
}

/** A small dollar amount in the reader's language: "0,0058 $", "$0.0058". */
export function formatDollars(amount: number, lang: string): string {
  return new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 }).format(amount)
}

/** Whether a Gemini batch (half price) can apply to this job. */
export function batchApplies(provider: ProviderId, task: AiTask): boolean {
  return provider === 'gemini' && (task === 'translation' || task === 'scan')
}
