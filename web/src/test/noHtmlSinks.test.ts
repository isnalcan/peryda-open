// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The app's defence against script injection is that no text (from a book, a backup or an AI answer) is
 * ever turned into HTML or code. This keeps it that way: none of these may appear in the app's source.
 * There is no allow-list; a real need for one should be argued in review, not added here quietly.
 */
const SINKS = new RegExp(
  [
    'dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document\\.write', 'new Function\\b', '\\beval\\s*\\(',
    // Added after the audit of 15 Nov (WW-10): other ways text becomes a page, code or a navigation.
    '\\.srcdoc\\b', '\\bsrc[dD]oc=', 'createContextualFragment', 'setAttribute\\(\\s*[\'"`]on', 'window\\.open\\b', '\\blocation\\s*=[^=]', 'location\\.(?:href\\s*=[^=]|assign|replace)\\b',
    'javascript:', 'set(?:Timeout|Interval)\\(\\s*[\'"`]', '<a\\b[^>]*\\bhref=\\{',
  ].join('|'),
)

const SRC = fileURLToPath(new URL('..', import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    // Tests carry attack payloads on purpose (the EPUB cleaner's tests); only the app's own code is scanned.
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\.[jt]sx?$/.test(name) && path !== THIS_FILE ? [path] : []
  })
}

describe('HTML and code sinks', () => {
  it('appear nowhere in web/src', () => {
    const files = sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(40)
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (SINKS.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line) ? [`${relative(SRC, file)}:${i + 1}: ${line.trim()}`] : [])),
    )
    expect(found).toEqual([])
  })

  it('recognises each kind of sink', () => {
    for (const line of [
      'el.innerHTML = x', 'frame.srcdoc = html', '<iframe srcDoc={x} />', 'range.createContextualFragment(x)', "el.setAttribute('onclick', x)",
      'window.open(url)', 'location = url', 'location.href = url', 'location.assign(url)', "a = 'javascript:x'", "setTimeout('run()', 1)", '<a className="x" href={url}>',
    ]) {
      expect(SINKS.test(line), line).toBe(true)
    }
    for (const line of ['if (location.href === x) {}', 'a.href = blobUrl', "FORBID_ATTR: ['srcdoc']", 'setTimeout(() => run(), 1)']) {
      expect(SINKS.test(line), line).toBe(false)
    }
  })
})

