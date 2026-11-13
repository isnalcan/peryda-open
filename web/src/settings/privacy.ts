import privacy from '@shared/privacy.json'
import type { Lang } from '../i18n/strings'
import { privacyMarkdownFrom, type PrivacyText } from './privacyMarkdown'

/**
 * The privacy text for Mac, Windows and the web, in the reader's language. One source
 * (shared/privacy.json) feeds the apps' settings and the repository's PRIVACY.md files.
 */
export function privacyFor(lang: Lang): PrivacyText {
  return (privacy as Record<Lang, PrivacyText>)[lang]
}

export function privacyMarkdown(lang: Lang): string {
  return privacyMarkdownFrom(privacy, lang)
}
