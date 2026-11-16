import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS } from '../i18n/strings'
import { DEFAULT_SETTINGS } from '../ai/provider'
import { SettingsDialog } from './SettingsDialog'
import { KEY_PAGES } from './keyPages'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

describe('how to get a key: the (i) beside each provider (owner, 16 Nov)', () => {
  it("opens a short how-to and a link to that provider's key page", async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root.render(
        <I18nProvider lang="tr">
          <SettingsDialog settings={{ ...DEFAULT_SETTINGS }} remember lang="tr" theme="system" onSave={async () => {}} onLang={() => {}} onTheme={() => {}} onClose={() => {}} updates={null} />
        </I18nProvider>,
      ),
    )
    const toggles = [...host.querySelectorAll('.key-help-toggle')] as HTMLButtonElement[]
    expect(toggles).toHaveLength(4)
    expect(host.querySelector('.key-help')).toBeNull()
    for (const [i, provider] of (['gemini', 'openai', 'deepseek', 'claude'] as const).entries()) {
      expect(toggles[i]!.getAttribute('aria-label')).toBe(STRINGS.tr.keyHelp)
      await act(async () => toggles[i]!.click())
      expect(toggles[i]!.getAttribute('aria-expanded')).toBe('true')
      const help = document.getElementById(toggles[i]!.getAttribute('aria-controls')!)!
      const link = help.querySelector('a')!
      expect(link.getAttribute('href')).toBe(KEY_PAGES[provider].url)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
      expect(link.textContent).toContain(KEY_PAGES[provider].site)
      await act(async () => toggles[i]!.click())
      expect(host.querySelector('.key-help')).toBeNull()
    }
  })
})
