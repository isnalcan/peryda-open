import { describe, expect, it } from 'vitest'
// @ts-expect-error epub.js ships its view classes without types
import IframeView from 'epubjs/src/managers/views/iframe'
import { isInBook, isLocalResource, sanitizeChapter } from './sanitize'
import { RENDITION_OPTIONS } from './epub'

const origin = location.origin

const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="tr" lang="tr">
<head>
<base href="${origin}/OEBPS/ch1.xhtml"/>
<base href="https://evil.example/"/>
<title>Bölüm</title>
<meta charset="utf-8"/>
<meta name="viewport" content="width=600"/>
<meta http-equiv="refresh" content="0;url=https://evil.example"/>
<meta http-equiv="x-dns-prefetch-control" content="on"/>
<link rel="stylesheet" type="text/css" href="blob:${origin}/book-css"/>
<link rel="stylesheet" href="https://evil.example/s.css"/>
<link rel="preconnect" href="https://tracker.example"/>
<link rel="dns-prefetch" href="//tracker.example"/>
<link rel="prefetch" href="blob:${origin}/x"/>
<link rel="preload" as="image" href="https://tracker.example/i.png"/>
<style>p { color: red }</style>
<script>parent.alert(1)</script>
</head>
<body onload="alert(1)">
<h1 id="title" epub:type="title">Bir</h1>
<p onclick="alert(1)" class="x">Metin <a href="ch2.xhtml#n1">iç</a> <a href="https://evil.example/phish" target="_blank">dış</a> <a href="javascript:alert(1)">js</a> <a href=" //evil.example">pr</a> <a href="/\\evil.example">bs</a> <a href="#note">not</a> <a href="mailto:a@b.c">posta</a> <a href="blob:${origin}/page.html">blob</a></p>
<img src="blob:${origin}/img" alt="resim"/>
<img src="https://tracker.example/pixel.gif" alt="iz" name="body"/>
<img srcset="https://tracker.example/a.png 2x" alt="set"/>
<iframe src="https://evil.example"></iframe>
<object data="x.swf">yedek metin</object>
<embed src="x.swf"/>
<form action="https://evil.example"><input name="k"/> form metni</form>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="blob:${origin}/svg-img"/><a xlink:href="https://evil.example" target="_top"><text>svg bağı</text></a><set attributeName="href" to="https://evil.example"/></svg>
</body></html>`

describe('EPUB chapter cleaning', () => {
  const out = sanitizeChapter(CHAPTER)
  const doc = new DOMParser().parseFromString(out, 'text/html')
  const all = (selector: string) => [...doc.querySelectorAll(selector)]

  it('keeps the document whole and in standards mode', () => {
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(doc.documentElement.getAttribute('lang')).toBe('tr')
    expect(doc.title).toBe('Bölüm')
    expect(doc.querySelector('h1')?.getAttribute('epub:type')).toBe('title')
    expect(doc.getElementById('title')).not.toBeNull()
    expect(doc.querySelector('style')?.textContent).toContain('color: red')
  })

  it('removes scripts, frames, plugins, forms and event handlers, keeping readable text', () => {
    expect(all('script, iframe, object, embed, form, input, set')).toHaveLength(0)
    expect(out).not.toMatch(/\son\w+=/i)
    expect(out).not.toContain('alert(1)')
    expect(doc.body.textContent).toContain('form metni')
    expect(doc.body.textContent).toContain('yedek metin')
  })

  it('keeps only the book\'s own stylesheet among links, and no http-equiv', () => {
    expect(all('link').map((l) => [l.getAttribute('rel'), l.getAttribute('href')])).toEqual([['stylesheet', `blob:${origin}/book-css`]])
    expect(all('meta[http-equiv]')).toHaveLength(0)
    expect(all('meta').map((m) => m.getAttribute('charset') ?? m.getAttribute('name'))).toEqual(['utf-8', 'viewport'])
    expect(all('base').map((b) => b.getAttribute('href'))).toEqual([`${origin}/OEBPS/ch1.xhtml`])
  })

  it('keeps in-book links; links that leave the book become plain text', () => {
    const links = all('a').map((a) => [a.textContent, a.getAttribute('href') ?? a.getAttribute('xlink:href'), a.getAttribute('target')])
    expect(links).toEqual([
      ['iç', 'ch2.xhtml#n1', null],
      ['dış', null, null],
      ['js', null, null],
      ['pr', null, null],
      ['bs', null, null],
      ['not', '#note', null],
      ['posta', null, null],
      ['blob', null, null],
      ['svg bağı', null, null],
    ])
  })

  it('keeps the book\'s pictures and drops remote ones', () => {
    expect(all('img').map((i) => [i.getAttribute('alt'), i.getAttribute('src'), i.getAttribute('srcset'), i.getAttribute('name')])).toEqual([
      ['resim', `blob:${origin}/img`, null, null],
      ['iz', null, null, null],
      ['set', null, null, null],
    ])
    expect(doc.querySelector('image')?.getAttribute('xlink:href')).toBe(`blob:${origin}/svg-img`)
  })

  it('judges addresses', () => {
    for (const ok of ['ch2.xhtml', '../Text/c.xhtml#x', '#n', '/OEBPS/x.xhtml']) expect(isInBook(ok)).toBe(true)
    for (const bad of ['https://e.example', '//e.example', ' //e.example', '\\\\e.example', '/\\e.example', 'javascript:x', 'JaVaScRiPt:x', 'mailto:x', 'blob:x', '']) expect(isInBook(bad)).toBe(false)
    expect(isLocalResource(`blob:${origin}/x`)).toBe(true)
    expect(isLocalResource('data:image/png;base64,AA')).toBe(true)
    expect(isLocalResource('https://e.example/x.png')).toBe(false)
  })
})

describe('EPUB frame', () => {
  it('is sandboxed without scripts or popups, in the iframe view', () => {
    expect('view' in RENDITION_OPTIONS).toBe(false)
    expect(RENDITION_OPTIONS.allowScriptedContent).toBe(false)
    const view = new IframeView({ index: 0 }, { ...RENDITION_OPTIONS })
    const frame: HTMLIFrameElement = view.create()
    const sandbox = String(frame.getAttribute('sandbox') ?? frame.sandbox)
    expect(sandbox).toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-popups')
    expect(sandbox).not.toContain('allow-top-navigation')
  })
})
