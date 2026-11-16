import type { Strings } from '../i18n/strings'
import type { ProviderId } from '../ai/provider'
import { inDesktopApp } from '../updates/desktopUpdates'

/**
 * Where each provider hands out API keys, and how (Settings: the (i) beside each key; owner, 16 Nov).
 * The Windows shell opens only these four addresses (windows/src-tauri/src/lib.rs, key_page); a test
 * checks the two lists match.
 */
export const KEY_PAGES: Record<ProviderId, { url: string; site: string }> = {
  gemini: { url: 'https://aistudio.google.com/apikey', site: 'Google AI Studio' },
  openai: { url: 'https://platform.openai.com/api-keys', site: 'OpenAI Platform' },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', site: 'DeepSeek Platform' },
  claude: { url: 'https://platform.claude.com/settings/keys', site: 'Claude Console' },
}

export function keyHelpText(t: Strings, p: ProviderId): string {
  switch (p) {
    case 'gemini':
      return t.keyHelpGemini
    case 'openai':
      return t.keyHelpOpenai
    case 'deepseek':
      return t.keyHelpDeepseek
    case 'claude':
      return t.keyHelpClaude
  }
}

/**
 * Opens a provider's key page. In the Windows app the window never leaves the app (any other address is
 * refused there), so the shell opens the page in the reader's browser; it is told only which provider.
 * Returns true when the shell took it.
 */
export async function openKeyPageInShell(p: ProviderId): Promise<boolean> {
  if (!inDesktopApp()) return false
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_key_page', { provider: p })
  return true
}
