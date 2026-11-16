import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { I18nProvider } from '../i18n/I18n'
import { LANGS, detectLang, type Lang } from '../i18n/strings'
import { db, getPref, setPref, type BookRecord } from '../data/db'
import { DEFAULT_SETTINGS, clearSettings, loadSettings, saveSettings } from '../data/keyVault'
import { keyFor, type ByokSettings } from '../ai/provider'
import { abandonBatchJobs } from '../ai/batch'
import { releaseJobsOfOldKey } from '../ai/oldKeyJobs'
import { announceKeysChanged, onKeysChanged } from '../data/keysChannel'
import { Library } from '../library/Library'
// Readers load only when a book opens, so the library appears quickly.
const PdfReader = lazy(() => import('../reader/PdfReader').then((m) => ({ default: m.PdfReader })))
const EpubReader = lazy(() => import('../reader/EpubReader').then((m) => ({ default: m.EpubReader })))
import { SettingsDialog, type ThemePref } from '../settings/SettingsDialog'
import { ErrorBoundary } from './ErrorBoundary'
import { WelcomeDialog } from './WelcomeDialog'
import { STRINGS } from '../i18n/strings'
import { useDesktopUpdates } from '../updates/desktopUpdates'
import { UpdateNotice } from '../updates/UpdateViews'

const THEMES: readonly ThemePref[] = ['system', 'light', 'dark']

/**
 * Safe start: set while a book is opening and cleared once it has drawn. Still set at launch means the
 * last book never finished opening (the tab may have crashed on it), so the app starts in the library
 * instead of opening that book again.
 */
const OPENING = 'openingBookId'

export function App() {
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState<unknown>(null)
  const [lang, setLang] = useState<Lang>(detectLang())
  const [theme, setTheme] = useState<ThemePref>('system')
  const [settings, setSettings] = useState<ByokSettings>(DEFAULT_SETTINGS)
  const [remember, setRemember] = useState(true)
  const [book, setBook] = useState<BookRecord | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const updates = useDesktopUpdates()

  useEffect(() => {
    void (async () => {
      const [savedLang, savedTheme, savedRemember] = await Promise.all([
        getPref<unknown>('lang', null),
        getPref<unknown>('theme', 'system'),
        getPref<unknown>('rememberKeys', true),
      ])
      // With "Remember" off the keys were never meant to stay: any left behind (a removal that failed)
      // are removed now, not loaded (audit 16 Nov, K16-6).
      const keys = savedRemember === false ? await clearSettings().then(() => ({ ...DEFAULT_SETTINGS }), () => ({ ...DEFAULT_SETTINGS })) : await loadSettings()
      // Stored values are checked: one odd value must not keep the app from starting.
      if (LANGS.includes(savedLang as Lang)) setLang(savedLang as Lang)
      if (!(await getPref<boolean>('welcomed', false))) setShowWelcome(true)
      setTheme(THEMES.includes(savedTheme as ThemePref) ? (savedTheme as ThemePref) : 'system')
      setRemember(savedRemember !== false)
      setSettings(keys)
      // Development only: ?dev-import=okuma.pdf adds a sample from web/dev-samples (not in builds).
      if (import.meta.env.DEV) {
        const sample = new URLSearchParams(location.search).get('dev-import')
        if (sample && /^[\w.-]+\.(pdf|epub)$/.test(sample)) {
          const { importBook } = await import('../library/importBook')
          const blob = await (await fetch(`/dev-samples/${sample}`)).blob()
          const imported = await importBook(new File([blob], sample, { type: blob.type }))
          setBook(imported)
          setReady(true)
          return
        }
      }
      if (await getPref<unknown>(OPENING, null)) {
        await setPref(OPENING, null)
        await setPref('openBookId', null)
        setNotice('lastOpenFailed')
      } else {
        const lastBookId = await getPref<unknown>('openBookId', null)
        const last = typeof lastBookId === 'string' ? await db.books.get(lastBookId) : undefined
        if (last) {
          await setPref(OPENING, last.id)
          setBook(last)
        }
      }
      setReady(true)
    })().catch((error: unknown) => setFatal(error ?? new Error('start failed')))
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  // The book is remembered as the one to reopen only once it has opened (see OPENING).
  const openBook = useCallback(async (b: BookRecord | null) => {
    setNotice(null)
    if (b) {
      await setPref(OPENING, b.id)
    } else {
      void setPref(OPENING, null)
      void setPref('openBookId', null)
    }
    setBook(b)
  }, [])
  const onOpened = useCallback((bookId: string) => {
    void setPref('openBookId', bookId).then(() => setPref(OPENING, null))
  }, [])
  // Jobs a deleted book's page translations were waiting on are cancelled, so they are not billed.
  const onBookDeleted = useCallback((jobs: string[]) => void abandonBatchJobs(keyFor(settings, 'gemini'), jobs), [settings])

  /**
   * The keys are written first: if this device refuses the write (storage full, blocked), nothing changes
   * and the Settings dialog says so, instead of showing a removed key that comes back at the next start
   * (audit 15 Nov, KR-3). Other open tabs then load the new keys.
   */
  const onSave = async (next: ByokSettings, keep: boolean) => {
    await setPref('rememberKeys', keep)
    if (keep) await saveSettings(next)
    else await clearSettings()
    // Jobs made with a Gemini key that is changed or removed are collected or let go with that key (K-3).
    // The open book's own stores do this for what they hold; the rest of the library is done here.
    const oldGemini = keyFor(settings, 'gemini')
    if (oldGemini && oldGemini !== keyFor(next, 'gemini')) void releaseJobsOfOldKey(oldGemini, { except: book?.id }).catch(() => undefined)
    setSettings(next)
    setRemember(keep)
    announceKeysChanged()
  }

  // Keys saved or removed in another tab of this site take effect here too (audit 15 Nov, KR-3). With
  // "Remember keys" on, the vault is what counts. With it off nothing is stored, so there is nothing to
  // load: this tab keeps the keys it holds for the session, and since "Remember" is now off it will not
  // write them back either (audit final F-10: they were dropped).
  useEffect(() => {
    return onKeysChanged(() => {
      void (async () => {
        const keep = (await getPref<unknown>('rememberKeys', true)) !== false
        setRemember(keep)
        if (keep) setSettings(await loadSettings())
      })()
    })
  }, [])

  // An error while starting is shown by the root boundary (with its way out) instead of a blank page.
  if (fatal) throw fatal
  if (!ready) return null
  return (
    <I18nProvider lang={lang}>
      <ErrorBoundary key={book?.id ?? 'library'} title={STRINGS[lang].errorUnknown} action={STRINGS[lang].back} onReset={() => void openBook(null)}>
      <Suspense fallback={<div className="reader-shell" />}>
      {book && book.format === 'pdf' ? (
        <PdfReader key={book.id} book={book} settings={settings} onOpened={onOpened} onBack={() => void openBook(null)} onOpenSettings={() => setShowSettings(true)} />
      ) : book && book.format === 'epub' ? (
        <EpubReader key={book.id} book={book} settings={settings} onOpened={onOpened} onBack={() => void openBook(null)} onOpenSettings={() => setShowSettings(true)} />
      ) : (
        <Library
          onOpen={(b) => void openBook(b)}
          onOpenSettings={() => setShowSettings(true)}
          onBookDeleted={onBookDeleted}
          notice={notice === 'lastOpenFailed' ? STRINGS[lang].lastOpenFailed : null}
        />
      )}
      </Suspense>
      </ErrorBoundary>
      {showWelcome && (
        <WelcomeDialog
          lang={lang}
          onLang={(l) => {
            setLang(l)
            void setPref('lang', l)
          }}
          onAddKey={() => {
            setShowWelcome(false)
            void setPref('welcomed', true)
            setShowSettings(true)
          }}
          onLater={() => {
            setShowWelcome(false)
            void setPref('welcomed', true)
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          remember={remember}
          lang={lang}
          theme={theme}
          onSave={onSave}
          onLang={(l) => {
            setLang(l)
            void setPref('lang', l)
          }}
          onTheme={(th) => {
            setTheme(th)
            void setPref('theme', th)
          }}
          onClose={() => setShowSettings(false)}
          updates={updates}
        />
      )}
      {updates && !showWelcome && <UpdateNotice updates={updates} />}
    </I18nProvider>
  )
}
