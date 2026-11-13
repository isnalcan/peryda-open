import { useCallback, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '../data/db'

/**
 * The Windows app's update check. The web app needs none: the page is always the newest version.
 *
 * The reader decides. Nothing is checked until they allow it; they are asked on the second start, and
 * Settings can change it at any time. The check and the install run in the window shell, which asks
 * only the update address (the latest GitHub release) and installs only an update signed with
 * Peryda's update key. Nothing about the reader, their books or their keys is sent.
 */

export type UpdateChoice = 'on' | 'off' | null

/** Running inside the Windows app (Tauri), not in a browser. */
export function inDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function call<T>(command: string): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command)
}

const DAY = 24 * 60 * 60 * 1000

/** What to do now: ask (second start, no choice yet), check (allowed, last check a day ago) or nothing. */
export function nextStep(choice: UpdateChoice, launches: number, lastCheck: number, now: number): 'ask' | 'check' | 'none' {
  if (choice === null) return launches >= 2 ? 'ask' : 'none'
  if (choice === 'on' && now - lastCheck >= DAY) return 'check'
  return 'none'
}

export type UpdateStatus = 'idle' | 'checking' | 'upToDate' | 'failed' | 'installing'

export interface DesktopUpdates {
  /** False in builds made without the update key. */
  available: boolean
  version: string
  choice: UpdateChoice
  /** True while the "check automatically?" question is shown. */
  asking: boolean
  /** The newer version found, waiting to be installed. */
  found: string | null
  status: UpdateStatus
  choose: (on: boolean) => void
  checkNow: () => void
  install: () => void
  later: () => void
}

/** The update check's state for the Windows app; null in the browser. */
export function useDesktopUpdates(): DesktopUpdates | null {
  const desktop = inDesktopApp()
  const [available, setAvailable] = useState(false)
  const [version, setVersion] = useState('')
  const [choice, setChoice] = useState<UpdateChoice>(null)
  const [asking, setAsking] = useState(false)
  const [found, setFound] = useState<string | null>(null)
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const choiceRef = useRef<UpdateChoice>(null)

  const check = useCallback(async (shown: boolean) => {
    setStatus('checking')
    try {
      const next = await call<string | null>('updater_check')
      await setPref('lastUpdateCheck', Date.now())
      setFound(next)
      setStatus(next || !shown ? 'idle' : 'upToDate')
    } catch {
      // A check the reader did not ask for fails quietly; the next one runs a day later.
      setStatus(shown ? 'failed' : 'idle')
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    let timer = 0
    void (async () => {
      const [ok, v] = await call<[boolean, string]>('updater_state').catch(() => [false, ''] as [boolean, string])
      if (cancelled) return
      setAvailable(ok)
      setVersion(v)
      if (!ok) return
      const saved = await getPref<unknown>('updateChoice', null)
      const stored: UpdateChoice = saved === 'on' || saved === 'off' ? saved : null
      const launches = ((await getPref<number>('launches', 0)) || 0) + 1
      await setPref('launches', launches)
      if (cancelled) return
      choiceRef.current = stored
      setChoice(stored)
      const step = async () => {
        const last = (await getPref<number>('lastUpdateCheck', 0)) || 0
        const next = nextStep(choiceRef.current, launches, last, Date.now())
        if (next === 'ask') setAsking(true)
        if (next === 'check') await check(false)
      }
      await step()
      // A window left open for days still looks once a day.
      timer = window.setInterval(() => void step(), 60 * 60 * 1000)
    })()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [desktop, check])

  const choose = useCallback(
    (on: boolean) => {
      const next: UpdateChoice = on ? 'on' : 'off'
      choiceRef.current = next
      setChoice(next)
      setAsking(false)
      void setPref('updateChoice', next)
      if (on) void check(false)
    },
    [check],
  )

  const install = useCallback(() => {
    setStatus('installing')
    // On success the installer closes Peryda and opens the new version.
    call<void>('updater_install').catch(() => setStatus('failed'))
  }, [])

  if (!desktop) return null
  return {
    available,
    version,
    choice,
    asking,
    found,
    status,
    choose,
    checkNow: () => void check(true),
    install,
    later: () => setFound(null),
  }
}
