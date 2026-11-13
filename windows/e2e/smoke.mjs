// Windows smoke test: drives the installed Peryda app through WebView2's DevTools port and saves a
// screenshot after every step, so the app can be checked on real Windows without a person at the
// machine. No AI key is used: steps that need one must show the "add a key" message.
//
//   node windows/e2e/smoke.mjs <path to installed Peryda exe>
//
// Writes windows/e2e/out/NN-step.png and windows/e2e/out/report.json. The app given here is a test
// build whose WebView2 DevTools port is open (e2e/tauri.test.json); the installer never opens it.
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
const fixtures = join(here, 'fixtures')
mkdirSync(out, { recursive: true })
const exe = process.argv[2]
if (!exe || !existsSync(exe)) throw new Error(`app not found: ${exe}`)

const PORT = 9222
const report = { exe: basename(exe), steps: [] }
let shot = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch() {
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  })
  child.unref()
}

function quit() {
  try {
    execSync(`taskkill /IM "${basename(exe)}" /F`, { stdio: 'ignore' })
  } catch {
    /* not running */
  }
}

async function connect() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  for (let i = 0; i < 30; i += 1) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'))
    if (page) {
      await page.waitForLoadState('domcontentloaded')
      return { browser, page }
    }
    await sleep(500)
  }
  throw new Error('no app page over DevTools')
}

async function step(page, name, fn) {
  const started = Date.now()
  const entry = { name, ok: true }
  try {
    entry.detail = (await fn()) ?? undefined
  } catch (error) {
    entry.ok = false
    entry.error = String(error?.message ?? error).slice(0, 500)
  }
  shot += 1
  const file = `${String(shot).padStart(2, '0')}-${name}.png`
  try {
    await page.screenshot({ path: join(out, file) })
    entry.screenshot = file
  } catch (error) {
    entry.screenshotError = String(error?.message ?? error).slice(0, 200)
  }
  entry.ms = Date.now() - started
  report.steps.push(entry)
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${name}${entry.error ? ` — ${entry.error}` : ''}`)
}

/** Selects a run of words in the first page's text layer and lets the reader read the selection. */
async function selectOnPage(page) {
  await page.waitForSelector('.pdf-page[data-page="1"] .textLayer span', { timeout: 20000 })
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].filter((s) => s.textContent.trim().length > 3)
    const r = document.createRange()
    r.setStart(spans[1].firstChild, 0)
    r.setEnd(spans[2].firstChild, spans[2].textContent.length)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
    document.querySelector('.reader-viewport').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
  await page.waitForSelector('.selection-menu', { timeout: 5000 })
}

quit()
launch()
let { browser, page } = await connect()
await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)

await step(page, 'first-launch', async () => {
  await page.waitForSelector('.library', { timeout: 30000 })
  return { title: await page.title(), lang: await page.evaluate(() => document.documentElement.lang), secure: await page.evaluate(() => isSecureContext) }
})

await step(page, 'welcome-dismissed', async () => {
  const later = page.locator('dialog[open] .welcome-actions button').first()
  if (await later.count()) await later.click()
  await page.waitForSelector('dialog[open]', { state: 'detached', timeout: 5000 }).catch(() => undefined)
})

await step(page, 'settings-four-providers', async () => {
  await page.locator('.library-actions .icon-button').last().click()
  await page.waitForSelector('.settings-dialog[open]', { timeout: 5000 })
  const legends = await page.locator('.settings-dialog legend').allTextContents()
  if (legends.length !== 4) throw new Error(`providers shown: ${legends.length}`)
  return legends
})

await step(page, 'settings-closed', async () => {
  await page.keyboard.press('Escape')
  await page.waitForSelector('.settings-dialog[open]', { state: 'detached', timeout: 5000 })
})

await step(page, 'import-pdf', async () => {
  await page.setInputFiles('input[type=file]', join(fixtures, 'sample.pdf'))
  await page.waitForSelector('.reader-viewport .pdf-page canvas.is-ready', { timeout: 30000 })
  return { pages: await page.locator('.page-number').textContent() }
})

await step(page, 'selection-menu', async () => {
  await selectOnPage(page)
  return await page.locator('.selection-menu .menu-quick').allTextContents()
})

await step(page, 'thread-without-key', async () => {
  await page.locator('.selection-menu .menu-quick').first().click()
  await page.waitForSelector('.yarn-card .yarn-error', { timeout: 10000 })
  return await page.locator('.yarn-card .yarn-error p').first().textContent()
})

await step(page, 'card-resized', async () => {
  const grip = page.locator('.yarn-card-grip').first()
  const box = await grip.boundingBox()
  await page.mouse.move(box.x + 6, box.y + 6)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 160, { steps: 8 })
  await page.mouse.up()
  return await page.locator('.yarn-card').first().evaluate((el) => [el.style.width, el.style.height])
})

await step(page, 'page-by-page', async () => {
  await page.locator('.page-nav [role=radio]').nth(1).click()
  await page.locator('.page-nav .icon-button').nth(1).click()
  await sleep(400)
  return { label: await page.locator('.page-number').textContent(), pagesDrawn: await page.locator('.pdf-page').count() }
})

await step(page, 'translate-page-without-key', async () => {
  await page.locator('.split-main').click()
  await page.waitForSelector('.translated-page .translated-page-error', { timeout: 15000 })
  return await page.locator('.translated-page-error p').first().textContent()
})

await step(page, 'extract-text', async () => {
  await page.locator('.split-more').click()
  await page.locator('.split-button .menu button').last().click()
  await page.waitForSelector('.extract-dialog .extract-text', { timeout: 10000 })
  const text = await page.locator('.extract-dialog .extract-text').textContent()
  return text.slice(0, 80)
})

await step(page, 'extract-closed', async () => {
  await page.keyboard.press('Escape')
  await page.waitForSelector('.extract-dialog[open]', { state: 'detached', timeout: 5000 })
})

await step(page, 'journal-note', async () => {
  await page.locator('.reader-topbar .icon-button[aria-pressed]').nth(1).click()
  const box = page.locator('.journal-panel textarea').first()
  await box.fill('Windows deneme notu')
  await box.press('Enter')
  await page.waitForSelector('.journal-entry', { timeout: 5000 })
  return await page.locator('.journal-entry').count()
})

await step(page, 'library-with-cover', async () => {
  await page.locator('.reader-topbar .ghost-button').first().click()
  await page.waitForSelector('.library .book-tile', { timeout: 10000 })
  await sleep(2500)
  return await page.locator('.library .book-tile').allInnerTexts()
})

await step(page, 'import-epub', async () => {
  await page.setInputFiles('input[type=file]', join(fixtures, 'sample.epub'))
  await page.waitForSelector('.epub-host iframe', { timeout: 30000 })
  await sleep(2500)
  const frame = page.frameLocator('.epub-host iframe').first()
  return (await frame.locator('body').innerText()).slice(0, 80)
})

await step(page, 'backup-export', async () => {
  await page.locator('.reader-topbar .ghost-button').first().click()
  await page.waitForSelector('.library', { timeout: 10000 })
  await page.locator('.library-actions .icon-button').last().click()
  await page.waitForSelector('.settings-dialog[open]', { timeout: 5000 })
  // With the test attached over DevTools, the browser hands downloads to the test instead of the
  // Downloads folder, so the download is caught here.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('.dialog-backup .ghost-button').first().click(),
  ])
  const path = await download.path()
  const message = await page.locator('.backup-message').textContent().catch(() => null)
  return { file: download.suggestedFilename(), bytes: statSync(path).size, message }
})

// Quit and open again: books, threads and the reading place must still be there.
await browser.close().catch(() => undefined)
quit()
await sleep(2000)
launch()
;({ browser, page } = await connect())
await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined)

await step(page, 'after-restart', async () => {
  await page.waitForSelector('.library, .reader-shell', { timeout: 30000 })
  if (await page.locator('.reader-topbar .ghost-button').count()) {
    await page.locator('.reader-topbar .ghost-button').first().click()
    await page.waitForSelector('.library', { timeout: 10000 })
  }
  const books = await page.locator('.library .book-tile').count()
  if (books !== 2) throw new Error(`books after restart: ${books}`)
  return { books }
})

await step(page, 'reopen-pdf-keeps-threads', async () => {
  await page.locator('.library .book-tile', { hasText: 'sample' }).first().locator('.book-open').click()
  await page.waitForSelector('.reader-viewport', { timeout: 20000 })
  await sleep(1500)
  return { cards: await page.locator('.yarn-card').count(), translations: await page.locator('.translated-page').count(), page: await page.locator('.page-number').textContent() }
})

await browser.close().catch(() => undefined)
quit()
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
const failed = report.steps.filter((s) => !s.ok)
console.log(`\n${report.steps.length - failed.length}/${report.steps.length} steps passed`)
process.exit(failed.length ? 1 : 0)
