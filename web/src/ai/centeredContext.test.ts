import { describe, expect, it } from 'vitest'
import { centeredContext } from './centeredContext'

const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')

describe('context centred on the selection (owner, 17 Nov 2026)', () => {
  it('takes the text on both sides of a selection in the middle of a page', () => {
    const page = `${words('a', 300)} SEÇİLEN CÜMLE BURADA. ${words('b', 300)}`
    const c = centeredContext(page, 'SEÇİLEN CÜMLE BURADA.')!
    expect(c).toContain('SEÇİLEN CÜMLE BURADA.')
    expect(c.length).toBeLessThanOrEqual(1200)
    expect(c.length).toBeGreaterThan(1100)
    const at = c.indexOf('SEÇİLEN')
    expect(Math.abs(at - (c.length - at - 21))).toBeLessThan(40)
    expect(c.startsWith('a0 ')).toBe(false)
  })

  it('reaches into the next page when the selection ends its page, and the previous one at its start', () => {
    const end = centeredContext(`${words('a', 400)} SON CÜMLE.`, 'SON CÜMLE.', '', words('n', 200))!
    expect(end).toContain('SON CÜMLE.')
    expect(end).toContain('n0 n1')
    const start = centeredContext(`İLK CÜMLE. ${words('a', 400)}`, 'İLK CÜMLE.', words('p', 200), '')!
    expect(start).toContain('p199')
    expect(start).toContain('İLK CÜMLE.')
  })

  it('ignores line breaks and spaces, and falls back to the page opening when the selection is not found', () => {
    expect(centeredContext('Bir\n  iki   üç dört', 'iki\nüç')).toBe('Bir iki üç dört')
    expect(centeredContext(`${words('a', 400)}`, 'yok böyle bir şey')).toBe(words('a', 400).slice(0, 1200))
    expect(centeredContext('   ', 'x')).toBeUndefined()
  })

  it('keeps a selection longer than the length whole', () => {
    const long = words('s', 400)
    expect(centeredContext(`önce ${long} sonra`, long)).toBe(long)
  })
})
