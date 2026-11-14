// @vitest-environment node
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { ZIP_LIMITS, ZipLimitError, checkEpubArchive, endRecordEntryCount, openZip, readEntry } from './zipLimits'
import { findEpubCover, stripSections } from '../library/covers'

/** Rewrites the unpacked size an entry declares (local header and central directory), as a lying zip would. */
function lieAboutSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice()
  const view = new DataView(out.buffer)
  const nameBytes = new TextEncoder().encode(name)
  const matches = (at: number) => nameBytes.every((b, i) => out[at + i] === b)
  for (let i = 0; i + 46 < out.length; i += 1) {
    const sig = view.getUint32(i, true)
    if (sig === 0x04034b50 && view.getUint16(i + 26, true) === nameBytes.length && matches(i + 30)) view.setUint32(i + 22, size, true)
    if (sig === 0x02014b50 && view.getUint16(i + 28, true) === nameBytes.length && matches(i + 46)) view.setUint32(i + 24, size, true)
  }
  return out
}

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, data] of Object.entries(files)) zip.file(name, data)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

describe('zip limits', () => {
  it('refuses an entry whose declared size is over the limit without unpacking it', async () => {
    const zip = await openZip(await zipOf({ 'a.xhtml': 'x'.repeat(2000) }))
    await expect(readEntry(zip.file('a.xhtml')!, 1000)).rejects.toBeInstanceOf(ZipLimitError)
    expect((await readEntry(zip.file('a.xhtml')!, 2000)).size).toBe(2000)
  })

  it('stops unpacking an entry that lies about its size', async () => {
    const honest = await zipOf({ 'OEBPS/ch.xhtml': 'a'.repeat(3_000_000) })
    const lying = lieAboutSize(honest, 'OEBPS/ch.xhtml', 10)
    const zip = await openZip(lying)
    await expect(readEntry(zip.file('OEBPS/ch.xhtml')!, 1_000_000)).rejects.toBeInstanceOf(ZipLimitError)
    await expect(checkEpubArchive(lieAboutSize(await zipOf({ 'x.xhtml': 'a'.repeat(ZIP_LIMITS.text + 1) }), 'x.xhtml', 10))).rejects.toBeInstanceOf(ZipLimitError)
    // Real work (a large archive is made and unpacked): about 1 s alone, longer when the machine is busy
    // with the whole suite in parallel (audit 15 Nov, WR-4).
  }, 20_000)

  it('reads the entry count from the end record and refuses a zip with too many entries before parsing it', async () => {
    expect(endRecordEntryCount(await zipOf({ a: '1', b: '2', c: '3' }))).toBe(3)
    const fake = new Uint8Array(22)
    new DataView(fake.buffer).setUint32(0, 0x06054b50, true)
    new DataView(fake.buffer).setUint16(10, ZIP_LIMITS.entries + 1, true)
    await expect(openZip(fake)).rejects.toBeInstanceOf(ZipLimitError)
    new DataView(fake.buffer).setUint16(10, 0xffff, true)
    expect(endRecordEntryCount(fake)).toBe(Number.POSITIVE_INFINITY)
    expect(endRecordEntryCount(new Uint8Array(10))).toBeNull()
  })

  it('accepts an ordinary book', async () => {
    await expect(checkEpubArchive(await zipOf({ mimetype: 'application/epub+zip', 'OEBPS/a.xhtml': '<html/>', 'OEBPS/b.jpg': new Uint8Array(5000) }))).resolves.toBeUndefined()
  })

  it('a cover that lies about its size is skipped, not unpacked to the end', async () => {
    const container = '<container><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
    const opf = '<package><manifest><item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest></package>'
    const big = new Uint8Array(ZIP_LIMITS.cover + 1)
    const honest = await zipOf({ 'META-INF/container.xml': container, 'c.opf': opf, 'cover.jpg': big })
    expect(await findEpubCover(honest)).toBeNull()
    expect(await findEpubCover(lieAboutSize(honest, 'cover.jpg', 100))).toBeNull()
    // Real work (a large archive is made and unpacked): about 1 s alone, longer when the machine is busy
    // with the whole suite in parallel (audit 15 Nov, WR-4).
  }, 20_000)
})

describe('package file scanning', () => {
  it('strips comments in one pass, also when they never close', () => {
    expect(stripSections('a<!--x-->b<!--y-->c', '<!--', '-->')).toBe('abc')
    expect(stripSections('a<!--never closed', '<!--', '-->')).toBe('a')
    const hostile = '<!--'.repeat(500_000)
    const started = Date.now()
    expect(stripSections(hostile, '<!--', '-->')).toBe('')
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
