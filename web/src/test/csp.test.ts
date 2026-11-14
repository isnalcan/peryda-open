// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Plugin, UserConfig } from 'vite'
import { readFileSync } from 'node:fs'
import makeConfig from '../../vite.config'

function transformFor(mode: string) {
  const config = (makeConfig as unknown as (env: { mode: string; command: 'build' }) => UserConfig)({ mode, command: 'build' })
  const plugin = (config.plugins ?? []).flat().find((p): p is Plugin => Boolean(p) && (p as Plugin).name === 'peryda-csp')!
  return (html: string) => (plugin.transformIndexHtml as (html: string) => string)(html)
}
const transform = transformFor('production')
const policyOf = (html: string) => /content="([^"]+)"/.exec(html)![1]!
const HEAD = '<head>\n    <meta charset="UTF-8" />\n</head>'

describe('Content Security Policy in index.html', () => {
  it('is added right after the charset tag', () => {
    const out = transform('<head>\n    <meta charset="UTF-8" />\n</head>')
    expect(out).toContain('<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src \'none\';')
    expect(out).toContain("object-src 'none'")
  })

  it('stops the build when the marker is missing or repeated, instead of shipping without a policy', () => {
    expect(() => transform('<head><meta charset="utf-8"></head>')).toThrow(/peryda-csp/)
    expect(() => transform('<meta charset="UTF-8" /><meta charset="UTF-8" />')).toThrow(/peryda-csp/)
  })

  it('is the same policy the web host sends (firebase.json)', () => {
    const hosting = JSON.parse(readFileSync(new URL('../../../firebase.json', import.meta.url), 'utf8')) as {
      hosting: { headers: { headers: { key: string; value: string }[] }[] }
    }
    const header = hosting.hosting.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')!.value
    // The header adds only frame-ancestors, which a meta tag cannot carry.
    expect(header).toBe(`${policyOf(transform(HEAD))}; frame-ancestors 'none'`)
  })

  it('lets only the Windows build talk to its window shell, and adds no other address', () => {
    const web = policyOf(transform(HEAD))
    const windows = policyOf(transformFor('tauri')(HEAD))
    expect(web).not.toContain('ipc')
    expect(windows.replace(' ipc: http://ipc.localhost', '')).toBe(web)
  })

  it('is the same policy the Windows shell sends as a header with every file, workers included (WW-2)', () => {
    const shell = readFileSync(new URL('../../../windows/src-tauri/src/lib.rs', import.meta.url), 'utf8')
    const header = /const CONTENT_SECURITY_POLICY: &str = "([^"]+)";/.exec(shell)?.[1]
    expect(header).toBe(policyOf(transformFor('tauri')(HEAD)))
    expect(shell).toContain('.on_web_resource_request(')
    expect(shell).toContain('"X-Content-Type-Options", HeaderValue::from_static("nosniff")')
  })
})

