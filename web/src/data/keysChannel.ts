/**
 * Tells other open tabs of this site that the stored keys changed, so a key removed in one tab is not
 * kept (and later written back) by another (audit 15 Nov, KR-3). Only a "changed" signal travels, never a
 * key: each tab reads the vault itself. The Mac and Windows apps have one window, so this is web only.
 */
const CHANNEL = 'peryda-keys'

export function announceKeysChanged(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage('changed')
  channel.close()
}

/** Calls `listener` when another tab saved or removed keys; returns the way to stop listening. */
export function onKeysChanged(listener: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event: MessageEvent) => {
    if (event.data === 'changed') listener()
  }
  return () => channel.close()
}
