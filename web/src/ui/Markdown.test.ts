import { describe, expect, it } from 'vitest'
import vectors from '@shared/vectors/markdown.json'
import { parseBlocks, parseInline, type Block, type Span } from './Markdown'

// The Mac app runs the same file (PerydaKit MarkdownTests), so both read Pery's answers alike.
describe('Markdown, as shared with the Mac app', () => {
  it.each(vectors.blocks.map((c) => [c.name, c] as const))('blocks: %s', (_, c) => {
    expect(parseBlocks(c.text)).toEqual(c.blocks as Block[])
  })

  it.each(vectors.inline.map((c) => [c.name, c] as const))('inline: %s', (_, c) => {
    expect(parseInline(c.text)).toEqual(c.spans as Span[])
  })
})

// Audit 15 Nov (WW-1): text a backup can carry must not freeze the page. Before the fix 200 kB of
// "![a](" took about 26 s in one parse.
describe('Markdown on hostile text', () => {
  const time = (f: () => unknown) => {
    const start = performance.now()
    f()
    return performance.now() - start
  }
  /** The faster of two runs, so a busy machine's pause does not count. */
  const best = (f: () => unknown) => Math.min(time(f), time(f))
  // Four times the text takes about four times as long when parsing is linear, sixteen times when it is
  // quadratic. Comparing growth instead of wall-clock time keeps this test right on a loaded machine
  // (audit 15 Nov, WR-4); the floor ignores timings too small to measure.
  const linear = (small: number, large: number) => expect(large).toBeLessThan(Math.max(small * 8, 60))

  it('reads unclosed links and images in linear time', () => {
    for (const unit of ['![a](', '[a']) {
      linear(best(() => parseInline(unit.repeat(10_000))), best(() => parseInline(unit.repeat(40_000))))
    }
  })

  it('reads a heading line full of spaces in linear time', () => {
    linear(best(() => parseBlocks(`# a${' '.repeat(10_000)}b`)), best(() => parseBlocks(`# a${' '.repeat(40_000)}b`)))
    expect(parseBlocks(`# a${' '.repeat(10)}b`)).toEqual([{ type: 'h', text: `a${' '.repeat(10)}b` }])
  })

  it('keeps reading headings as before', () => {
    expect(parseBlocks('# Title ##')).toEqual([{ type: 'h', text: 'Title' }])
    expect(parseBlocks('## Title#')).toEqual([{ type: 'h', text: 'Title#' }])
    expect(parseBlocks('# ##')).toEqual([{ type: 'h', text: '##' }])
    expect(parseBlocks('####### seven')).toEqual([{ type: 'p', text: '####### seven' }])
    expect(parseBlocks('#no space')).toEqual([{ type: 'p', text: '#no space' }])
  })

  it('still keeps the words of a normal link', () => {
    expect(parseInline('see [the page](https://example.com) here')).toEqual([{ text: 'see the page here' }])
  })
})
