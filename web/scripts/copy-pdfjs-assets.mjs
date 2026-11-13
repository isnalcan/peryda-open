// Copies the pdf.js data files the reader needs (character maps, standard fonts, colour profiles and
// image decoders) into public/pdfjs. PDF scripting (quickjs) is deliberately left out.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', 'pdfjs-dist')
const target = join(root, 'public', 'pdfjs')
if (existsSync(target)) rmSync(target, { recursive: true })
mkdirSync(target, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'iccs']) cpSync(join(source, dir), join(target, dir), { recursive: true })
mkdirSync(join(target, 'wasm'))
for (const file of readdirSync(join(source, 'wasm'))) {
  if (file.startsWith('quickjs')) continue
  cpSync(join(source, 'wasm', file), join(target, 'wasm', file))
}
console.log('pdf.js assets copied to public/pdfjs')
