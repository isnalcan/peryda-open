import { db } from './db'
import { DEFAULT_SETTINGS, normalizeSettings, type ByokSettings } from '../ai/provider'

export { DEFAULT_SETTINGS }

/**
 * Stores the reader's AI keys on this device, scrambled with AES-GCM so they never sit in storage as
 * plain text and stay out of backups and exports. The AES key is a non-extractable CryptoKey, but the
 * browser keeps it in the same profile as the scrambled keys: anyone who can read this computer account's
 * browser data (or code running in this page) can still recover them. That is why the app loads no
 * third-party code, and why readers on a shared computer should turn "remember" off.
 */

const KEY_ID = 'aes-key'
const DATA_ID = 'byok'

async function vaultKey(): Promise<CryptoKey> {
  const existing = await db.vault.get(KEY_ID)
  if (existing?.key) return existing.key
  const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  // Two first saves at once each make a key. Only one is stored, inside a transaction, and both saves
  // use that one; otherwise the second key would replace the one the first save encrypted with.
  return db.transaction('rw', db.vault, async () => {
    const stored = await db.vault.get(KEY_ID)
    if (stored?.key) return stored.key
    await db.vault.put({ id: KEY_ID, key: fresh })
    return fresh
  })
}

export async function saveSettings(settings: ByokSettings): Promise<void> {
  const key = await vaultKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(settings))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  await db.vault.put({ id: DATA_ID, iv, data })
}

export async function loadSettings(): Promise<ByokSettings> {
  const row = await db.vault.get(DATA_ID)
  if (!row?.iv || !row.data) return { ...DEFAULT_SETTINGS }
  try {
    const key = await vaultKey()
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv as BufferSource }, key, row.data)
    return normalizeSettings(JSON.parse(new TextDecoder().decode(plain)) as Partial<ByokSettings>)
  } catch {
    // A vault that cannot be decrypted (key lost with cleared site data) is treated as empty.
    return { ...DEFAULT_SETTINGS }
  }
}

export async function clearSettings(): Promise<void> {
  await db.vault.delete(DATA_ID)
}

/** Shows the start and end of a key so the reader can recognise it without exposing it. */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length <= 10) return k ? '•'.repeat(k.length) : ''
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}
