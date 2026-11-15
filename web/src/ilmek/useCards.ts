import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useFakeAi } from '../ai/fake'
import type { ByokSettings } from '../ai/provider'
import type { Lang } from '../i18n/strings'
import { CardsStore } from './cardsStore'

export type { CreateCardInput, PageSource } from './cardsStore'

export interface CardsContext {
  bookId: string
  bookTitle: string
  lang: Lang
  settings: ByokSettings
}

/** The open book's threads, kept in a CardsStore; re-renders when they change. */
export function useCards(ctx: CardsContext) {
  const fake = useFakeAi()
  // One store per book; the reader's settings, language and title are kept current on it.
  const store = useMemo(
    () => new CardsStore({ bookId: ctx.bookId, bookTitle: ctx.bookTitle, lang: ctx.lang, settings: ctx.settings, fake }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.bookId, fake],
  )
  store.lang = ctx.lang
  store.bookTitle = ctx.bookTitle
  // A changed Gemini key makes the store collect or let go of its jobs: that happens in an effect, never
  // while rendering (audit 15 Nov, WR-5).
  useEffect(() => {
    store.settings = ctx.settings
  }, [store, ctx.settings])

  useEffect(() => {
    void store.load()
    return () => store.dispose()
  }, [store])

  const cards = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return {
    store,
    cards,
    loaded: store.loaded,
    create: store.create,
    ask: store.ask,
    retry: store.retry,
    stop: store.stop,
    remove: store.remove,
    update: store.update,
    resize: store.resize,
    resizeFrom: store.resizeFrom,
    placeMany: store.placeMany,
  }
}
