import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Photos of pages (JPEG, PNG, HEIC, WebP, TIFF) become a PDF book, one page per photo (owner, 16 Nov).
/// Photos chosen together make one book, in file-name order; the reader then reads it like a scanned
/// PDF: areas, page pictures, "Extract text" and translation all work. The web engine follows the same
/// rules (web/src/library/imageBook.ts).
public enum ImageBook {
    public static let extensions: Set<String> = ["jpg", "jpeg", "png", "heic", "heif", "webp", "tif", "tiff"]

    public static func isImage(_ url: URL) -> Bool { extensions.contains(url.pathExtension.lowercased()) }

    /// The longest side a photo keeps, in pixels: sharp enough to read and to recognise its text, small
    /// enough to keep the book light.
    static let maxPixels = 3200
    /// The longest side of a page, in points (an A4 page's height).
    static let pageLongSide = 842.0
    static let quality = 0.88
    /// A photo larger than this (in pixels) is refused before it is decoded: a crafted file could
    /// otherwise ask for gigabytes of memory. Real cameras stay far below it.
    static let maxSourcePixels = 250_000_000

    /// The most photos one book is made of at a time (the web keeps the same limit).
    public static let maxPhotos = 500

    /// Photos in file-name order, as a person numbers them (IMG_2 before IMG_10).
    public static func ordered(_ urls: [URL]) -> [URL] {
        urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }

    /// The book's fingerprint, from the photos themselves: the same photos in the same order are the
    /// same book (the PDF made from them differs each time).
    public static func fingerprint(_ files: [Data]) -> String {
        LibraryStore.fingerprint(Data(files.map(LibraryStore.fingerprint).joined().utf8))
    }

    /// A PDF with one page per photo, the page's longest side 842 points; nil when a photo cannot be read.
    public static func pdf(from images: [Data]) -> Data? {
        let out = NSMutableData()
        guard !images.isEmpty, let consumer = CGDataConsumer(data: out as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: nil, nil) else { return nil }
        for data in images {
            guard let image = upright(data) else {
                ctx.closePDF()
                return nil
            }
            let w = Double(image.width), h = Double(image.height)
            let scale = pageLongSide / max(w, h)
            var box = CGRect(x: 0, y: 0, width: max(1, (w * scale).rounded()), height: max(1, (h * scale).rounded()))
            ctx.beginPage(mediaBox: &box)
            ctx.draw(image, in: box)
            ctx.endPage()
        }
        ctx.closePDF()
        return out as Data
    }

    /// The photo upright (as the camera saw it), at most `maxPixels` long, on white (no transparency),
    /// as a JPEG image, so the PDF holds the JPEG rather than raw pixels.
    static func upright(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pw = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let ph = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              pw > 0, ph > 0, case let (pixels, overflow) = pw.multipliedReportingOverflow(by: ph), !overflow, pixels <= maxSourcePixels
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let photo = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let w = photo.width, h = photo.height
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let bitmap = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                     bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        bitmap.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        bitmap.fill(CGRect(x: 0, y: 0, width: w, height: h))
        bitmap.draw(photo, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let flat = bitmap.makeImage() else { return nil }
        let jpeg = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(jpeg as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return flat }
        CGImageDestinationAddImage(dest, flat, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest), let src = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return flat }
        return image
    }
}
