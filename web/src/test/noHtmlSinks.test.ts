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
const SINKS = /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function\b|\beval\s*\(/

const SRC = fileURLToPath(new URL('..', import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) && path !== THIS_FILE ? [path] : []
  })
}

describe('HTML and code sinks', () => {
  it('appear nowhere in web/src', () => {
    const files = sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(50)
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (SINKS.test(line) ? [`${relative(SRC, file)}:${i + 1}: ${line.trim()}`] : [])),
    )
    expect(found).toEqual([])
  })
})
