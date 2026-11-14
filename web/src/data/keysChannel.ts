/**
 * Tells other open tabs of this site that the stored keys changed, so a key removed in one tab is not
 * kept (and later written back) by another (audit 15 Nov, KR-3). Only a "changed" signal and this tab's
 * random id travel, never a key: each tab reads the vault itself. The Mac and Windows apps have one
 * window, so this is web only.
 *
 * A tab ignores its own signal. (Owner test 15 Nov: every BroadcastChannel object of the name hears the
 * message, including a second one in the same tab, so with "Remember keys" off the tab that had just
 * saved a key reloaded an empty vault and lost the key when Settings closed.)
 */
const CHANNEL = 'peryda-keys'
const TAB = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random())

interface KeysChanged {
  kind: 'changed'
  from: string
}

export function announceKeysChanged(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage({ kind: 'changed', from: TAB } satisfies KeysChanged)
  channel.close()
}

/** Calls `listener` when another tab saved or removed keys; returns the way to stop listening. */
export function onKeysChanged(listener: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as Partial<KeysChanged> | null
    if (data?.kind === 'changed' && typeof data.from === 'string' && data.from !== TAB) listener()
  }
  return () => channel.close()
}
