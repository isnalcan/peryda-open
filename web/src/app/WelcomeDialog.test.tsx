import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { I18nProvider } from '../i18n/I18n'
import { STRINGS, type Lang } from '../i18n/strings'
import { languageOrder, WelcomeDialog } from './WelcomeDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

/** The welcome as the app shows it: choosing a language changes the app's language at once. */
function Harness({ start, chosen }: { start: Lang; chosen: Lang[] }) {
  const [lang, setLang] = useState<Lang>(start)
  return (
    <I18nProvider lang={lang}>
      <WelcomeDialog
        lang={lang}
        onLang={(l) => {
          chosen.push(l)
          setLang(l)
        }}
        onAddKey={() => {}}
        onLater={() => {}}
      />
    </I18nProvider>
  )
}

async function render(start: Lang, chosen: Lang[]) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness start={start} chosen={chosen} />))
}

const click = async (el: Element | null) => {
  expect(el).not.toBeNull()
  await act(async () => (el as HTMLElement).click())
}

describe('first run: the language first (owner, 16 Nov)', () => {
  it('asks for the language in all four languages, then goes on in the one chosen', async () => {
    const chosen: Lang[] = []
    await render('en', chosen)
    const heading = host.querySelector('h2')?.textContent
    expect(heading).toBe(STRINGS.en.chooseLanguage)
    const hint = host.querySelector('.welcome-languages-hint')?.textContent ?? ''
    for (const l of ['tr', 'de', 'es'] as const) expect(hint).toContain(STRINGS[l].chooseLanguage)
    const options = [...host.querySelectorAll('.welcome-language')].map((b) => b.textContent)
    expect(options).toHaveLength(4)
    expect(options.join(' ')).toMatch(/Türkçe.*|English|Deutsch|Español/)
    await click([...host.querySelectorAll('.welcome-language')].find((b) => b.textContent?.includes('Deutsch')) ?? null)
    expect(chosen).toEqual(['de'])
    expect(host.querySelector('h2')?.textContent).toBe(STRINGS.de.welcomeTitle)
    expect(host.textContent).toContain(STRINGS.de.welcomeAddKey)
    // Back to the language, and Continue keeps the one in use.
    await click(host.querySelector('.welcome-back'))
    expect(host.querySelector('h2')?.textContent).toBe(STRINGS.de.chooseLanguage)
    expect(host.querySelector('.welcome-language.is-current')?.textContent).toContain('Deutsch')
    await click(host.querySelector('.welcome-actions .primary-button'))
    expect(chosen).toEqual(['de', 'de'])
    expect(host.querySelector('h2')?.textContent).toBe(STRINGS.de.welcomeTitle)
  })

  it('offers the browser language first', () => {
    expect(languageOrder('es')).toEqual(['es', 'tr', 'en', 'de'])
    expect(languageOrder('tr')[0]).toBe('tr')
  })
})
