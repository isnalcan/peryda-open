// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { KEY_PAGES } from '../settings/keyPages'

const read = (path: string) => readFileSync(new URL(`../../../windows/src-tauri/${path}`, import.meta.url), 'utf8')

// Audit 15 Nov (WW-6): the Windows window may call exactly the shell's own update commands, each
// declared in build.rs and allowed in the capability file, so a command added later is refused until
// it is reviewed here.
describe('Windows shell: what the page may call', () => {
  const handlers = /generate_handler!\[([^\]]+)\]/.exec(read('src/lib.rs'))![1]!.split(',').map((s) => s.trim()).filter(Boolean)
  const declared = /commands\(&\[([^\]]+)\]\)/.exec(read('build.rs'))![1]!.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean)
  const capability = JSON.parse(read('capabilities/default.json')) as { windows: string[]; permissions: string[] }

  it('declares every command it registers', () => {
    expect([...declared].sort()).toEqual([...handlers].sort())
  })

  it('allows exactly those commands, and no plugin or core permission', () => {
    expect(capability.windows).toEqual(['main'])
    expect([...capability.permissions].sort()).toEqual(handlers.map((h) => `allow-${h.replace(/_/g, '-')}`).sort())
  })
})

// Owner, 16 Nov: the (i) beside each key opens that provider's key page. The Windows shell opens only
// its own four fixed addresses; they must be exactly the ones the page offers.
describe('Windows shell: the key pages it may open', () => {
  it('matches the four key pages of Settings, and nothing else', () => {
    const body = /fn key_page\(provider: &str\)[\s\S]*?\n\}/.exec(read('src/lib.rs'))![0]
    const arms = [...body.matchAll(/"(\w+)" => Some\("([^"]+)"\)/g)].map((m) => [m[1], m[2]])
    expect(Object.fromEntries(arms)).toEqual(Object.fromEntries(Object.entries(KEY_PAGES).map(([p, v]) => [p, v.url])))
    for (const [, url] of arms) expect(url).toMatch(/^https:\/\//)
  })
})

