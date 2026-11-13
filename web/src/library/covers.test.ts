// @vitest-environment node
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { coverFit, findEpubCover, resolveZipPath } from './covers'

const CONTAINER = (opfPath: string) =>
  `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

async function epub(opfPath: string, opf: string, files: Record<string, Uint8Array | string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', CONTAINER(opfPath))
  zip.file(opfPath, opf)
  for (const [path, data] of Object.entries(files)) zip.file(path, data)
  return zip.generateAsync({ type: 'arraybuffer' })
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6])

describe('coverFit', () => {
  it('fills the frame when the picture is close to 3:4', () => {
    expect(coverFit(300, 400)).toBe('fill')
    expect(coverFit(595, 842)).toBe('fill') // A4
    expect(coverFit(612, 792)).toBe('fill') // US Letter
  })

  it('fills right up to 20% either way, and letterboxes beyond', () => {
    expect(coverFit(600, 1000)).toBe('fill') // ratio 0.8
    expect(coverFit(937.5, 1000)).toBe('fill') // ratio 1.25
    expect(coverFit(590, 1000)).toBe('letterbox')
    expect(coverFit(950, 1000)).toBe('letterbox')
  })

  it('letterboxes wide scans, squares and tall strips', () => {
    expect(coverFit(1190, 842)).toBe('letterbox') // two-page spread
    expect(coverFit(500, 500)).toBe('letterbox')
    expect(coverFit(100, 2000)).toBe('letterbox')
  })

  it('treats missing or broken sizes as letterbox', () => {
    expect(coverFit(0, 400)).toBe('letterbox')
    expect(coverFit(300, 0)).toBe('letterbox')
    expect(coverFit(-3, 4)).toBe('letterbox')
    expect(coverFit(Number.NaN, 400)).toBe('letterbox')
    expect(coverFit(Number.POSITIVE_INFINITY, 400)).toBe('letterbox')
  })
})

describe('resolveZipPath', () => {
  it('resolves against the package folder', () => {
    expect(resolveZipPath('OEBPS', 'images/cover.jpg')).toBe('OEBPS/images/cover.jpg')
    expect(resolveZipPath('', 'cover.jpg')).toBe('cover.jpg')
  })

  it('walks ../ and ./ by hand', () => {
    expect(resolveZipPath('OPS/package', '../images/cover.png')).toBe('OPS/images/cover.png')
    expect(resolveZipPath('OEBPS', './img/../img/c.jpg')).toBe('OEBPS/img/c.jpg')
    expect(resolveZipPath('a/b/c', '../../x.jpg')).toBe('a/x.jpg')
  })

  it('refuses a path that climbs out of the book', () => {
    expect(resolveZipPath('', '../cover.jpg')).toBeNull()
    expect(resolveZipPath('OEBPS', '../../cover.jpg')).toBeNull()
  })

  it('decodes percent-escapes and drops fragments', () => {
    expect(resolveZipPath('OEBPS', 'my%20cover.jpg#x')).toBe('OEBPS/my cover.jpg')
    expect(resolveZipPath('OEBPS', 'my%20cover.jpg', false)).toBe('OEBPS/my%20cover.jpg')
    expect(resolveZipPath('OEBPS', 'bad%zzname.jpg')).toBe('OEBPS/bad%zzname.jpg')
  })

  it('reads a leading slash as the root of the book', () => {
    expect(resolveZipPath('OEBPS', '/images/cover.jpg')).toBe('images/cover.jpg')
  })
})

describe('findEpubCover', () => {
  it('finds an EPUB 3 cover-image item', async () => {
    const data = await epub(
      'OEBPS/content.opf',
      `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Üç</dc:title><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cov" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="other" href="images/other.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine><itemref idref="nav"/></spine>
</package>`,
      { 'OEBPS/images/cover.jpg': JPEG, 'OEBPS/images/other.jpg': PNG },
    )
    const cover = await findEpubCover(data)
    expect(cover?.path).toBe('OEBPS/images/cover.jpg')
    expect(cover?.mediaType).toBe('image/jpeg')
    expect([...(cover?.bytes ?? [])]).toEqual([...JPEG])
  })

  it('finds an EPUB 2 meta cover with a ../ href, prefixed tags and an escaped name', async () => {
    const data = await epub(
      'OPS/package/content.opf',
      `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="2.0">
  <opf:metadata>
    <!-- <opf:item id="decoy" href="../images/wrong.png" properties="cover-image"/> -->
    <opf:meta name="cover" content="cover-img"/>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ch1" href="../text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <opf:item href="../images/Cover%20Art.png" id="cover-img" media-type="image/png"/>
  </opf:manifest>
  <opf:spine><opf:itemref idref="cover-img"/><opf:itemref idref="ch1"/></opf:spine>
</opf:package>`,
      { 'OPS/images/Cover Art.png': PNG, 'OPS/images/wrong.png': JPEG, 'OPS/text/ch1.xhtml': '<html/>' },
    )
    const cover = await findEpubCover(data)
    expect(cover?.path).toBe('OPS/images/Cover Art.png')
    expect(cover?.mediaType).toBe('image/png')
    expect([...(cover?.bytes ?? [])]).toEqual([...PNG])
  })

  it('prefers the EPUB 3 marker when both are present, and decodes &amp; in hrefs', async () => {
    const data = await epub(
      'content.opf',
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata><meta name="cover" content="old"/></metadata>
  <manifest>
    <item id="old" href="old.jpg" media-type="image/jpeg"/>
    <item id="new" href="art/a&amp;b.jpg" media-type="image/jpeg" properties="svg cover-image"/>
  </manifest>
</package>`,
      { 'old.jpg': PNG, 'art/a&b.jpg': JPEG },
    )
    expect((await findEpubCover(data))?.path).toBe('art/a&b.jpg')
  })

  it('returns null when the book names no cover, or the picture is missing or outside the book', async () => {
    const opf = (manifest: string, meta = '') =>
      `<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata>${meta}</metadata><manifest>${manifest}</manifest></package>`
    const none = await epub('OEBPS/content.opf', opf('<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>'), {})
    expect(await findEpubCover(none)).toBeNull()

    const missing = await epub('OEBPS/content.opf', opf('<item id="c" href="nope.jpg" media-type="image/jpeg" properties="cover-image"/>'), {})
    expect(await findEpubCover(missing)).toBeNull()

    const outside = await epub('content.opf', opf('<item id="c" href="../c.jpg" media-type="image/jpeg"/>', '<meta name="cover" content="c"/>'), {
      'c.jpg': JPEG,
    })
    expect(await findEpubCover(outside)).toBeNull()

    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    expect(await findEpubCover(await zip.generateAsync({ type: 'arraybuffer' }))).toBeNull()
  })

  it('rejects a file that is not a zip', async () => {
    await expect(findEpubCover(new TextEncoder().encode('not a zip'))).rejects.toThrow()
  })
})
