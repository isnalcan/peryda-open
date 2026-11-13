/**
 * The four providers a reader can bring a key for, the models the prompts were tuned for, and the
 * reader's settings. Same rules as the Mac app (mac/PerydaKit/Sources/PerydaKit/AI/Provider.swift).
 */

export type ProviderId = 'gemini' | 'openai' | 'deepseek' | 'claude'

/** Gemini first: prompts, thinking settings and page-translation batches are tuned for it. */
export const PROVIDERS: readonly ProviderId[] = ['gemini', 'openai', 'deepseek', 'claude']

/** What a request is for. Threads and page translations have their own models and settings. */
export type AiTask = 'thread' | 'translation'

/** How a Gemini model is asked to think: a level (Gemini 3), a token budget (2.5) or nothing. */
export type GeminiThinking = { level: string } | { budget: number } | null

export function thinkingFor(model: string): GeminiThinking {
  if (model.startsWith('gemini-3')) return { level: 'high' }
  if (model.startsWith('gemini-2.5')) return { budget: 8192 }
  return null
}

/** One model to try, with how it should think (Gemini only). */
export interface ModelCandidate {
  model: string
  thinking: GeminiThinking
}

const RECOMMENDED: Record<ProviderId, Record<AiTask, string[]>> = {
  gemini: {
    thread: ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
    translation: ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
  },
  openai: { thread: ['gpt-6.1-sol', 'gpt-6.1-terra'], translation: ['gpt-6.1-terra', 'gpt-6-luna'] },
  deepseek: { thread: ['deepseek-v4-pro', 'deepseek-flash'], translation: ['deepseek-flash'] },
  claude: { thread: ['claude-sonnet-5-5', 'claude-haiku-5-5'], translation: ['claude-haiku-5-5', 'claude-sonnet-5-5'] },
}

export const ModelAdvice = {
  /** The models the prompts and settings were tuned for; listed first and marked "Recommended". */
  recommended(provider: ProviderId, task: AiTask): string[] {
    return RECOMMENDED[provider][task]
  },

  isRecommended(model: string, provider: ProviderId, task: AiTask): boolean {
    return RECOMMENDED[provider][task].includes(model)
  },

  /** The reader's Gemini model first; if it answers 404 (or 400 naming the model), the next one. */
  geminiChain(selected: string): ModelCandidate[] {
    const chain: ModelCandidate[] = [{ model: selected, thinking: thinkingFor(selected) }]
    const fallbacks: ModelCandidate[] = [
      { model: 'gemini-3.8-flash', thinking: { level: 'high' } },
      { model: 'gemini-3-flash-preview', thinking: { level: 'high' } },
      { model: 'gemini-2.5-flash', thinking: { budget: 8192 } },
      { model: 'gemini-2.5-flash', thinking: null },
    ]
    const same = (a: ModelCandidate, b: ModelCandidate) => a.model === b.model && JSON.stringify(a.thinking) === JSON.stringify(b.thinking)
    for (const c of fallbacks) if (!chain.some((x) => same(x, c))) chain.push(c)
    return chain
  },

  /** Threads may range for vivid examples; translation stays close to the text. */
  temperature(task: AiTask): number {
    return task === 'thread' ? 0.55 : 0.35
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
      default:
        return true
    }
  },

  /**
   * Room for the answer. Every request has a cap, so a book that asks for an endless answer cannot run
   * up the reader's bill. Claude's thinking counts against max_tokens, so its caps are set on their own.
   */
  maxOutputTokens(provider: ProviderId, task: AiTask): number {
    if (provider === 'claude') return task === 'thread' ? 8000 : 16000
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
}

/** Settings saved before DeepSeek and Claude existed still load: missing fields take their defaults. */
export function normalizeSettings(raw: Partial<ByokSettings> | null | undefined): ByokSettings {
  const out: ByokSettings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ByokSettings)[]) {
    const value = raw?.[key]
    if (typeof value === 'string') (out as unknown as Record<string, string>)[key] = value
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

const MODEL_FIELD: Record<ProviderId, Record<AiTask, keyof ByokSettings>> = {
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
  return (settings[MODEL_FIELD[provider][task]] as string | undefined) ?? ''
}

export function withModel(settings: ByokSettings, provider: ProviderId, task: AiTask, model: string): ByokSettings {
  return { ...settings, [MODEL_FIELD[provider][task]]: model }
}

/** The model for a task: the reader's choice, or the first recommended. */
export function modelFor(settings: ByokSettings, provider: ProviderId, task: AiTask = 'thread'): string {
  return chosenModel(settings, provider, task) || ModelAdvice.recommended(provider, task)[0]!
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
