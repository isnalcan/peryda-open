// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { STRINGS } from '../i18n/strings'
import { bookDetail, formatRelative, relativeTime, shelf } from './libraryModel'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

const book = (title: string, author: string, addedAt: number, openedAt = 0) => ({ title, author, addedAt, openedAt })

describe('shelf', () => {
  const books = [
    book('Kenar Notları', 'Peryda', 100, 0),
    book('İSTANBUL Hatırası', 'Ahmet Ümit', 50, 400),
    book('Bilgi Kuramı', 'Işık Yazar', 300, 200),
  ]

  it('puts the most recently read (or added) book first', () => {
    expect(shelf(books, '', 'tr').map((b) => b.title)).toEqual(['İSTANBUL Hatırası', 'Bilgi Kuramı', 'Kenar Notları'])
  })

  it('does not reorder the list it was given', () => {
    const copy = [...books]
    shelf(books, '', 'tr')
    expect(books).toEqual(copy)
  })

  it('matches title or author, ignoring case in the reader\'s language', () => {
    expect(shelf(books, 'istanbul', 'tr').map((b) => b.title)).toEqual(['İSTANBUL Hatırası'])
    expect(shelf(books, 'ışık', 'tr').map((b) => b.title)).toEqual(['Bilgi Kuramı'])
    expect(shelf(books, '  PERYDA ', 'tr').map((b) => b.title)).toEqual(['Kenar Notları'])
    expect(shelf(books, 'ümit', 'en').map((b) => b.title)).toEqual(['İSTANBUL Hatırası'])
    expect(shelf(books, 'nothing like it', 'en')).toEqual([])
  })
})

describe('relativeTime', () => {
  it('reads anything under a minute, or in the future, as now', () => {
    expect(relativeTime(NOW, NOW)).toEqual({ value: 0, unit: 'second' })
    expect(relativeTime(NOW - 59_000, NOW)).toEqual({ value: 0, unit: 'second' })
    expect(relativeTime(NOW + DAY, NOW)).toEqual({ value: 0, unit: 'second' })
    expect(relativeTime(Number.NaN, NOW)).toEqual({ value: 0, unit: 'second' })
  })

  it('picks the largest whole unit', () => {
    expect(relativeTime(NOW - 61_000, NOW)).toEqual({ value: -1, unit: 'minute' })
    expect(relativeTime(NOW - 59 * MIN, NOW)).toEqual({ value: -59, unit: 'minute' })
    expect(relativeTime(NOW - 2 * HOUR - 5 * MIN, NOW)).toEqual({ value: -2, unit: 'hour' })
    expect(relativeTime(NOW - DAY, NOW)).toEqual({ value: -1, unit: 'day' })
    expect(relativeTime(NOW - 6 * DAY, NOW)).toEqual({ value: -6, unit: 'day' })
    expect(relativeTime(NOW - 8 * DAY, NOW)).toEqual({ value: -1, unit: 'week' })
    expect(relativeTime(NOW - 29 * DAY, NOW)).toEqual({ value: -4, unit: 'week' })
    expect(relativeTime(NOW - 30 * DAY, NOW)).toEqual({ value: -1, unit: 'month' })
    expect(relativeTime(NOW - 100 * DAY, NOW)).toEqual({ value: -3, unit: 'month' })
    expect(relativeTime(NOW - 800 * DAY, NOW)).toEqual({ value: -2, unit: 'year' })
  })
})

describe('formatRelative', () => {
  it('says now, never "0 seconds ago"', () => {
    expect(formatRelative(NOW - 20_000, NOW, 'tr')).toBe('şimdi')
    expect(formatRelative(NOW - 20_000, NOW, 'en')).toBe('now')
    expect(formatRelative(NOW + 5 * MIN, NOW, 'en')).toBe('now')
    for (const lang of ['tr', 'en', 'de', 'es'] as const) expect(formatRelative(NOW, NOW, lang)).not.toMatch(/0/)
  })

  it('uses natural words where the language has them', () => {
    expect(formatRelative(NOW - DAY, NOW, 'en')).toBe('yesterday')
    expect(formatRelative(NOW - DAY, NOW, 'tr')).toBe('dün')
    expect(formatRelative(NOW - 3 * MIN, NOW, 'tr')).toBe('3 dakika önce')
  })
})

describe('bookDetail', () => {
  const pdf = { author: 'Ada', format: 'pdf' as const, pageCount: 300, openedAt: 0 }
  const tr = STRINGS.tr
  const en = STRINGS.en

  it('shows the length of a PDF not read past its first page', () => {
    expect(bookDetail(pdf, undefined, tr, 'tr', NOW)).toBe('Ada · 300 sayfa')
    expect(bookDetail(pdf, 1, tr, 'tr', NOW)).toBe('Ada · 300 sayfa')
  })

  it('shows where the reader is in a PDF', () => {
    expect(bookDetail(pdf, 12, tr, 'tr', NOW)).toBe('Ada · 12 / 300')
    expect(bookDetail(pdf, 999, tr, 'tr', NOW)).toBe('Ada · 300 / 300')
  })

  it('shows EPUB for an EPUB, and leaves out an empty author', () => {
    expect(bookDetail({ author: '  ', format: 'epub', pageCount: 12, openedAt: 0 }, 4, en, 'en', NOW)).toBe('EPUB')
  })

  it('adds when the book was last read', () => {
    expect(bookDetail({ ...pdf, openedAt: NOW - 10_000 }, 12, tr, 'tr', NOW)).toBe('Ada · 12 / 300 · Son okuma şimdi')
    expect(bookDetail({ ...pdf, openedAt: NOW - 2 * DAY }, undefined, en, 'en', NOW)).toBe('Ada · 300 pages · Last read 2 days ago')
  })
})
