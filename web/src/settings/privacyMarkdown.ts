import type { Lang } from '../i18n/strings'

/** One piece of the privacy text: a paragraph or a list. */
export type PrivacyBlock = { p: string; ul?: undefined } | { ul: string[]; p?: undefined }

export interface PrivacyText {
  title: string
  updated: string
  sections: { heading: string; blocks: PrivacyBlock[] }[]
}

/** Where each language's text lives in the repository. */
export const PRIVACY_FILES: Record<Lang, string> = {
  en: 'PRIVACY.md',
  tr: 'docs/privacy/tr.md',
  de: 'docs/privacy/de.md',
  es: 'docs/privacy/es.md',
}

const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  tr: 'Türkçe',
  de: 'Deutsch',
  es: 'Español',
}

/** The text as Markdown, with links to the other languages (written by scripts/export-privacy.ts). */
export function privacyMarkdownFrom(all: unknown, lang: Lang): string {
  const text = (all as Record<Lang, PrivacyText>)[lang]
  const depth = PRIVACY_FILES[lang].split('/').length - 1
  const others = (Object.keys(PRIVACY_FILES) as Lang[])
    .filter((l) => l !== lang)
    .map((l) => `[${LANGUAGE_NAMES[l]}](${'../'.repeat(depth)}${PRIVACY_FILES[l]})`)
    .join(' · ')
  const lines = [
    '<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->',
    '',
    `# ${text.title}`,
    '',
    `*${text.updated}*`,
    '',
    others,
  ]
  for (const section of text.sections) {
    lines.push('', `## ${section.heading}`)
    for (const block of section.blocks) {
      lines.push('')
      if (block.p !== undefined) lines.push(block.p)
      else lines.push(...block.ul.map((item) => `- ${item}`))
    }
  }
  return lines.join('\n') + '\n'
}
