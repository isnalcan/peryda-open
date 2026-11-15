import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { Library } from './Library'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const imported = vi.hoisted(() => [] as File[])
const photoBooks = vi.hoisted(() => [] as File[][])
vi.mock('./importBook', () => ({
  ImportError: class extends Error {},
  importBook: async (file: File) => {
    imported.push(file)
    return { id: 'b1', title: file.name, author: '', format: 'pdf', pageCount: 1, size: file.size, fingerprint: 'f', addedAt: 1, openedAt: 0 }
  },
  importImages: async (files: File[]) => {
    photoBooks.push(files)
    return { id: 'b2', title: files[0]!.name, author: '', format: 'pdf', pageCount: files.length, size: 1, fingerprint: 'g', addedAt: 1, openedAt: 0 }
  },
}))

/** Chooses files in the hidden input as the browser does. */
async function choose(host: HTMLElement, files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, get: () => files })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
  })
}

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

  // Owner, 16 Nov: photos of pages can be added; chosen together they become one book.
  it('takes photos, and makes the photos chosen together one book beside the PDFs', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onOpen = vi.fn()
    await act(async () => root.render(<Library onOpen={onOpen} onOpenSettings={() => undefined} />))
    expect(host.querySelector('input[type="file"]')!.getAttribute('accept')).toContain('.heic')
    imported.length = 0
    const pdf = new File(['%PDF'], 'ek.pdf', { type: 'application/pdf' })
    const photos = [new File(['a'], 'IMG_1.jpg', { type: 'image/jpeg' }), new File(['b'], 'IMG_2.png', { type: 'image/png' })]
    await choose(host, [photos[0]!, pdf, photos[1]!])
    expect(imported).toEqual([pdf])
    expect(photoBooks).toEqual([photos])
    expect(host.querySelector('.toast')?.textContent).toBe('2 photos were added as one book.')
    // Several files: the library stays open.
    expect(onOpen).not.toHaveBeenCalled()
    act(() => root.unmount())
    host.remove()
  })
})
