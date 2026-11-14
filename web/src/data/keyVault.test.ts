// @vitest-environment node
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { db } from './db'
import { DEFAULT_SETTINGS, clearSettings, loadSettings, maskKey, saveSettings } from './keyVault'

describe('key vault', () => {
  const settings = { ...DEFAULT_SETTINGS, geminiApiKey: 'AIza-placeholder-not-a-real-key', geminiModel: 'gemini-x' }

  it('round-trips settings and never stores the key as plain text', async () => {
    await saveSettings(settings)
    expect(await loadSettings()).toEqual(settings)
    const row = await db.vault.get('byok')
    const raw = new TextDecoder().decode(new Uint8Array(row!.data!))
    expect(raw).not.toContain('placeholder')
    const keyRow = await db.vault.get('aes-key')
    expect(keyRow!.key!.extractable).toBe(false)
  })

  it('two saves at once leave a matching pair, so the saved keys can be read back', async () => {
    await db.vault.clear()
    const a = { ...settings, geminiApiKey: 'test-key-first-save-000000' }
    const b = { ...settings, geminiApiKey: 'test-key-second-save-00000' }
    // The first save is slow to encrypt, so the second finishes in between (the order that once lost keys).
    const subtle = crypto.subtle
    const encrypt = subtle.encrypt.bind(subtle)
    let calls = 0
    const spy = vi.spyOn(subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      if (calls++ === 0) await new Promise((r) => setTimeout(r, 30))
      return encrypt(...args)
    })
    try {
      await Promise.all([saveSettings(a), saveSettings(b)])
    } finally {
      spy.mockRestore()
    }
    expect([a, b]).toContainEqual(await loadSettings())
  })

  it('makes a new device key with every save, so an older encrypted copy cannot be opened (KR-4)', async () => {
    await saveSettings({ ...settings, geminiApiKey: 'AIza-old-key-that-is-removed-0000' })
    const oldData = await db.vault.get('byok')
    const oldKey = (await db.vault.get('aes-key'))!.key!
    await saveSettings({ ...settings, geminiApiKey: '' })
    const newKey = (await db.vault.get('aes-key'))!.key!
    expect(newKey).not.toBe(oldKey)
    // The stale record (still in the browser's files for a while) does not open with the key that is left.
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: oldData!.iv as BufferSource }, newKey, oldData!.data!)).rejects.toThrow()
    expect((await loadSettings()).geminiApiKey).toBe('')
  })

  it('forgets the settings on request', async () => {
    await saveSettings(settings)
    await clearSettings()
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('masks keys for display', () => {
    expect(maskKey('AIzaSyAbcdefghijkl1234')).toBe('AIza…1234')
    expect(maskKey('short')).toBe('•••••')
  })
})
