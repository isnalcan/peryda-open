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

/**
 * Saves the keys with a NEW device key every time, written together with the encrypted keys in one
 * transaction. An older encrypted copy that the browser has not yet compacted away (a key removed or
 * replaced a moment ago) then cannot be opened with the device key that is left (audit 15 Nov, KR-4).
 * Two saves at once each write their own matching pair; the later pair wins whole.
 */
export async function saveSettings(settings: ByokSettings): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(settings))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  await db.transaction('rw', db.vault, async () => {
    await db.vault.put({ id: KEY_ID, key })
    await db.vault.put({ id: DATA_ID, iv, data })
  })
}

export async function loadSettings(): Promise<ByokSettings> {
  const [row, keyRow] = await Promise.all([db.vault.get(DATA_ID), db.vault.get(KEY_ID)])
  if (!row?.iv || !row.data || !keyRow?.key) return { ...DEFAULT_SETTINGS }
  try {
    const key = keyRow.key
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv as BufferSource }, key, row.data)
    return normalizeSettings(JSON.parse(new TextDecoder().decode(plain)) as Partial<ByokSettings>)
  } catch {
    // A vault that cannot be decrypted (key lost with cleared site data) is treated as empty.
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Forgets the keys: the encrypted keys and the device key that opened them both go (a new device key is
 * made on the next save), so an old copy of the encrypted keys can no longer be opened with what is left
 * (audit 15 Nov, K-6).
 */
export async function clearSettings(): Promise<void> {
  await db.vault.bulkDelete([DATA_ID, KEY_ID])
}

/** Shows the start and end of a key so the reader can recognise it without exposing it. */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length <= 10) return k ? '•'.repeat(k.length) : ''
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}
