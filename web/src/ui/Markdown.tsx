import { Fragment, type ReactNode } from 'react'

/**
 * A small, safe renderer for Pery's answers: paragraphs, headings, bullet and numbered lists, bold,
 * italic and inline code. It builds React elements only; no HTML from the provider is ever inserted.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'ul') return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
        if (b.type === 'ol') return <ol key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
        if (b.type === 'h') return <p key={i} className="md-heading">{inline(b.text)}</p>
        if (b.type === 'quote') return <blockquote key={i}>{inline(b.text)}</blockquote>
        return <p key={i}>{inline(b.text)}</p>
      })}
    </>
  )
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (!line.trim()) {
      flush()
    } else if (bullet || numbered) {
      flush()
      const type = bullet ? 'ul' : 'ol'
      const item = (bullet ?? numbered)![1]!
      const last = blocks[blocks.length - 1]
      if (last && last.type === type) last.items.push(item)
      else blocks.push({ type, items: [item] })
    } else if (heading) {
      flush()
      blocks.push({ type: 'h', text: heading[1]! })
    } else if (quote) {
      flush()
      blocks.push({ type: 'quote', text: quote[1]! })
    } else {
      paragraph.push(line.trim())
    }
  }
  flush()
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g

function inline(text: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const token = m[0]
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    if (token.startsWith('**') || token.startsWith('__')) out.push(<strong key={start}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) out.push(<code key={start}>{token.slice(1, -1)}</code>)
    else out.push(<em key={start}>{token.slice(1, -1)}</em>)
    last = start + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return <Fragment>{out}</Fragment>
}
