import { describe, expect, it } from 'vitest'
import shared from '@shared/ui-strings.json'
import { STRINGS } from './strings'

describe('shared/ui-strings.json', () => {
  it('matches the web strings (run: node --experimental-strip-types scripts/export-ui-strings.ts)', () => {
    for (const [lang, table] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        const entry = (shared as Record<string, Record<string, string>>)[key]
        expect(entry, key).toBeDefined()
        if (typeof value === 'string') expect(entry![lang], `${lang}.${key}`).toBe(value)
        else expect(entry![lang], `${lang}.${key}`).toContain('{')
      }
    }
  })
})
