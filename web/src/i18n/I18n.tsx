import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { STRINGS, type Lang, type Strings } from './strings'

interface I18nValue {
  lang: Lang
  t: Strings
}

const I18nContext = createContext<I18nValue>({ lang: 'en', t: STRINGS.en })

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => ({ lang, t: STRINGS[lang] }), [lang])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
