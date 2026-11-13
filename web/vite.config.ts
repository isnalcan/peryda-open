import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import license from 'rollup-plugin-license'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Content Security Policy for the built app: only our own files, and network access only to the two
 * AI providers the reader chooses. Added at build time so the development server keeps working.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' https://generativelanguage.googleapis.com https://api.openai.com https://api.deepseek.com https://api.anthropic.com",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "child-src 'self' blob:",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

/** The policy goes right after this tag in index.html. */
const CSP_MARKER = '<meta charset="UTF-8" />'

function contentSecurityPolicy(): Plugin {
  return {
    name: 'peryda-csp',
    apply: 'build',
    transformIndexHtml(html) {
      // A reformatted index.html must stop the build, never ship a page without its policy.
      if (html.split(CSP_MARKER).length !== 2) throw new Error(`peryda-csp: index.html must contain ${CSP_MARKER} exactly once`)
      const out = html.replace(CSP_MARKER, `${CSP_MARKER}\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
      if (!out.includes('http-equiv="Content-Security-Policy"')) throw new Error('peryda-csp: the policy was not added')
      return out
    },
  }
}

/**
 * Packages that reach the bundle inside another package's prebuilt file (jszip's browser build carries
 * pako, lie, immediate and setimmediate), so the licence plugin cannot see them as modules.
 */
const PREBUILT_INSIDE = ['pako', 'lie', 'immediate', 'setimmediate']

function prebuiltNotice(name: string): string | null {
  const dir = fileURLToPath(new URL(`./node_modules/${name}/`, import.meta.url))
  if (!existsSync(dir)) return null
  const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8')) as { version?: string; license?: string }
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f))
  const text = file ? readFileSync(`${dir}${file}`, 'utf8').trim() : ''
  return [`Name: ${name}`, `Version: ${pkg.version ?? ''}`, `License: ${pkg.license ?? ''}`, '(inside jszip\'s browser build)', 'License Text:', '===', '', text].join('\n')
}

/** Licence texts and notices of every npm package in the bundle, shipped as dist/THIRD_PARTY_NOTICES.txt. */
function thirdPartyNotices() {
  return {
    ...license({
      thirdParty: {
        includePrivate: false,
        output: {
          file: fileURLToPath(new URL('./dist/THIRD_PARTY_NOTICES.txt', import.meta.url)),
          template: (dependencies) =>
            [
              [
                'Peryda (web and Windows) includes the following open-source packages, each listed with its',
                'licence and, where it has one, its NOTICE file. jszip is used under its MIT licence. The fonts',
                '(fonts/OFL.txt) and the pdf.js data files (pdfjs/) carry their own licence files.',
              ].join('\n'),
              ...dependencies
                .slice()
                .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
                .map((d) => d.text()),
              ...PREBUILT_INSIDE.map(prebuiltNotice).filter((t): t is string => t !== null),
            ].join('\n\n---\n\n'),
        },
      },
    }),
    apply: 'build' as const,
  }
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy(), thirdPartyNotices()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: { fs: { allow: ['..'] } },
  // Maps are written for debugging but not referenced from the shipped files.
  build: { target: 'es2022', sourcemap: 'hidden' },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
})
