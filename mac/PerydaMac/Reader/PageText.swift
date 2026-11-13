import AppKit
import PDFKit
import PerydaKit
import Vision

/// A page's text for translation and for "extract page text": the PDF's own text layer, or, for a
/// scanned page, text read from the page's picture on this Mac with Apple Vision (nothing leaves the
/// Mac for this step).
enum PageText {
    struct Result: Sendable {
        var text: String
        /// Read from the picture rather than the PDF's text layer.
        var recognized: Bool
    }

    @MainActor static func read(_ geometry: PageGeometry, lang: Lang) async -> Result {
        let own = clean(geometry.page.string ?? "")
        if !geometry.isTextless, own.count >= 40 { return Result(text: own, recognized: false) }
        guard let image = geometry.render(longSide: 2400) else { return Result(text: own, recognized: false) }
        let read = await recognize(image, lang: lang)
        return read.count > own.count ? Result(text: read, recognized: true) : Result(text: own, recognized: false)
    }

    /// Hyphens a word may be broken at the end of a line with: "-", "‐" (U+2010, which PDFKit reports
    /// for many fonts) and the soft hyphen (U+00AD).
    static let lineEndHyphens: Set<Unicode.Scalar> = ["-", "\u{2010}", "\u{AD}"]

    /// Soft-wrapped PDF lines joined into paragraphs; hyphenated line ends rejoined.
    static func clean(_ raw: String) -> String {
        let lines = raw.replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        var paragraphs: [String] = []
        var current = ""
        for line in lines {
            if line.isEmpty {
                if !current.isEmpty { paragraphs.append(current); current = "" }
                continue
            }
            if current.isEmpty {
                current = line
            } else if let last = current.unicodeScalars.last, lineEndHyphens.contains(last), let first = line.first, first.isLowercase {
                current.unicodeScalars.removeLast()
                current += line
            } else {
                current += " " + line
            }
        }
        if !current.isEmpty { paragraphs.append(current) }
        return paragraphs.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Apple Vision, accurate level with language correction, in the reader's language first.
    static func recognize(_ image: CGImage, lang: Lang) async -> String {
        await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let wanted = [lang.rawValue, "tr", "en", "de", "es"].map { code -> String in
                switch code {
                case "tr": "tr-TR"
                case "de": "de-DE"
                case "es": "es-ES"
                default: "en-US"
                }
            }
            let supported = (try? request.supportedRecognitionLanguages()) ?? []
            var languages: [String] = []
            for code in wanted where supported.contains(code) && !languages.contains(code) { languages.append(code) }
            if !languages.isEmpty { request.recognitionLanguages = languages }
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            guard (try? handler.perform([request])) != nil, let results = request.results else { return "" }
            return lines(from: results)
        }.value
    }

    /// Lines top to bottom; a gap clearly taller than a line starts a new paragraph.
    static func lines(from observations: [VNRecognizedTextObservation]) -> String {
        let sorted = observations.sorted { a, b in
            abs(a.boundingBox.midY - b.boundingBox.midY) > min(a.boundingBox.height, b.boundingBox.height) * 0.5
                ? a.boundingBox.midY > b.boundingBox.midY
                : a.boundingBox.minX < b.boundingBox.minX
        }
        let heights = sorted.map(\.boundingBox.height).sorted()
        let lineHeight = heights.isEmpty ? 0 : heights[heights.count / 2]
        var out = ""
        var previous: CGRect?
        for o in sorted {
            guard let text = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces), !text.isEmpty else { continue }
            if let p = previous {
                let gap = p.minY - o.boundingBox.maxY
                out += gap > lineHeight * 0.9 ? "\n\n" : (abs(p.midY - o.boundingBox.midY) < lineHeight * 0.5 ? " " : "\n")
            }
            out += text
            previous = o.boundingBox
        }
        return clean(out)
    }
}

extension PageGeometry {
    /// The whole page as a picture, `longSide` pixels on its longer side, on white.
    func render(longSide: CGFloat) -> CGImage? {
        let bounds = page.bounds(for: box)
        let rotated = page.rotation % 180 != 0
        let size = rotated ? CGSize(width: bounds.height, height: bounds.width) : bounds.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = longSide / max(size.width, size.height)
        let pixels = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        guard let ctx = CGContext(data: nil, width: Int(pixels.width), height: Int(pixels.height), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(CGRect(origin: .zero, size: pixels))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: box, to: ctx)
        return ctx.makeImage()
    }

    /// The whole page at `scale` times its size in points, as a JPEG data URL (pages without a text
    /// layer are sent this way for the model to read and translate).
    func jpegDataURL(scale: CGFloat, quality: CGFloat) -> String? {
        let bounds = page.bounds(for: box)
        let long = max(bounds.width, bounds.height) * scale
        guard let image = render(longSide: long),
              let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }

    /// The whole page as a PNG data URL, for sending when no text could be read at all.
    func pageImageDataURL() -> String? {
        guard let image = render(longSide: 1600), let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }
}
