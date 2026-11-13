import DOMPurify, { type Config } from 'dompurify'

/**
 * Cleans an EPUB chapter before it is shown. The chapter frame is already sandboxed without scripts and
 * the page's Content Security Policy blocks remote loads; this is the layer that does not depend on
 * either. It runs on the chapter as the frame will receive it (serialized, with the book's pictures and
 * stylesheets already swapped for blob: URLs) and parses it the same way the frame does, as HTML.
 *
 * Removed: scripts, frames, plugins, forms and form controls (their text stays), `meta http-equiv`
 * (refresh, DNS prefetch), every `link` except a stylesheet from the book itself (so no preconnect,
 * prefetch or preload that would tell a remote server when a chapter is read), `on…` handlers, and any
 * link or resource address that leaves the book. A link that leaves the book keeps its text.
 */

const CONFIG: Config = {
  WHOLE_DOCUMENT: true,
  // DOMPurify's own lists cover HTML, SVG and MathML; a chapter also needs its head elements.
  ADD_TAGS: ['link', 'meta', 'base', 'title', '!doctype'],
  // Form controls too: with scripts off they do nothing, and a password field could invite autofill.
  FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'portal', 'input', 'textarea', 'select', 'button'],
  // Books use attributes of their own (epub:type, xml:lang…); only event handlers are refused outright.
  ADD_ATTR: (name: string) => !/^on/i.test(name),
  FORBID_ATTR: ['srcdoc', 'action', 'formaction', 'ping'],
  // Addresses are judged below; DOMPurify still drops javascript: and data: outside pictures and media.
  ALLOW_UNKNOWN_PROTOCOLS: true,
  // Ids such as "title" are common in books and must stay; the one clobbering risk (named pictures
  // shadowing document.body and the like, which epub.js reads) is handled below.
  SANITIZE_DOM: false,
  KEEP_CONTENT: true,
}

const SPACES = /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** An address inside the book: a fragment, or a relative path (not `//host`, which leaves the book). */
export function isInBook(value: string): boolean {
  const v = value.replace(SPACES, '')
  if (!v) return false
  if (v.startsWith('#')) return true
  return !SCHEME.test(v) && !/^[/\\]{2}/.test(v)
}

/** A picture, font or stylesheet address the frame may load: from the book (relative, blob:) or inline (data:). */
export function isLocalResource(value: string): boolean {
  const v = value.replace(SPACES, '')
  return isInBook(v) || /^(blob|data):/i.test(v)
}

const RESOURCE_ATTRS = ['src', 'poster', 'background', 'data', 'cite', 'longdesc', 'href', 'xlink:href']
const LINK_TAGS = new Set(['a', 'area'])

type Purifier = ReturnType<typeof DOMPurify>

let purifier: Purifier | null = null
let baseSeen = false

/** epub.js puts one <base> (on this app's own origin) first in the head to resolve in-book links. */
function isOwnBase(href: string): boolean {
  try {
    return new URL(href).origin === location.origin
  } catch {
    return false
  }
}

function keepElement(el: Element, tag: string): boolean {
  if (tag === 'link') {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    return rel.includes('stylesheet') && /^blob:/i.test((el.getAttribute('href') ?? '').trim())
  }
  if (tag === 'meta') return !el.hasAttribute('http-equiv')
  if (tag === 'base') {
    const keep = !baseSeen && isOwnBase(el.getAttribute('href') ?? '')
    baseSeen = true
    return keep
  }
  return true
}

function cleanAddresses(el: Element): void {
  const tag = el.localName
  if (tag === 'link' || tag === 'base') return
  let unlinked = false
  for (const name of RESOURCE_ATTRS) {
    const value = el.getAttribute(name)
    if (value === null) continue
    const keep = LINK_TAGS.has(tag) && (name === 'href' || name === 'xlink:href') ? isInBook(value) : isLocalResource(value)
    if (!keep) {
      el.removeAttribute(name)
      unlinked = true
    }
  }
  const srcset = el.getAttribute('srcset')
  if (srcset !== null && !srcset.split(',').every((c) => isLocalResource(c.trim().split(/\s+/)[0] ?? ''))) el.removeAttribute('srcset')
  // A link that leaves the book stays as plain text.
  if (unlinked && LINK_TAGS.has(tag)) for (const name of ['target', 'download', 'rel']) el.removeAttribute(name)
  // A named picture could shadow document properties epub.js reads (document.body and the like).
  if (tag === 'img') el.removeAttribute('name')
}

/** A DOMPurify of our own (its hooks stay out of any other use), made on first use in the browser. */
function chapterPurifier(): Purifier {
  if (purifier) return purifier
  const p = DOMPurify(window)
  p.addHook('uponSanitizeElement', (node, data) => {
    if (!keepElement(node as Element, data.tagName)) node.parentNode?.removeChild(node)
  })
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeType === 1) cleanAddresses(node as Element)
  })
  purifier = p
  return p
}

/** An empty chapter, shown if cleaning fails: better a blank page than an uncleaned one. */
export const EMPTY_CHAPTER = '<!DOCTYPE html><html><head></head><body></body></html>'

/** The cleaned chapter, as an HTML document. Throws where there is no DOM to clean it with. */
export function sanitizeChapter(html: string): string {
  const p = chapterPurifier()
  if (!p.isSupported) throw new Error('cannot clean chapters here')
  baseSeen = false
  return p.sanitize(html, CONFIG) as string
}
