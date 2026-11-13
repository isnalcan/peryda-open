import { AiError } from './client'

/** Development only: ?fake-ai streams a canned answer so the interface can be worked on without a key. */
export function useFakeAi(): boolean {
  return import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('fake-ai')
}

const ANSWER =
  'Bu, arayüzü denemek için yerel bir örnek yanıttır. **Gerçek yanıt** senin anahtarınla seçtiğin sağlayıcıdan gelir.\n\n- Kısa bir madde\n- Bir madde daha'

const PAGE =
  '# Örnek çeviri sayfası\n\nBu metin, sayfa çevirisi görünümünü anahtarsız denemek için üretilmiş yerel bir örnektir. Gerçek çeviri, seçtiğin sağlayıcıdan gelir ve sayfanın tamamını kapsar.\n\nKavramlar sınırlarında netleşir: bir düşünce, neyi dışarıda bıraktığı görüldüğünde anlaşılır hâle gelir. **Önemli terimler** kalın yazılır, zor terimlerin yanına (parantez içinde) kısa açıklamalar eklenir.\n\n- Birinci madde, sayfadaki bir listeyi temsil eder.\n- İkinci madde, düzenin korunduğunu gösterir.\n\nSon paragraf, sayfanın sonuna kadar akan metnin nasıl yerleştiğini görmek içindir.'

export async function* fakeStream(signal?: AbortSignal, page = false): AsyncGenerator<string> {
  const text = page ? PAGE : ANSWER
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    if (signal?.aborted) throw new AiError('aborted', 'aborted')
    await new Promise((r) => setTimeout(r, page ? 12 : 30))
    yield piece
  }
}
