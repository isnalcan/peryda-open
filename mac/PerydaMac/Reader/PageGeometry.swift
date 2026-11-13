import AppKit
import PDFKit
import PerydaKit

/// Maps between a PDF page's own space (bottom-left origin, points, unrotated) and a page view drawn in
/// world units (top-left origin, rotation applied). Normalized rectangles are relative to the displayed page.
struct PageGeometry {
    let page: PDFPage
    let box: PDFDisplayBox = .cropBox

    /// page space → display space (rotation applied, origin at the displayed page's bottom-left)
    var toDisplay: CGAffineTransform { page.transform(for: box) }

    var displaySize: CGSize {
        let b = page.bounds(for: box)
        let rotated = page.rotation % 180 != 0
        return rotated ? CGSize(width: b.height, height: b.width) : b.size
    }

    func displayRect(fromPage rect: CGRect) -> CGRect {
        rect.applying(toDisplay).standardized
    }

    func normalized(fromPage rect: CGRect) -> NormalizedRect {
        let d = displayRect(fromPage: rect)
        let s = displaySize
        return NormalizedRect(x: d.minX / s.width, y: (s.height - d.maxY) / s.height, width: d.width / s.width, height: d.height / s.height)
    }

    /// Point in a page view of the given size (top-left origin) → page space.
    func pagePoint(fromView p: CGPoint, viewSize: CGSize) -> CGPoint {
        let s = displaySize
        let display = CGPoint(x: p.x * s.width / viewSize.width, y: s.height - p.y * s.height / viewSize.height)
        return display.applying(toDisplay.inverted())
    }

    /// Normalized rectangle → page space (for cropping and text lookup).
    func pageRect(fromNormalized n: NormalizedRect) -> CGRect {
        let s = displaySize
        let display = CGRect(x: n.x * s.width, y: (1 - n.y - n.height) * s.height, width: n.width * s.width, height: n.height * s.height)
        return display.applying(toDisplay.inverted()).standardized
    }

    /// Draws the page into a context whose origin is the top-left of a view of `size`.
    func draw(in ctx: CGContext, size: CGSize) {
        let s = displaySize
        ctx.saveGState()
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))
        ctx.translateBy(x: 0, y: size.height)
        ctx.scaleBy(x: size.width / s.width, y: -size.height / s.height)
        page.draw(with: box, to: ctx)
        ctx.restoreGState()
    }

    /// Renders a normalized region at a scale that keeps small text legible; returns a PNG data URL.
    func croppedPNG(_ n: NormalizedRect) -> String? {
        let s = displaySize
        let minPixels = 1024.0
        let scale = min(max(2 * Geometry.pageWorldWidth / s.width, minPixels / max(n.width * s.width, 1)), 4096 / s.width)
        let full = CGSize(width: s.width * scale, height: s.height * scale)
        let crop = CGRect(x: (n.x * full.width).rounded(), y: (n.y * full.height).rounded(), width: max(1, (n.width * full.width).rounded()), height: max(1, (n.height * full.height).rounded()))
        guard let ctx = CGContext(data: nil, width: Int(crop.width), height: Int(crop.height), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(CGRect(origin: .zero, size: crop.size))
        // Place the full page so the crop window lands at the context origin (CG has a bottom-left origin).
        ctx.translateBy(x: -crop.minX, y: -(full.height - crop.maxY))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: box, to: ctx)
        guard let image = ctx.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64," + png.base64EncodedString()
    }

    /// Text found inside a normalized region (may be empty for scanned pages).
    func text(in n: NormalizedRect) -> String {
        (page.selection(for: pageRect(fromNormalized: n))?.string ?? "")
            .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var isTextless: Bool {
        (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).count < Int(SharedContract.tokens.geometry.textlessPageCharacterThreshold)
    }
}
