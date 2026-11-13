// Writes PRIVACY.md and docs/privacy/*.md from shared/privacy.json, the same text the apps show.
// Run: node --experimental-strip-types scripts/export-privacy.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import privacy from '../../shared/privacy.json' with { type: 'json' }
import type { Lang } from '../src/i18n/strings.ts'
import { PRIVACY_FILES, privacyMarkdownFrom } from '../src/settings/privacyMarkdown.ts'

for (const lang of Object.keys(PRIVACY_FILES) as Lang[]) {
  const url = new URL(`../../${PRIVACY_FILES[lang]}`, import.meta.url)
  mkdirSync(new URL('.', url), { recursive: true })
  writeFileSync(url, privacyMarkdownFrom(privacy, lang))
}
console.log('privacy text written')
