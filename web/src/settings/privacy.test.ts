// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LANGS } from '../i18n/strings'
import { privacyFor, privacyMarkdown } from './privacy'
import { PRIVACY_FILES } from './privacyMarkdown'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))

describe('privacy text', () => {
  it('has the same shape in every language', () => {
    const shape = (lang: (typeof LANGS)[number]) =>
      privacyFor(lang).sections.map((s) => s.blocks.map((b) => (b.p !== undefined ? 'p' : `ul${b.ul.length}`)).join(','))
    for (const lang of LANGS) expect(shape(lang), lang).toEqual(shape('en'))
  })

  it('is what the repository publishes (run scripts/export-privacy.ts after editing shared/privacy.json)', () => {
    for (const lang of LANGS) {
      const file = readFileSync(join(REPO, PRIVACY_FILES[lang]), 'utf8')
      expect(file, PRIVACY_FILES[lang]).toBe(privacyMarkdown(lang))
    }
  })

  it('names no contact but the published privacy address', () => {
    for (const lang of LANGS) {
      const all = JSON.stringify(privacyFor(lang))
      expect(all.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)).toEqual(['privacy@peryda.com'])
    }
  })
})
