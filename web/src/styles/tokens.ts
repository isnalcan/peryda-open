import tokens from '@shared/tokens.json'
import type { YarnColor } from '../ilmek/types'

type Theme = 'light' | 'dark'

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function yarnStroke(color: YarnColor, theme: Theme): string {
  return tokens.yarn[color][theme]
}

/** Highlight fill on the page. Pages are paper-coloured in both themes, so the light tone is used. */
export function yarnHighlight(color: YarnColor, alphaScale = 1): string {
  const [r, g, b] = hexToRgb(tokens.yarn[color].light)
  return `rgba(${r}, ${g}, ${b}, ${(tokens.yarn[color].highlightAlpha * alphaScale).toFixed(3)})`
}

function block(theme: Theme): string {
  const p = tokens.palette[theme]
  const lines = [
    `--paper: ${p.paper}`,
    `--paper-raised: ${p.paperRaised}`,
    `--paper-sunken: ${p.paperSunken}`,
    `--ink: ${p.ink}`,
    `--ink-soft: ${p.inkSoft}`,
    `--ink-faint: ${p.inkFaint}`,
    `--accent: ${p.accent}`,
    `--accent-strong: ${p.accentStrong}`,
    `--accent-tint: ${p.accentTint}`,
    `--line: ${p.line}`,
    `--line-strong: ${p.lineStrong}`,
    `--error-text: ${p.errorText}`,
    `--page-sheet: ${tokens.pageSheet[theme]}`,
  ]
  for (const color of Object.keys(tokens.yarn) as YarnColor[]) {
    lines.push(`--yarn-${color}: ${tokens.yarn[color][theme]}`)
    lines.push(`--yarn-${color}-tint: ${yarnHighlight(color)}`)
  }
  return lines.map((l) => `  ${l};`).join('\n')
}

/** CSS custom properties for both themes, generated from shared/tokens.json. */
export function tokensCss(): string {
  return [
    `:root {\n${block('light')}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${block('dark')}\n    color-scheme: dark;\n  }\n}`,
    `:root[data-theme='dark'] {\n${block('dark')}\n  color-scheme: dark;\n}`,
  ].join('\n')
}

export function installTokens(doc: Document = document): void {
  const id = 'peryda-tokens'
  let el = doc.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = doc.createElement('style')
    el.id = id
    doc.head.prepend(el)
  }
  el.textContent = tokensCss()
}

export const YARN_STROKE = tokens.yarnStroke
