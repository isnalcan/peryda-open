import { describe, expect, it } from 'vitest'
import { joinTextItems, type TextRun } from './pageText'

/** A horizontal pdf.js text run at (x, y), `size` points high, `width` points wide. */
function run(str: string, x: number, width: number, opts: { y?: number; size?: number; eol?: boolean } = {}): TextRun {
  const size = opts.size ?? 10
  return { str, hasEOL: opts.eol ?? false, transform: [size, 0, 0, size, x, opts.y ?? 700], width }
}

/** Runs laid end to end on one line, as pdf.js reports a word whose letters come from two fonts. */
function abutting(parts: string[], x = 72, y = 700, size = 10): TextRun[] {
  const out: TextRun[] = []
  for (const str of parts) {
    const width = str.length * size * 0.5
    out.push(run(str, x, width, { y, size }))
    x += width
  }
  return out
}

describe('page text from pdf.js runs', () => {
  it('joins a word split where the font changes', () => {
    // "Parasını ödeyebildiğim": ı ş ğ come from a second (Latin Extended) font subset.
    const first = abutting(['Paras', 'ı', 'n', 'ı'])
    const end = first[first.length - 1]!
    const spaceAt = end.transform[4]! + end.width
    const second = abutting(['ödeyebildi', 'ğ', 'im'], spaceAt + 2.8)
    expect(joinTextItems([...first, run(' ', spaceAt, 2.8), ...second])).toBe('Parasını ödeyebildiğim')
    // Without pdf.js's own space run, the gap itself still makes the space.
    expect(joinTextItems([...first, ...second])).toBe('Parasını ödeyebildiğim')
  })

  it('keeps a space where there is a real gap', () => {
    expect(joinTextItems([run('word', 72, 20), run('next', 95, 20)])).toBe('word next')
  })

  it('does not double a space pdf.js already reports', () => {
    expect(joinTextItems([run('word', 72, 20), run(' ', 92, 3), run('next', 95, 20)])).toBe('word next')
    expect(joinTextItems([run('word ', 72, 23), run('next', 95, 20)])).toBe('word next')
  })

  it('joins kerned and letter-spaced runs', () => {
    expect(joinTextItems([run('A', 72, 7), run('V', 78.4, 7)])).toBe('AV')
    expect(joinTextItems([run('T', 72, 6), run('R', 79, 6), run('A', 86, 6)])).toBe('TRA')
  })

  it('keeps line ends', () => {
    const runs = [run('first line', 72, 50, { eol: true }), run('second', 72, 30, { y: 686 })]
    expect(joinTextItems(runs)).toBe('first line\nsecond')
    expect(joinTextItems([run('end', 72, 15), { ...run('', 87, 0), hasEOL: true }, run('next', 72, 20, { y: 686 })])).toBe('end\nnext')
  })

  it('puts a space between runs on different lines that pdf.js did not mark', () => {
    expect(joinTextItems([run('end', 300, 15), run('start', 72, 25, { y: 686 })])).toBe('end start')
  })

  it('puts a space when the next run starts back to the left on the same line', () => {
    expect(joinTextItems([run('left column', 72, 55), run('right', 80, 25)])).toBe('left column right')
  })

  it('sets raised and lowered runs apart, as before', () => {
    // An author's affiliation letters: "Awad a,b", not "Awada,b".
    expect(joinTextItems([run('Awad', 72, 20), run('a,b', 92, 6, { y: 704, size: 6 })])).toBe('Awad a,b')
    expect(joinTextItems([run('H', 72, 7), run('2', 79, 3.5, { y: 697, size: 6 }), run('O', 82.5, 7)])).toBe('H 2 O')
  })

  it('tolerates a baseline that wobbles a little', () => {
    expect(joinTextItems([run('Paras', 72, 25), run('ı', 97, 3, { y: 700.4 }), run('nı', 100, 8)])).toBe('Parasını')
  })

  it('measures along the baseline of rotated text', () => {
    // Text running upwards: the baseline points along +y.
    const up = (str: string, y: number, width: number): TextRun => ({ str, hasEOL: false, transform: [0, 10, -10, 0, 300, y], width })
    expect(joinTextItems([up('Paras', 100, 25), up('ı', 125, 3), up('nı', 128, 8)])).toBe('Parasını')
    expect(joinTextItems([up('two', 100, 15), up('words', 118, 25)])).toBe('two words')
  })

  it('falls back to a space when a run has no usable position', () => {
    expect(joinTextItems([{ str: 'a', hasEOL: false, transform: [], width: 5 }, run('b', 77, 5)])).toBe('a b')
    expect(joinTextItems([run('a', 72, Number.NaN), run('b', 77, 5)])).toBe('a b')
  })

  it('leaves no space at the very end', () => {
    expect(joinTextItems([run('last', 72, 20)])).toBe('last')
    expect(joinTextItems([])).toBe('')
  })
})
