/**
 * The four providers a reader can bring a key for, the models the prompts were tuned for, and the
 * reader's settings. Same rules as the Mac app (mac/PerydaKit/Sources/PerydaKit/AI/Provider.swift).
 */

export type ProviderId = 'gemini' | 'openai' | 'deepseek' | 'claude'

/** Gemini first: prompts, thinking settings and page-translation batches are tuned for it. */
export const PROVIDERS: readonly ProviderId[] = ['gemini', 'openai', 'deepseek', 'claude']

/**
 * What a request is for. Each job has its own model and thinking level (owner, 17 Nov 2026): threads,
 * an area of a page (a picture), page translation, pictures of pages (scanned translation and text
 * extraction) and the Book Journal summary.
 */
export type AiTask = 'thread' | 'area' | 'translation' | 'scan' | 'summary'
export const AI_TASKS: readonly AiTask[] = ['thread', 'area', 'translation', 'scan', 'summary']

/** How hard a model is asked to think. Every tested model takes these three. */
export type Effort = 'low' | 'medium' | 'high'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high']

/** How a Gemini model is asked to think: a level (Gemini 3 and later), a token budget (2.5) or nothing. */
export type GeminiThinking = { level: string } | { budget: number } | null

/** Gemini 3 and later take a thinking level; 2.5 a budget; others nothing. */
export function thinkingFor(model: string, effort: Effort = 'high'): GeminiThinking {
  if (/^gemini-([3-9]|\d{2,})/.test(model)) return { level: effort }
  if (model.startsWith('gemini-2.5')) return { budget: 8192 }
  return null
}

/** One model to try, with how it should think (Gemini only). */
export interface ModelCandidate {
  model: string
  thinking: GeminiThinking
}

/**
 * The recommended model and thinking level for each job, from the blind test of 17 Nov 2026 (Kant, 14
 * tasks, 8 models at three levels, two blind judges; notes/model-testi-2026-11-17): the best quality,
 * and among nearly equal answers the fastest and cheapest. The first model is the default; the others
 * are listed as recommended too. DeepSeek was not in the test: its models keep the provider's own
 * thinking (no level is sent unless the reader picks one).
 */
const RECOMMENDED: Record<ProviderId, Record<AiTask, { models: string[]; effort: Effort | null }>> = {
  gemini: {
    thread: { models: ['gemini-4-hydrogen', 'gemini-3.8-flash'], effort: 'medium' },
    area: { models: ['gemini-3.8-flash', 'gemini-4-hydrogen'], effort: 'low' },
    translation: { models: ['gemini-4-hydrogen', 'gemini-3.8-flash'], effort: 'low' },
    scan: { models: ['gemini-4-hydrogen', 'gemini-3.8-flash'], effort: 'low' },
    summary: { models: ['gemini-3.8-flash', 'gemini-4-hydrogen'], effort: 'low' },
  },
  openai: {
    thread: { models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], effort: 'low' },
    area: { models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], effort: 'medium' },
    translation: { models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], effort: 'low' },
    scan: { models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], effort: 'low' },
    summary: { models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'], effort: 'low' },
  },
  deepseek: {
    thread: { models: ['deepseek-v4-pro', 'deepseek-flash'], effort: null },
    // DeepSeek's reasoning model takes no pictures.
    area: { models: ['deepseek-flash'], effort: null },
    translation: { models: ['deepseek-flash'], effort: null },
    scan: { models: ['deepseek-flash'], effort: null },
    summary: { models: ['deepseek-v4-pro', 'deepseek-flash'], effort: null },
  },
  claude: {
    thread: { models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], effort: 'medium' },
    area: { models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], effort: 'low' },
    translation: { models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], effort: 'medium' },
    scan: { models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], effort: 'medium' },
    summary: { models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], effort: 'low' },
  },
}

/** Jobs whose request carries a picture. */
export function takesPicture(task: AiTask): boolean {
  return task === 'area' || task === 'scan'
}

/** Jobs that write a translation or a transcription (kept close to the text). */
export function isTranslationLike(task: AiTask): boolean {
  return task === 'translation' || task === 'scan'
}

export const ModelAdvice = {
  /** The models the prompts and settings were tuned for; listed first and marked "Recommended". */
  recommended(provider: ProviderId, task: AiTask): string[] {
    return RECOMMENDED[provider][task].models
  },

  isRecommended(model: string, provider: ProviderId, task: AiTask): boolean {
    return RECOMMENDED[provider][task].models.includes(model)
  },

  /** The recommended thinking level for a job; null leaves the provider's own default. */
  recommendedEffort(provider: ProviderId, task: AiTask): Effort | null {
    return RECOMMENDED[provider][task].effort
  },

  /**
   * Whether a thinking level can be sent to this model: Gemini 3 and later, OpenAI's reasoning models,
   * DeepSeek's models and Claude models that take `effort`. Older models get none (they would refuse it).
   */
  acceptsEffort(provider: ProviderId, model: string): boolean {
    switch (provider) {
      case 'gemini':
        return /^gemini-([3-9]|\d{2,})/.test(model)
      case 'openai':
        return /^(o\d|gpt-[5-9]|gpt-\d{2,})/.test(model)
      case 'deepseek':
        return model.startsWith('deepseek')
      case 'claude':
        return /^claude-((opus|sonnet|haiku|fable|mythos)-([5-9]|\d{2,})|opus-4-[5-8]|sonnet-4-6)/.test(model)
    }
  },

  /** The reader's Gemini model first; if it answers 404 (or 400 naming the model), the next one. */
  geminiChain(selected: string, effort: Effort = 'high'): ModelCandidate[] {
    const chain: ModelCandidate[] = [{ model: selected, thinking: thinkingFor(selected, effort) }]
    const fallbacks: ModelCandidate[] = [
      { model: 'gemini-3.8-flash', thinking: { level: effort } },
      { model: 'gemini-4-hydrogen', thinking: { level: effort } },
      { model: 'gemini-2.5-flash', thinking: { budget: 8192 } },
      { model: 'gemini-2.5-flash', thinking: null },
    ]
    const same = (a: ModelCandidate, b: ModelCandidate) => a.model === b.model && JSON.stringify(a.thinking) === JSON.stringify(b.thinking)
    for (const c of fallbacks) if (!chain.some((x) => same(x, c))) chain.push(c)
    return chain
  },

  /** Threads may range for vivid examples; translation stays close to the text. */
  temperature(task: AiTask): number {
    return isTranslationLike(task) ? 0.35 : 0.55
  },

  /**
   * Google strongly recommends leaving Gemini 3 at its default temperature (1.0): lower values may
   * cause looping or weaker answers. Off until the owner decides otherwise.
   */
  sendTemperatureToGemini3: false,

  /** Current Claude models (5.x, Opus 4.7/4.8) reject a temperature other than the default with a 400. */
  acceptsTemperature(provider: ProviderId, model: string): boolean {
    switch (provider) {
      case 'gemini':
        return ModelAdvice.sendTemperatureToGemini3 || !model.startsWith('gemini-3')
      case 'claude':
        return /^claude-(3|(opus|sonnet|haiku)-4-[0-6]\b|(opus|sonnet|haiku)-4-[0-6]-)/.test(model)
      case 'openai':
        // OpenAI's reasoning models (o-series, GPT-5 and later, GPT-6) accept only the default (1) and
        // answer any other value with a 400; older chat models such as gpt-4o still take one.
        return !/^(o\d|gpt-[5-9]|gpt-\d{2,})/.test(model)
      default:
        return true
    }
  },

  /**
   * Room for the answer. Every request has a cap, so a book that asks for an endless answer cannot run
   * up the reader's bill. Claude's thinking counts against max_tokens, so its caps are set on their own.
   */
  maxOutputTokens(provider: ProviderId, task: AiTask): number {
    if (provider === 'claude') return isTranslationLike(task) ? 16000 : 8000
    return 16384
  },
}

export interface ByokSettings {
  activeProvider: ProviderId
  geminiApiKey: string
  geminiModel: string
  openaiApiKey: string
  openaiModel: string
  deepseekApiKey: string
  deepseekModel: string
  claudeApiKey: string
  claudeModel: string
  /** Models for page translation (empty: the first recommended). */
  geminiTranslationModel: string
  openaiTranslationModel: string
  deepseekTranslationModel: string
  claudeTranslationModel: string
  /**
   * The reader's other choices, by "provider.job.model" or "provider.job.effort" (for example
   * "gemini.area.model", "openai.thread.effort"); a missing or empty value means the recommended one.
   */
  choices: Record<string, string>
}

export const DEFAULT_SETTINGS: ByokSettings = {
  activeProvider: 'gemini',
  geminiApiKey: '',
  geminiModel: '',
  openaiApiKey: '',
  openaiModel: '',
  deepseekApiKey: '',
  deepseekModel: '',
  claudeApiKey: '',
  claudeModel: '',
  geminiTranslationModel: '',
  openaiTranslationModel: '',
  deepseekTranslationModel: '',
  claudeTranslationModel: '',
  choices: {},
}

/** Settings saved before DeepSeek and Claude existed still load: missing fields take their defaults. */
export function normalizeSettings(raw: Partial<ByokSettings> | null | undefined): ByokSettings {
  const out: ByokSettings = { ...DEFAULT_SETTINGS, choices: {} }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ByokSettings)[]) {
    const value = raw?.[key]
    if (typeof value === 'string') (out as unknown as Record<string, string>)[key] = value
  }
  const choices = raw?.choices
  if (choices && typeof choices === 'object' && !Array.isArray(choices)) {
    for (const [k, v] of Object.entries(choices)) {
      if (CHOICE_KEY.test(k) && typeof v === 'string' && v.length <= 200) out.choices[k] = v
    }
  }
  if (!PROVIDERS.includes(out.activeProvider)) out.activeProvider = 'gemini'
  return out
}

export function hasUsableKey(key: string): boolean {
  return key.trim().length > 10
}

const KEY_FIELD: Record<ProviderId, 'geminiApiKey' | 'openaiApiKey' | 'deepseekApiKey' | 'claudeApiKey'> = {
  gemini: 'geminiApiKey',
  openai: 'openaiApiKey',
  deepseek: 'deepseekApiKey',
  claude: 'claudeApiKey',
}

/** "provider.job.model" or "provider.job.effort". */
const CHOICE_KEY = /^(gemini|openai|deepseek|claude)\.(thread|area|translation|scan|summary)\.(model|effort)$/

/** Threads and page translation keep their original fields (older saved settings still load). */
const MODEL_FIELD: Record<ProviderId, Partial<Record<AiTask, keyof ByokSettings>>> = {
  gemini: { thread: 'geminiModel', translation: 'geminiTranslationModel' },
  openai: { thread: 'openaiModel', translation: 'openaiTranslationModel' },
  deepseek: { thread: 'deepseekModel', translation: 'deepseekTranslationModel' },
  claude: { thread: 'claudeModel', translation: 'claudeTranslationModel' },
}

/** The key as typed (for the settings field). */
export function chosenKey(settings: ByokSettings, provider: ProviderId): string {
  return settings[KEY_FIELD[provider]] ?? ''
}

export function keyFor(settings: ByokSettings, provider: ProviderId): string {
  return chosenKey(settings, provider).trim()
}

export function withKey(settings: ByokSettings, provider: ProviderId, key: string): ByokSettings {
  return { ...settings, [KEY_FIELD[provider]]: key }
}

export function chosenModel(settings: ByokSettings, provider: ProviderId, task: AiTask): string {
  const field = MODEL_FIELD[provider][task]
  if (field) return (settings[field] as string | undefined) ?? ''
  return settings.choices?.[`${provider}.${task}.model`] ?? ''
}

/** The reader's model for a job; an empty string goes back to the recommended one. */
export function withModel(settings: ByokSettings, provider: ProviderId, task: AiTask, model: string): ByokSettings {
  const field = MODEL_FIELD[provider][task]
  if (field) return { ...settings, [field]: model }
  return { ...settings, choices: { ...settings.choices, [`${provider}.${task}.model`]: model } }
}

/** The model for a job: the reader's choice, or the first recommended. */
export function modelFor(settings: ByokSettings, provider: ProviderId, task: AiTask = 'thread'): string {
  const model = chosenModel(settings, provider, task) || ModelAdvice.recommended(provider, task)[0]!
  // DeepSeek's reasoning model takes no pictures: pictures always go to deepseek-flash.
  if (provider === 'deepseek' && takesPicture(task) && model === 'deepseek-v4-pro') return 'deepseek-flash'
  return model
}

/** The reader's thinking level for a job, or '' for the recommended one. */
export function chosenEffort(settings: ByokSettings, provider: ProviderId, task: AiTask): Effort | '' {
  const value = settings.choices?.[`${provider}.${task}.effort`] ?? ''
  return (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : ''
}

export function withEffort(settings: ByokSettings, provider: ProviderId, task: AiTask, effort: Effort | ''): ByokSettings {
  return { ...settings, choices: { ...settings.choices, [`${provider}.${task}.effort`]: effort } }
}

/** Every job of a provider back to its recommended model and thinking level. */
export function withRecommended(settings: ByokSettings, provider: ProviderId): ByokSettings {
  let next: ByokSettings = { ...settings, choices: { ...settings.choices } }
  for (const task of AI_TASKS) {
    next = withModel(next, provider, task, '')
    delete next.choices[`${provider}.${task}.model`]
    delete next.choices[`${provider}.${task}.effort`]
  }
  return next
}

/**
 * The thinking level a job is sent with: the reader's, else the recommended one; null (nothing sent)
 * when neither applies or the model does not take one.
 */
export function effortFor(settings: ByokSettings, provider: ProviderId, task: AiTask, model = modelFor(settings, provider, task)): Effort | null {
  if (!ModelAdvice.acceptsEffort(provider, model)) return null
  return chosenEffort(settings, provider, task) || ModelAdvice.recommendedEffort(provider, task)
}

/** Whether a provider's jobs all use the recommended models and levels. */
export function usesRecommended(settings: ByokSettings, provider: ProviderId): boolean {
  return AI_TASKS.every((task) => !chosenEffort(settings, provider, task) && (!chosenModel(settings, provider, task) || chosenModel(settings, provider, task) === ModelAdvice.recommended(provider, task)[0]))
}

export function providersWithKeys(settings: ByokSettings): ProviderId[] {
  return PROVIDERS.filter((p) => hasUsableKey(chosenKey(settings, p)))
}

/**
 * The reader's chosen provider when it has a key; otherwise the first with a key (Gemini, OpenAI,
 * DeepSeek, Claude); none without keys.
 */
export function resolveActiveProvider(settings: ByokSettings): ProviderId | null {
  if (hasUsableKey(chosenKey(settings, settings.activeProvider))) return settings.activeProvider
  return providersWithKeys(settings)[0] ?? null
}
