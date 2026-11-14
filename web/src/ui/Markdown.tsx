import { Fragment, memo, type ReactNode } from 'react'

/**
 * A small, safe renderer for Pery's answers: paragraphs, headings, bullet and numbered lists, quotes,
 * lines (`---`), and bold, italic and inline code. It builds React elements only; no HTML from the
 * provider is ever inserted, and a link or image keeps its words but not its address. The Mac app
 * follows the same rules (PerydaKit Markdown.swift); both are checked against
 * shared/vectors/markdown.json.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Text this long is not an answer Pery wrote (answers are capped far below); it can only come from a
  // backup. It is shown as plain paragraphs, so no parsing can hold up the page (audit 15 Nov, WW-1).
  if (text.length > PLAIN_ABOVE) {
    return (
      <>
        {text.split(/\n{2,}/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </>
    )
  }
  const blocks = parseBlocks(text)
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'ul') return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
        if (b.type === 'ol') return <ol key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
        if (b.type === 'h') return <p key={i} className="md-heading">{inline(b.text)}</p>
        if (b.type === 'quote') return <blockquote key={i}>{inline(b.text)}</blockquote>
        if (b.type === 'hr') return <hr key={i} className="md-rule" />
        return <p key={i}>{inline(b.text)}</p>
      })}
    </>
  )
})

/** Longer text is shown without Markdown. */
export const PLAIN_ABOVE = 200_000

export type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'hr' }

const SETEXT = /^\s*(?:={2,}|-{2,})\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^\s*[-*•+]\s+(.*)$/
const NUMBER = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const INDENTED = /^\s+\S/

/**
 * "# Title" or "### Title ###": the heading's words, or null. Read by hand rather than with one
 * regular expression, which took quadratic time on a heading line full of spaces (audit 15 Nov, WW-1).
 */
function headingText(line: string): string | null {
  const l = line.trim()
  let hashes = 0
  while (hashes < l.length && l[hashes] === '#') hashes++
  if (hashes < 1 || hashes > 6 || hashes >= l.length || !/\s/.test(l[hashes]!)) return null
  const body = l.slice(hashes).trim()
  // Closing hashes go when a space stands before them ("# Title ##"); "# ##" keeps them as the title.
  let end = body.length
  while (end > 0 && body[end - 1] === '#') end--
  if (end < body.length && end > 0 && /\s/.test(body[end - 1]!)) return body.slice(0, end).trimEnd()
  return body
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let previous: 'blank' | 'paragraph' | 'item' | 'quote' | 'other' = 'blank'
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const last = blocks[blocks.length - 1]
    if (!line.trim()) {
      flush()
      previous = 'blank'
      continue
    }
    if (paragraph.length && SETEXT.test(line)) {
      blocks.push({ type: 'h', text: paragraph.join(' ') })
      paragraph = []
      previous = 'other'
      continue
    }
    if (RULE.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      previous = 'other'
      continue
    }
    const heading = headingText(line)
    if (heading !== null) {
      flush()
      blocks.push({ type: 'h', text: heading })
      previous = 'other'
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBER.exec(line)
    if (bullet || numbered) {
      flush()
      const type = bullet ? 'ul' : 'ol'
      const item = (bullet ?? numbered)![1]!
      const current = blocks[blocks.length - 1]
      if (current && current.type === type) current.items.push(item)
      else blocks.push({ type, items: [item] })
      previous = 'item'
      continue
    }
    if (previous === 'item' && INDENTED.test(line) && last && (last.type === 'ul' || last.type === 'ol')) {
      // An indented line under a list item goes on with that item.
      last.items[last.items.length - 1] += ` ${line.trim()}`
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const current = blocks[blocks.length - 1]
      if (previous === 'quote' && current && current.type === 'quote') current.text += ` ${quote[1]!}`
      else blocks.push({ type: 'quote', text: quote[1]! })
      previous = 'quote'
      continue
    }
    paragraph.push(line.trim())
    previous = 'paragraph'
  }
  flush()
  return blocks
}

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

/**
 * Bold italic, bold, italic, code, and links or images (their words only). A closing mark must follow a
 * letter, not a space, and an underscore inside a word is just an underscore. A link's words and address
 * have an upper length, so text full of unclosed "[" or "![a](" cannot take quadratic time (audit
 * 15 Nov, WW-1).
 */
const INLINE =
  /(\*\*\*[^*\s](?:[^*]*[^*\s])?\*\*\*|\*\*[^*\s](?:[^*]*[^*\s])?\*\*|__[^_\s](?:[^_]*[^_\s])?__|\*[^*\s](?:[^*]*[^*\s])?\*|(?<![\p{L}\p{N}])_[^_\s](?:[^_]*[^_\s])?_(?![\p{L}\p{N}])|`[^`]+`|!?\[[^\]]{1,200}\]\([^)\s]{0,500}\))/gu

export function parseInline(text: string): Span[] {
  const out: Span[] = []
  const add = (span: Span) => {
    if (!span.text) return
    const prev = out[out.length - 1]
    const plain = (s: Span) => !s.bold && !s.italic && !s.code
    if (prev && plain(prev) && plain(span)) prev.text += span.text
    else out.push(span)
  }
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const token = m[0]
    const start = m.index ?? 0
    if (start > last) add({ text: text.slice(last, start) })
    if (token.startsWith('***')) add({ text: token.slice(3, -3), bold: true, italic: true })
    else if (token.startsWith('**') || token.startsWith('__')) add({ text: token.slice(2, -2), bold: true })
    else if (token.startsWith('`')) add({ text: token.slice(1, -1), code: true })
    else if (token.startsWith('[') || token.startsWith('![')) add({ text: token.slice(token.indexOf('[') + 1, token.indexOf(']')) })
    else add({ text: token.slice(1, -1), italic: true })
    last = start + token.length
  }
  if (last < text.length) add({ text: text.slice(last) })
  return out
}

function inline(text: string): ReactNode {
  return (
    <Fragment>
      {parseInline(text).map((s, i) => {
        if (s.code) return <code key={i}>{s.text}</code>
        let node: ReactNode = s.text
        if (s.italic) node = <em>{node}</em>
        if (s.bold) node = <strong>{node}</strong>
        return <Fragment key={i}>{node}</Fragment>
      })}
    </Fragment>
  )
}
