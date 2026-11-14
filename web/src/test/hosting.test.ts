// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

interface Rule {
  source: string
  headers: { key: string; value: string }[]
}
const hosting = (JSON.parse(readFileSync(new URL('../../../firebase.json', import.meta.url), 'utf8')) as { hosting: { rewrites?: unknown[]; headers: Rule[] } }).hosting
const cache = (source: string) => hosting.headers.find((r) => r.source === source)?.headers.find((h) => h.key === 'Cache-Control')?.value

// Audit 15 Nov (WW-3): the start page is asked for again on every visit, so a fix reaches readers at once,
// and a missing file is a 404, never the app page cached for a year.
describe('Hosting rules (firebase.json)', () => {
  it('serves the start page and every unhashed file with no-cache', () => {
    expect(cache('**')).toBe('no-cache')
  })

  it('keeps long caching for hashed files only, as the last rule', () => {
    expect(cache('/assets/**')).toMatch(/immutable/)
    expect(hosting.headers[hosting.headers.length - 1]!.source).toBe('/assets/**')
  })

  it('has no catch-all rewrite (the app has no routes)', () => {
    expect(hosting.rewrites ?? []).toEqual([])
  })

  it('does not cache pdf.js files beyond no-cache: their decoders must match the hashed worker (WR-3)', () => {
    const rules = hosting.headers.filter((r) => r.source.startsWith('/pdfjs'))
    expect(rules).toEqual([])
  })
})
