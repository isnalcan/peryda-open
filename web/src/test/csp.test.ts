// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Plugin } from 'vite'
import config from '../../vite.config'

const plugin = (config.plugins ?? []).flat().find((p): p is Plugin => Boolean(p) && (p as Plugin).name === 'peryda-csp')!
const transform = (html: string) => (plugin.transformIndexHtml as (html: string) => string)(html)

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
})
