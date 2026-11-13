import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, getPref } from '../data/db'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS } from '../i18n/strings'
import { nextStep, useDesktopUpdates } from './desktopUpdates'
import { UpdateNotice, UpdateSection } from './UpdateViews'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(command: string) => Promise<unknown>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string) => invoke(command) }))

const t = STRINGS.tr
const DAY = 24 * 60 * 60 * 1000

describe('when the update check runs', () => {
  it('asks only from the second start, and never checks before the reader allows it', () => {
    expect(nextStep(null, 1, 0, DAY * 10)).toBe('none')
    expect(nextStep(null, 2, 0, DAY * 10)).toBe('ask')
    expect(nextStep('off', 9, 0, DAY * 10)).toBe('none')
  })

  it('checks at most once a day once allowed', () => {
    expect(nextStep('on', 3, DAY * 10 - 1000, DAY * 10)).toBe('none')
    expect(nextStep('on', 3, DAY * 9, DAY * 10)).toBe('check')
  })
})

function Harness() {
  const updates = useDesktopUpdates()
  if (!updates) return <p>web</p>
  return (
    <I18nProvider lang="tr">
      <UpdateNotice updates={updates} />
      <UpdateSection updates={updates} />
    </I18nProvider>
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null

async function start() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Harness />))
  // Let the start-up reads and writes settle.
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)))
}

function button(text: string): HTMLButtonElement {
  const b = [...host!.querySelectorAll('button')].find((el) => el.textContent === text)
  if (!b) throw new Error(`no button "${text}" in: ${host!.textContent}`)
  return b
}

function answer(state: [boolean, string], check: string | null = null) {
  invoke.mockImplementation(async (command) => {
    if (command === 'updater_state') return state
    if (command === 'updater_check') return check
    if (command === 'updater_install') return undefined
    throw new Error(command)
  })
}

beforeEach(async () => {
  invoke.mockReset()
  await db.delete()
  await db.open()
  ;(window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {}
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  delete (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
})

describe('the Windows app’s update check', () => {
  it('does nothing in the browser', async () => {
    delete (window as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
    await start()
    expect(host!.textContent).toBe('web')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('stays quiet on the first start, asks on the second, and checks only after a yes', async () => {
    answer([true, '0.1.0'])
    await start()
    expect(host!.textContent).not.toContain(t.updatesAsk)
    expect(invoke).not.toHaveBeenCalledWith('updater_check')
    act(() => root!.unmount())

    await start()
    expect(host!.textContent).toContain(t.updatesAsk)
    expect(invoke).not.toHaveBeenCalledWith('updater_check')
    await act(async () => button(t.updatesAllow).click())
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(invoke).toHaveBeenCalledWith('updater_check')
    expect(await getPref('updateChoice', null)).toBe('on')
    expect(host!.textContent).not.toContain(t.updatesAsk)
  })

  it('remembers a no and never checks', async () => {
    answer([true, '0.1.0'])
    await db.prefs.put({ key: 'launches', value: 1 })
    await start()
    await act(async () => button(t.updatesDeny).click())
    expect(await getPref('updateChoice', null)).toBe('off')
    act(() => root!.unmount())
    await start()
    expect(host!.textContent).not.toContain(t.updatesAsk)
    expect(invoke).not.toHaveBeenCalledWith('updater_check')
  })

  it('offers a found update and installs it only when the reader says so', async () => {
    answer([true, '0.1.0'], '0.2.0')
    await db.prefs.bulkPut([
      { key: 'updateChoice', value: 'on' },
      { key: 'lastUpdateCheck', value: 0 },
    ])
    await start()
    expect(host!.textContent).toContain(t.updateReady('0.2.0'))
    expect(invoke).not.toHaveBeenCalledWith('updater_install')
    await act(async () => button(t.updateInstall).click())
    expect(invoke).toHaveBeenCalledWith('updater_install')
    expect(host!.textContent).toContain(t.updateInstalling)
  })

  it('says so in Settings when this build cannot update itself, and never asks', async () => {
    answer([false, '0.1.0'])
    await db.prefs.put({ key: 'launches', value: 5 })
    await start()
    expect(host!.textContent).toContain(t.updatesUnavailable)
    expect(host!.textContent).not.toContain(t.updatesAsk)
    expect(invoke).not.toHaveBeenCalledWith('updater_check')
  })

  it('reports "up to date" after a check the reader asked for', async () => {
    answer([true, '0.1.0'], null)
    await db.prefs.put({ key: 'updateChoice', value: 'off' })
    await start()
    expect(host!.textContent).toContain(t.versionIs('0.1.0'))
    await act(async () => button(t.checkNow).click())
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(host!.textContent).toContain(t.upToDate)
  })
})
