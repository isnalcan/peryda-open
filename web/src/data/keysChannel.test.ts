// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { announceKeysChanged, onKeysChanged } from './keysChannel'

const tick = () => new Promise((r) => setTimeout(r, 30))

// Owner test 15 Nov: with "Remember keys" off, saving a key in a tab made that same tab drop it.
describe('Key change signal between tabs', () => {
  it('is not heard by the tab that sent it', async () => {
    const heard = vi.fn()
    const stop = onKeysChanged(heard)
    announceKeysChanged()
    await tick()
    expect(heard).not.toHaveBeenCalled()
    stop()
  })

  it('is heard from another tab, and carries no key', async () => {
    const heard = vi.fn()
    const stop = onKeysChanged(heard)
    const other = new BroadcastChannel('peryda-keys')
    other.postMessage({ kind: 'changed', from: 'another-tab' })
    other.postMessage('changed')
    other.postMessage({ kind: 'changed', from: 42 })
    await tick()
    expect(heard).toHaveBeenCalledTimes(1)
    other.close()
    stop()
  })
})
