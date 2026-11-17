import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18n'
import { LANGS, type Lang, type Strings } from '../i18n/strings'
import { listModels } from '../ai/client'
import {
  AI_TASKS,
  EFFORTS,
  ModelAdvice,
  PROVIDERS,
  chosenEffort,
  chosenKey,
  effortFor,
  hasUsableKey,
  keyFor,
  modelFor,
  providersWithKeys,
  resolveActiveProvider,
  usesRecommended,
  withEffort,
  withKey,
  withModel,
  withRecommended,
  type AiTask,
  type ByokSettings,
  type Effort,
  type ProviderId,
} from '../ai/provider'
import { maskKey } from '../data/keyVault'
import { CloseIcon, InfoIcon, KeyIcon } from '../ui/icons'
import { KEY_PAGES, keyHelpText, openKeyPageInShell } from './keyPages'
import { batchApplies, estimatedDollars, formatDollars } from './costEstimates'
import { privacyFor } from './privacy'
import { inDesktopApp, type DesktopUpdates } from '../updates/desktopUpdates'
import { UpdateSection } from '../updates/UpdateViews'

export type ThemePref = 'system' | 'light' | 'dark'

interface Props {
  settings: ByokSettings
  remember: boolean
  lang: Lang
  theme: ThemePref
  onSave: (settings: ByokSettings, remember: boolean) => Promise<void>
  onLang: (lang: Lang) => void
  onTheme: (theme: ThemePref) => void
  onClose: () => void
  /** The Windows app's update check; absent on the web, where the page is always the newest. */
  updates?: DesktopUpdates | null
}

const LANG_NAMES: Record<Lang, string> = { tr: 'Türkçe', en: 'English', de: 'Deutsch', es: 'Español' }

const PLACEHOLDER: Record<ProviderId, string> = { gemini: 'AIza…', openai: 'sk-…', deepseek: 'sk-…', claude: 'sk-ant-…' }

function providerName(t: Strings, p: ProviderId): string {
  return { gemini: t.provider_gemini, openai: t.provider_openai, deepseek: t.provider_deepseek, claude: t.provider_claude }[p]
}

function keyLabel(t: Strings, p: ProviderId): string {
  return { gemini: t.geminiKey, openai: t.openaiKey, deepseek: t.deepseekKey, claude: t.claudeKey }[p]
}

function jobLabel(t: Strings, task: AiTask): string {
  return { thread: t.jobThread, area: t.jobArea, translation: t.jobTranslation, scan: t.jobScan, summary: t.jobSummary }[task]
}

function effortLabel(t: Strings, effort: Effort): string {
  return { low: t.effort_low, medium: t.effort_medium, high: t.effort_high }[effort]
}

/**
 * One job (owner, 17 Nov 2026): its model and its thinking level, the recommended ones chosen by
 * default and marked; the reader may pick others. Choosing the recommended model again stores nothing,
 * so a later recommendation reaches the reader.
 */
/** What one request of a job is counted in: a question, a page or a summary. */
function costUnit(t: Strings, task: AiTask): string {
  return task === 'translation' || task === 'scan' ? t.costUnit_page : task === 'summary' ? t.costUnit_summary : t.costUnit_question
}

function JobRow(props: { provider: ProviderId; task: AiTask; settings: ByokSettings; loaded: string[]; onChange: (s: ByokSettings) => void }) {
  const { t, lang } = useI18n()
  const id = useId()
  const [costOpen, setCostOpen] = useState(false)
  const recommended = ModelAdvice.recommended(props.provider, props.task)
  const current = modelFor(props.settings, props.provider, props.task)
  const others = [...new Set([...props.loaded, current])].filter((m) => !recommended.includes(m)).sort()
  const recommendedEffort = ModelAdvice.recommendedEffort(props.provider, props.task)
  const effort = chosenEffort(props.settings, props.provider, props.task)
  const takesEffort = ModelAdvice.acceptsEffort(props.provider, current)
  const label = jobLabel(t, props.task)
  const dollars = estimatedDollars(current, effortFor(props.settings, props.provider, props.task, current), props.task)
  return (
    <div className="job-row" role="group" aria-labelledby={`${id}-label`}>
      <span className="job-label" id={`${id}-label`}>
        {/* The estimated cost of one request (owner, 17 Nov 2026). */}
        <button
          type="button"
          className="key-help-toggle"
          aria-expanded={costOpen}
          aria-controls={`${id}-cost`}
          aria-label={`${label}: ${t.costInfo}`}
          title={t.costInfo}
          onClick={() => setCostOpen(!costOpen)}
        >
          <InfoIcon size={14} />
        </button>
        {label}
      </span>
      <select
        aria-label={`${label}: ${t.jobModel}`}
        value={current}
        onChange={(e) => props.onChange(withModel(props.settings, props.provider, props.task, e.target.value === recommended[0] ? '' : e.target.value))}
      >
        <optgroup label={t.recommended}>
          {recommended.map((m, i) => (
            <option key={m} value={m}>
              {i === 0 ? `${m} · ${t.recommended}` : m}
            </option>
          ))}
        </optgroup>
        {others.length > 0 && (
          <optgroup label={t.otherModels}>
            {others.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <select
        aria-label={`${label}: ${t.jobEffort}`}
        value={takesEffort ? effort : ''}
        disabled={!takesEffort}
        onChange={(e) => props.onChange(withEffort(props.settings, props.provider, props.task, e.target.value as Effort | ''))}
      >
        <option value="">{recommendedEffort ? `${effortLabel(t, recommendedEffort)} · ${t.recommended}` : t.effortProviderDefault}</option>
        {EFFORTS.filter((e) => e !== recommendedEffort).map((e) => (
          <option key={e} value={e}>
            {effortLabel(t, e)}
          </option>
        ))}
      </select>
      {costOpen && (
        <p className="job-cost" id={`${id}-cost`}>
          {dollars !== null ? t.costEstimate(formatDollars(dollars, lang), costUnit(t, props.task)) : t.costUnknown}
          {dollars !== null && batchApplies(props.provider, props.task) && ` ${t.costBatch}`}
        </p>
      )}
    </div>
  )
}

/** The provider's jobs, with the note that the recommended combination is chosen by default. */
function JobTable(props: { provider: ProviderId; settings: ByokSettings; loaded: string[]; onChange: (s: ByokSettings) => void }) {
  const { t } = useI18n()
  const recommended = usesRecommended(props.settings, props.provider)
  return (
    <div className="job-table">
      <div className="job-head">
        <strong>{t.jobsTitle}</strong>
        {recommended ? (
          <span className="recommended-badge">{t.usingRecommended}</span>
        ) : (
          <button type="button" className="text-button" onClick={() => props.onChange(withRecommended(props.settings, props.provider))}>
            {t.resetRecommended}
          </button>
        )}
      </div>
      <p className="job-note">{props.provider === 'deepseek' ? t.comboNoteUntested : t.comboNote}</p>
      <div className="job-columns" aria-hidden="true">
        <span />
        <span>{t.jobModel}</span>
        <span>{t.jobEffort}</span>
      </div>
      {AI_TASKS.map((task) => (
        <JobRow key={task} provider={props.provider} task={task} settings={props.settings} loaded={props.loaded} onChange={props.onChange} />
      ))}
    </div>
  )
}

/** One provider: its key, then (with a key) a model for threads and one for page translation. */
function ProviderField(props: { provider: ProviderId; settings: ByokSettings; onChange: (s: ByokSettings) => void; onRemove: (p: ProviderId) => Promise<boolean> }) {
  const { t } = useI18n()
  const id = useId()
  const apiKey = chosenKey(props.settings, props.provider)
  const [editing, setEditing] = useState(!apiKey)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setModels(await listModels(props.provider, keyFor(props.settings, props.provider)))
    } catch (e) {
      const kind = (e as { kind?: string }).kind
      setError(kind === 'key' ? t.errorKey : kind === 'browser' ? t.errorBrowser : t.errorNetwork)
    } finally {
      setLoading(false)
    }
  }

  const page = KEY_PAGES[props.provider]
  return (
    <fieldset className="provider-field">
      <legend>
        {/* How to get this provider's key, with a link to its key page (owner, 16 Nov). */}
        <button
          type="button"
          className="key-help-toggle"
          aria-expanded={helpOpen}
          aria-controls={`${id}-help`}
          aria-label={t.keyHelp}
          title={t.keyHelp}
          onClick={() => setHelpOpen(!helpOpen)}
        >
          <InfoIcon size={15} />
        </button>
        {keyLabel(t, props.provider)}
      </legend>
      {helpOpen && (
        <div className="key-help" id={`${id}-help`}>
          <p>{keyHelpText(t, props.provider)}</p>
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (inDesktopApp()) {
                e.preventDefault()
                void openKeyPageInShell(props.provider).catch(() => undefined)
              }
            }}
          >
            {t.keyHelpOpen(page.site)} ↗
          </a>
        </div>
      )}
      {editing ? (
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          placeholder={PLACEHOLDER[props.provider]}
          aria-label={keyLabel(t, props.provider)}
          onChange={(e) => props.onChange(withKey(props.settings, props.provider, e.target.value))}
        />
      ) : (
        <div className="key-masked">
          <KeyIcon size={15} /> <code>{maskKey(apiKey)}</code>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              void props.onRemove(props.provider).then((removed) => {
                if (removed) setEditing(true)
              })
            }}
          >
            {t.removeKey}
          </button>
        </div>
      )}
      {hasUsableKey(apiKey) && (
        <div className="model-rows">
          <JobTable provider={props.provider} settings={props.settings} loaded={models} onChange={props.onChange} />
          <button type="button" className="text-button load-models" disabled={loading} onClick={() => void load()}>
            {loading ? '…' : t.loadModels}
          </button>
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </fieldset>
  )
}

export function SettingsDialog(props: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<ByokSettings>(props.settings)
  const [remember, setRemember] = useState(props.remember)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = dialogRef.current
    if (d && !d.open) d.showModal()
  }, [])

  const withKeys = providersWithKeys(draft)
  const active = resolveActiveProvider(draft)

  /**
   * "Remove" takes the key away at once: from the stored keys and from what the app uses, not only from
   * this dialog's draft (audit 15 Nov, K-5). Other unsaved changes in the dialog stay unsaved.
   */
  const remove = async (p: ProviderId): Promise<boolean> => {
    setSaveError(false)
    try {
      await props.onSave(withKey(props.settings, p, ''), props.remember)
      setDraft((d) => withKey(d, p, ''))
      return true
    } catch {
      // The device refused the write: the key is still stored, so it stays shown (audit 15 Nov, KR-3).
      setSaveError(true)
      return false
    }
  }

  const save = async () => {
    let clean = draft
    for (const p of PROVIDERS) clean = withKey(clean, p, chosenKey(clean, p).trim())
    setSaveError(false)
    try {
      await props.onSave(clean, remember)
    } catch {
      setSaveError(true)
      return
    }
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  return (
    <dialog ref={dialogRef} className="settings-dialog" onClose={props.onClose} onCancel={props.onClose}>
      <header className="dialog-header">
        <h2>{t.settings}</h2>
        <button type="button" className="icon-button" aria-label={t.close} onClick={props.onClose}>
          <CloseIcon size={18} />
        </button>
      </header>

      <section>
        <h3>{t.aiKeys}</h3>
        <p className="dialog-intro">{t.aiKeysIntro}</p>
        <p className="dialog-note">{t.modelsNote}</p>
        <p className="dialog-note">{t.keysStoredLocal}</p>
        <KeySafety />
        {PROVIDERS.map((p) => (
          <ProviderField key={p} provider={p} settings={draft} onChange={setDraft} onRemove={remove} />
        ))}
        {withKeys.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label={t.activeProvider}>
            <span className="segmented-label">{t.activeProvider}</span>
            {withKeys.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={active === p} onClick={() => setDraft({ ...draft, activeProvider: p })}>
                {providerName(t, p)}
              </button>
            ))}
          </div>
        )}
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t.rememberKeys}
        </label>
        {saveError && <p className="field-error" role="alert">{t.keysSaveFailed}</p>}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={() => void save()}>{saved ? t.saved : t.save}</button>
        </div>
      </section>

      <BackupSection />

      <section className="dialog-prefs">
        <label>
          {t.language}
          <select value={props.lang} onChange={(e) => props.onLang(e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l} value={l}>{LANG_NAMES[l]}</option>
            ))}
          </select>
        </label>
        <label>
          {t.theme}
          <select value={props.theme} onChange={(e) => props.onTheme(e.target.value as ThemePref)}>
            <option value="system">{t.themeSystem}</option>
            <option value="light">{t.themeLight}</option>
            <option value="dark">{t.themeDark}</option>
          </select>
        </label>
      </section>

      {props.updates && <UpdateSection updates={props.updates} />}

      <PrivacySection lang={props.lang} />
    </dialog>
  )
}

function BackupSection() {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The backup code (and its checks) loads only when it is used.
  const doExport = async () => {
    setBusy(true)
    try {
      const { backupFileName, exportBackup } = await import('../data/backup')
      const blob = await exportBackup()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = backupFileName()
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setMessage(t.exported)
    } catch (error) {
      // A library a restore would refuse is not written (recheck R16-3); the reader is told why.
      if (error instanceof Error && error.message === 'too large') setMessage(t.backupTooLarge)
    } finally {
      setBusy(false)
    }
  }

  const doImport = async (file: File) => {
    setBusy(true)
    try {
      const { importBackup } = await import('../data/backup')
      const { books } = await importBackup(file)
      setMessage(t.imported(books))
    } catch {
      setMessage(t.importBackupFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dialog-backup">
      <h3>{t.backup}</h3>
      <p className="dialog-intro">{t.backupIntro}</p>
      <div className="backup-actions">
        <button type="button" className="ghost-button" disabled={busy} onClick={() => void doExport()}>{t.exportData}</button>
        <button type="button" className="ghost-button" disabled={busy} onClick={() => inputRef.current?.click()}>{t.importData}</button>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void doImport(f)
            e.target.value = ''
          }}
        />
      </div>
      {message && <p className="backup-message" role="status">{message}</p>}
    </section>
  )
}

/** What stays on this device and what goes to the reader's provider: a summary, and the full text. */
function PrivacySection({ lang }: { lang: Lang }) {
  const { t } = useI18n()
  const text = privacyFor(lang)
  return (
    <section className="dialog-privacy">
      <h3>{t.privacy}</h3>
      <p className="dialog-intro">{t.privacyIntro}</p>
      <details className="privacy-text">
        <summary>{t.privacyRead}</summary>
        <p className="privacy-updated">{text.updated}</p>
        {text.sections.map((section) => (
          <div key={section.heading}>
            <h4>{section.heading}</h4>
            {section.blocks.map((block, i) =>
              block.p !== undefined ? (
                <p key={i}>{block.p}</p>
              ) : (
                <ul key={i}>
                  {block.ul.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ),
            )}
          </div>
        ))}
      </details>
    </section>
  )
}

/**
 * "Is your key safe?" (owner, 16 Nov): where the key is kept, where it goes, what the reader can do,
 * and the limit, plainly; folded until opened. The Windows app has no browser extensions, so its limit
 * differs from the web's.
 */
export function KeySafety() {
  const { t } = useI18n()
  return (
    <details className="key-safety">
      <summary>{t.keySafetyTitle}</summary>
      <ul>
        <li>{t.keySafetyWhereLocal}</li>
        <li>{t.keySafetyGoes}</li>
        <li>{t.keySafetyYou}</li>
        <li>{inDesktopApp() ? t.keySafetyLimitWindows : t.keySafetyLimitWeb}</li>
      </ul>
    </details>
  )
}
