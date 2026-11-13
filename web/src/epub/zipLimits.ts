import JSZip from 'jszip'

/**
 * Limits for unpacking an EPUB (a zip). A small file can unpack to gigabytes (a "zip bomb") and take the
 * tab down, so every entry is checked against the size the zip declares before anything is unpacked, and
 * counted again while it is unpacked, because the declared size can lie.
 */
export const ZIP_LIMITS = {
  /** Entries (files and folders) in one book. */
  entries: 10_000,
  /** Everything in the book, unpacked. */
  total: 1_000_000_000,
  /** One chapter, stylesheet or other text entry, unpacked. */
  text: 50_000_000,
  /** The cover picture, unpacked. */
  cover: 20_000_000,
} as const

export class ZipLimitError extends Error {}

/** Entries epub.js reads and parses as text; pictures, fonts and media are bounded by the total only. */
const TEXT_ENTRY = /\.(x?html?|xml|opf|ncx|css|svg|smil|txt|js)$/i

export function entryLimit(name: string): number {
  return TEXT_ENTRY.test(name) ? ZIP_LIMITS.text : ZIP_LIMITS.total
}

/** The unpacked size the zip's directory declares for an entry (JSZip keeps it on an internal field). */
export function declaredSize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null
}

/**
 * The entry count from the zip's end record, read without parsing the zip. Returns Infinity for a ZIP64
 * archive (more than 65,535 entries or over 4 GB, never needed by a book) and null when there is no end
 * record (JSZip then refuses the file itself).
 */
export function endRecordEntryCount(bytes: Uint8Array): number | null {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= lowest; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      const count = bytes[i + 10]! | (bytes[i + 11]! << 8)
      return count === 0xffff ? Number.POSITIVE_INFINITY : count
    }
  }
  return null
}

interface EntryStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): EntryStream
  on(event: 'error', listener: (error: unknown) => void): EntryStream
  on(event: 'end', listener: () => void): EntryStream
  resume(): EntryStream
  pause(): EntryStream
}

function streamOf(entry: JSZip.JSZipObject): EntryStream {
  return (entry as unknown as { internalStream(type: 'uint8array'): EntryStream }).internalStream('uint8array')
}

/**
 * Unpacks one entry and stops as soon as it grows past `limit`. With `keep` false the bytes are only
 * counted (checking a whole book at import). Resolves with the bytes (or an empty array) and their count.
 */
export function readEntry(entry: JSZip.JSZipObject, limit: number, keep = true): Promise<{ bytes: Uint8Array<ArrayBuffer>; size: number }> {
  const declared = declaredSize(entry)
  if (declared !== null && declared > limit) return Promise.reject(new ZipLimitError(`${entry.name} is too large`))
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    let settled = false
    const stream = streamOf(entry)
    stream.on('data', (chunk) => {
      if (settled) return
      size += chunk.byteLength
      if (size > limit) {
        settled = true
        stream.pause()
        reject(new ZipLimitError(`${entry.name} is too large`))
        return
      }
      if (keep) chunks.push(chunk)
    })
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      if (!keep) return resolve({ bytes: new Uint8Array(0), size })
      const bytes = new Uint8Array(size)
      let at = 0
      for (const c of chunks) {
        bytes.set(c, at)
        at += c.byteLength
      }
      resolve({ bytes, size })
    })
    stream.resume()
  })
}

/** Reads a small text entry (container, package file) as UTF-8, within `limit` bytes. */
export async function readText(entry: JSZip.JSZipObject, limit: number): Promise<string> {
  const { bytes } = await readEntry(entry, limit)
  return new TextDecoder('utf-8').decode(bytes)
}

/** Opens a zip after a cheap look at its entry count, so a file with millions of entries is not parsed. */
export async function openZip(data: ArrayBuffer | Uint8Array): Promise<JSZip> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const count = endRecordEntryCount(bytes)
  if (count !== null && count > ZIP_LIMITS.entries) throw new ZipLimitError('too many entries')
  const zip = await JSZip.loadAsync(bytes)
  if (Object.keys(zip.files).length > ZIP_LIMITS.entries) throw new ZipLimitError('too many entries')
  return zip
}

/**
 * Checks a whole EPUB before it enters the library: the entry count, every declared size, and then each
 * entry unpacked once and counted. Throws ZipLimitError for a book over the limits; any other error means
 * the file is not a readable zip.
 */
export async function checkEpubArchive(data: ArrayBuffer | Uint8Array): Promise<void> {
  const zip = await openZip(data)
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  // Declared sizes first: a bomb that admits its size is refused without unpacking anything.
  let declaredTotal = 0
  for (const entry of entries) {
    const size = declaredSize(entry) ?? 0
    if (size > entryLimit(entry.name)) throw new ZipLimitError(`${entry.name} is too large`)
    declaredTotal += size
  }
  if (declaredTotal > ZIP_LIMITS.total) throw new ZipLimitError('book too large')
  let total = 0
  for (const entry of entries) {
    const { size } = await readEntry(entry, Math.min(entryLimit(entry.name), ZIP_LIMITS.total - total), false)
    total += size
  }
}
