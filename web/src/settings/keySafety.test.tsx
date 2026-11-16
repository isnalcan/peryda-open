import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS } from '../i18n/strings'
import { KeySafety } from './SettingsDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<I18nProvider lang="tr"><KeySafety /></I18nProvider>))
}

describe('"Is your key safe?" in Settings (owner, 16 Nov)', () => {
  it('is folded under its question and says where the key is, where it goes, what to do, and the limit', async () => {
    await render()
    const details = host.querySelector('details.key-safety') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe(STRINGS.tr.keySafetyTitle)
    const items = [...details.querySelectorAll('li')].map((li) => li.textContent)
    expect(items).toEqual([STRINGS.tr.keySafetyWhereLocal, STRINGS.tr.keySafetyGoes, STRINGS.tr.keySafetyYou, STRINGS.tr.keySafetyLimitWeb])
    expect(items[3]).toContain('tarayıcı eklentisi')
  })

  it('in the Windows app speaks of the computer, not of browser extensions', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    await render()
    const last = [...host.querySelectorAll('li')].at(-1)?.textContent
    expect(last).toBe(STRINGS.tr.keySafetyLimitWindows)
  })
})
