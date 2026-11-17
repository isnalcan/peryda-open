import { CONTEXT_LENGTH } from './compose'

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * The text around a selection that travels with it (owner, 17 Nov 2026): about `length` characters
 * centred on the selection, reaching into the previous or next page when the selection is near an edge.
 * A blind test that day scored this clearly above sending the page's opening (7.2 → 8.1 of 10; on
 * "how does this follow from the argument before it" 6.9 → 8.5) at the same size and cost. When the
 * selection cannot be found in the page text, the page's opening is sent as before.
 * Mac: PerydaKit `CenteredContext.make` follows the same rules.
 */
export function centeredContext(page: string, selected: string, before = '', after = '', length = CONTEXT_LENGTH): string | undefined {
  const text = norm(page)
  if (!text) return undefined
  const sel = norm(selected)
  let idx = sel ? text.indexOf(sel) : -1
  if (idx < 0 && sel.length > 40) idx = text.indexOf(sel.slice(0, 40))
  if (idx < 0) return text.slice(0, length)
  const prev = norm(before)
  const next = norm(after)
  const full = [prev, text, next].filter(Boolean).join(' ')
  const at = (prev ? prev.length + 1 : 0) + idx
  const selLength = Math.min(sel.length, full.length - at)
  const side = Math.max(0, Math.floor((length - selLength) / 2))
  let start = Math.max(0, at - side)
  let end = Math.min(full.length, at + selLength + side)
  // Room left on one side goes to the other.
  if (start === 0) end = Math.min(full.length, Math.max(end, length))
  if (end === full.length) start = Math.max(0, Math.min(start, full.length - length))
  return full.slice(start, end).trim().slice(0, Math.max(length, selLength))
}
