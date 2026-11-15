/**
 * Photos of pages (JPEG, PNG, WebP; HEIC where the browser can decode it) become a PDF book: one page per
 * picture, each drawn on white at most 3200 pixels on its longer side and kept as a JPEG. The PDF is
 * written here (no PDF library): a page per picture, its longer side 842 points (an A4 page's height).
 * Same rules as the Mac app.
 */

/** The longer side a picture is drawn at, at most (pixels): sharp enough to read and to OCR. */
export const MAX_IMAGE_SIDE = 3200
/** JPEG quality of the pictures kept in the PDF. */
export const IMAGE_JPEG_QUALITY = 0.88
/** A page's longer side in points. */
export const IMAGE_PAGE_SIDE = 842

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])

export function isImageFile(file: { name: string; type: string }): boolean {
  return IMAGE_TYPES.has(file.type) || IMAGE_EXTENSIONS.test(file.name)
}

export function isHeic(file: { name: string; type: string }): boolean {
  return /^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name)
}

/** Several photos chosen together: in their names' natural order (IMG_2 before IMG_10). */
export function naturalOrder<T extends { name: string }>(files: readonly T[]): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...files].sort((a, b) => collator.compare(a.name, b.name))
}

export interface PdfPicture {
  /** Baseline JPEG data (three components). */
  jpeg: Uint8Array
  /** Size in pixels. */
  width: number
  height: number
}

/** A page's size in points: the longer side IMAGE_PAGE_SIDE, the picture's proportions. */
export function pageSizeFor(width: number, height: number): { width: number; height: number } {
  const k = IMAGE_PAGE_SIDE / Math.max(width, height)
  const round = (v: number) => Math.round(v * 100) / 100
  return { width: round(width * k), height: round(height * k) }
}

/** The size a picture is drawn at: at most MAX_IMAGE_SIDE on its longer side, never enlarged. */
export function drawnSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** A PDF with one page per picture, each filling its page. */
export function picturesToPdf(pictures: readonly PdfPicture[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let length = 0
  const offsets: number[] = []
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes)
    length += bytes.length
  }
  const text = (s: string) => push(encoder.encode(s))
  const object = (id: number, body: string) => {
    offsets[id] = length
    text(`${id} 0 obj\n${body}\nendobj\n`)
  }

  // Header, with a comment of high bytes so tools treat the file as binary.
  text('%PDF-1.4\n')
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  const pageIds = pictures.map((_, i) => 3 + i * 3)
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pictures.length} >>`)
  pictures.forEach((picture, i) => {
    const pageId = 3 + i * 3
    const contentId = pageId + 1
    const imageId = pageId + 2
    const size = pageSizeFor(picture.width, picture.height)
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)
    const content = `q ${size.width} 0 0 ${size.height} 0 0 cm /Im0 Do Q`
    object(contentId, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`)
    offsets[imageId] = length
    text(
      `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${picture.jpeg.length} >>\nstream\n`,
    )
    push(picture.jpeg)
    text('\nendstream\nendobj\n')
  })

  const count = 3 + pictures.length * 3
  const xref = length
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let id = 1; id < count; id += 1) table += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`
  text(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** The browser could not decode this picture (a HEIC photo outside Safari, or a damaged file). */
export class PictureDecodeError extends Error {}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // The photo's own orientation (EXIF) is applied, as the camera meant it.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      /* some browsers decode a format only through <img> (Safari and HEIC) */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    if (!img.naturalWidth || !img.naturalHeight) throw new PictureDecodeError('empty')
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    throw new PictureDecodeError('undecodable')
  }
}

/** Decodes a photo and draws it on white as a JPEG at most MAX_IMAGE_SIDE on its longer side. */
export async function pictureFromFile(file: Blob): Promise<PdfPicture> {
  const image = await decode(file)
  try {
    const size = drawnSize(image.width, image.height)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PictureDecodeError('no canvas')
    // A transparent PNG would turn black in a JPEG: it is drawn on white.
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.drawImage(image.source, 0, 0, size.width, size.height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new PictureDecodeError('encode failed'))), 'image/jpeg', IMAGE_JPEG_QUALITY),
    )
    canvas.width = 0
    canvas.height = 0
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height }
  } finally {
    image.close()
  }
}
