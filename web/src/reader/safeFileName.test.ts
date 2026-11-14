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
    expect(safeFileName('CON')).toBe('Peryda CON')
    expect(safeFileName('   ')).toBe('Peryda')
    expect(safeFileName('Kitap...')).toBe('Kitap')
    expect(safeFileName('x'.repeat(300))).toHaveLength(120)
  })
  it('treats a device name as reserved with any extension too (CON.tar, nul.txt, COM¹)', () => {
    expect(safeFileName('CON.tar')).toBe('Peryda CON.tar')
    expect(safeFileName('nul.txt')).toBe('Peryda nul.txt')
    expect(safeFileName('COM\u00b9')).toBe('Peryda COM\u00b9')
    expect(safeFileName('Console')).toBe('Console')
  })
  it('removes invisible direction and joining marks', () => {
    // U+202E would show "Notes\u202Etxt.exe" as "Notesexe.txt".
    expect(safeFileName('Notes\u202Etxt.exe')).toBe('Notestxt.exe')
    expect(safeFileName('a\u200Fb\u200Bc\uFEFF')).toBe('abc')
  })
  it('never cuts a character in half at the length limit', () => {
    const name = safeFileName('x'.repeat(119) + '😀😀')
    expect(Array.from(name)).toHaveLength(120)
    expect(name.endsWith('😀')).toBe(true)
  })
})
