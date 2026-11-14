import { describe, expect, it } from 'vitest'
import { safeFileName } from './ReaderDialogs'

// Audit 15 Nov (WW-8): "Save all" names the file after the book's title.
describe('A book title as a file name', () => {
  it('keeps an ordinary title', () => {
    expect(safeFileName('Gelişim Psikolojisi: Kuramlar')).toBe('Gelişim Psikolojisi- Kuramlar')
  })
  it('drops path separators, refused characters and control characters', () => {
    const name = safeFileName('../..\\evil/x<y>|z?*"\u0000')
    expect(name).not.toMatch(/[\\/:*?"<>|\u0000-\u001f]/)
    expect(name.startsWith('.')).toBe(false)
  })
  it('avoids reserved names, empty names and trailing dots', () => {
    expect(safeFileName('CON')).toBe('Peryda')
    expect(safeFileName('   ')).toBe('Peryda')
    expect(safeFileName('Kitap...')).toBe('Kitap')
    expect(safeFileName('x'.repeat(300))).toHaveLength(120)
  })
})
