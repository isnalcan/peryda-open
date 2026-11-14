import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS } from '../i18n/strings'
import { DEFAULT_SETTINGS, keyFor, type ByokSettings } from '../ai/provider'
import { SettingsDialog } from './SettingsDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
})

// Audit 15 Nov (K-5): "Remove" takes the key away at once, not only when Save is pressed.
describe('Settings: removing a key', () => {
  it('removes it from the stored keys at once, leaving the others', async () => {
    const settings: ByokSettings = { ...DEFAULT_SETTINGS, geminiApiKey: 'AIza-placeholder-000000', openaiApiKey: 'sk-placeholder-000000' }
    const onSave = vi.fn(async () => undefined)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <I18nProvider lang="tr">
          <SettingsDialog settings={settings} remember lang="tr" theme="system" onSave={onSave} onLang={() => undefined} onTheme={() => undefined} onClose={() => undefined} />
        </I18nProvider>,
      )
    })
    const remove = [...host.querySelectorAll('button')].find((b) => b.textContent === STRINGS.tr.removeKey)!
    await act(async () => remove.click())
    expect(onSave).toHaveBeenCalledTimes(1)
    const [saved, remember] = onSave.mock.calls[0] as unknown as [ByokSettings, boolean]
    expect(keyFor(saved, 'gemini')).toBe('')
    expect(keyFor(saved, 'openai')).toBe('sk-placeholder-000000')
    expect(remember).toBe(true)
    act(() => root.unmount())
    host.remove()
  })

  it('says so when the device refuses the write, and keeps showing the key (KR-3)', async () => {
    const settings: ByokSettings = { ...DEFAULT_SETTINGS, geminiApiKey: 'AIza-placeholder-000000' }
    const onSave = vi.fn(async () => {
      throw new Error('QuotaExceededError')
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <I18nProvider lang="tr">
          <SettingsDialog settings={settings} remember lang="tr" theme="system" onSave={onSave} onLang={() => undefined} onTheme={() => undefined} onClose={() => undefined} />
        </I18nProvider>,
      )
    })
    const remove = [...host.querySelectorAll('button')].find((b) => b.textContent === STRINGS.tr.removeKey)!
    await act(async () => remove.click())
    expect(host.textContent).toContain(STRINGS.tr.keysSaveFailed)
    // The key is still there to remove again.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === STRINGS.tr.removeKey)).toBe(true)
    act(() => root.unmount())
    host.remove()
  })
})
