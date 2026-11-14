import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18n'
import { LANGS, type Lang, type Strings } from '../i18n/strings'
import { listModels } from '../ai/client'
import {
  ModelAdvice,
  PROVIDERS,
  chosenKey,
  hasUsableKey,
  keyFor,
  modelFor,
  providersWithKeys,
  resolveActiveProvider,
  withKey,
  withModel,
  type AiTask,
  type ByokSettings,
  type ProviderId,
} from '../ai/provider'
import { maskKey } from '../data/keyVault'
import { CloseIcon, KeyIcon } from '../ui/icons'
import { privacyFor } from './privacy'
import type { DesktopUpdates } from '../updates/desktopUpdates'
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

/** A model menu: recommended models first with their badge, then the rest the key can use. */
function ModelPicker(props: { title: string; provider: ProviderId; task: AiTask; settings: ByokSettings; loaded: string[]; onChange: (s: ByokSettings) => void }) {
  const { t } = useI18n()
  const recommended = ModelAdvice.recommended(props.provider, props.task)
  const current = modelFor(props.settings, props.provider, props.task)
  const others = [...new Set([...props.loaded, current])].filter((m) => !recommended.includes(m)).sort()
  return (
    <label className="model-picker">
      <span>{props.title}</span>
      <select value={current} onChange={(e) => props.onChange(withModel(props.settings, props.provider, props.task, e.target.value))}>
        <optgroup label={t.recommended}>
          {recommended.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </optgroup>
        {others.length > 0 && (
          <optgroup label={t.otherModels}>
            {others.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </optgroup>
        )}
      </select>
      {ModelAdvice.isRecommended(current, props.provider, props.task) && <span className="recommended-badge">{t.recommended}</span>}
    </label>
  )
}

/** One provider: its key, then (with a key) a model for threads and one for page translation. */
function ProviderField(props: { provider: ProviderId; settings: ByokSettings; onChange: (s: ByokSettings) => void; onRemove: (p: ProviderId) => void }) {
  const { t } = useI18n()
  const id = useId()
  const apiKey = chosenKey(props.settings, props.provider)
  const [editing, setEditing] = useState(!apiKey)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <fieldset className="provider-field">
      <legend>{keyLabel(t, props.provider)}</legend>
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
              props.onRemove(props.provider)
              setEditing(true)
            }}
          >
            {t.removeKey}
          </button>
        </div>
      )}
      {hasUsableKey(apiKey) && (
        <div className="model-rows">
          <ModelPicker title={t.threadModel} provider={props.provider} task="thread" settings={props.settings} loaded={models} onChange={props.onChange} />
          <ModelPicker title={t.translationModel} provider={props.provider} task="translation" settings={props.settings} loaded={models} onChange={props.onChange} />
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
  const remove = (p: ProviderId) => {
    setDraft((d) => withKey(d, p, ''))
    void props.onSave(withKey(props.settings, p, ''), props.remember)
  }

  const save = async () => {
    let clean = draft
    for (const p of PROVIDERS) clean = withKey(clean, p, chosenKey(clean, p).trim())
    await props.onSave(clean, remember)
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
