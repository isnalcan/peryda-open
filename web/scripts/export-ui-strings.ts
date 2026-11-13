// Writes shared/ui-strings.json from src/i18n/strings.ts so the Mac app shows the same words.
// Function entries become templates: their arguments are written as {n}, {p}, …
// Run: node --experimental-strip-types scripts/export-ui-strings.ts
import { writeFileSync } from 'node:fs'
import { STRINGS } from '../src/i18n/strings.ts'

const out: Record<string, Record<string, string>> = {}
for (const [lang, table] of Object.entries(STRINGS)) {
  for (const [key, value] of Object.entries(table)) {
    let text: string
    if (typeof value === 'function') {
      const names = (value.toString().match(/^\(?([^)=]*)\)?\s*=>/)?.[1] ?? '').split(',').map((s) => s.split(':')[0]!.trim()).filter(Boolean)
      text = (value as (...a: string[]) => string)(...names.map((n) => `{${n}}`))
    } else {
      text = value as string
    }
    ;(out[key] ??= {})[lang] = text
  }
}
const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]))
writeFileSync(new URL('../../shared/ui-strings.json', import.meta.url), JSON.stringify(sorted, null, 2) + '\n')
console.log(`${Object.keys(sorted).length} strings written`)
