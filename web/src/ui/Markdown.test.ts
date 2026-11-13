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
