import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { TranslateRangeDialog } from './ReaderDialogs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
})

/** Sets an input's value the way typing does, so React sees the change. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

// Owner test 15 Nov: typing 150 over 6 snapped back to 6 at the first "1".
describe('Page range fields', () => {
  it('keep what is typed and check it only when the field is left', async () => {
    const onTranslate = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <I18nProvider lang="tr">
          <TranslateRangeDialog page={6} pages={400} onTranslate={onTranslate} onClose={() => undefined} />
        </I18nProvider>,
      )
    })
    const [, last] = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="number"]'))
    for (const step of ['', '1', '15', '150']) {
      await act(async () => type(last!, step))
      expect(last!.value).toBe(step)
    }
    expect(host.textContent).toContain('145 sayfa çevrilecek')
    await act(async () => last!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(last!.value).toBe('150')
    // A last page before the first is put right only when the field is left.
    await act(async () => type(last!, '3'))
    expect(last!.value).toBe('3')
    await act(async () => last!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(last!.value).toBe('6')
    await act(async () => type(last!, '150'))
    const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Çevir')!
    await act(async () => button.click())
    expect(onTranslate).toHaveBeenCalledWith(6, 150)
    root.unmount()
    host.remove()
  })
})
