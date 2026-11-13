import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { Library } from './Library'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const imported = vi.hoisted(() => [] as File[])
vi.mock('./importBook', () => ({
  ImportError: class extends Error {},
  importBook: async (file: File) => {
    imported.push(file)
    return { id: 'b1', title: file.name, author: '', format: 'pdf', pageCount: 1, size: file.size, fingerprint: 'f', addedAt: 1, openedAt: 0 }
  },
}))

describe('"Add book"', () => {
  it('adds the chosen files even though clearing the input empties its FileList (as Chromium/WebView2 do)', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onOpen = vi.fn()
    await act(async () => root.render(<Library onOpen={onOpen} onOpenSettings={() => undefined} />))
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!

    // A live FileList: setting the input's value to '' empties this same object.
    const file = new File(['%PDF'], 'kitap.pdf', { type: 'application/pdf' })
    const live: { length: number; [i: number]: File } = { length: 1, 0: file }
    Object.defineProperty(input, 'files', { configurable: true, get: () => live })
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => (live.length ? 'C:\\fakepath\\kitap.pdf' : ''),
      set: (v: string) => {
        if (v === '') {
          live.length = 0
          delete live[0]
        }
      },
    })

    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(imported).toEqual([file])
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: 'kitap.pdf' }))
    act(() => root.unmount())
    host.remove()
  })
})
