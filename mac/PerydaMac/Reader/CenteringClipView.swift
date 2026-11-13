import AppKit

/// Keeps the world centred when it is smaller than the window (zoomed out), instead of pinned to the
/// left, and in page-by-page reading keeps the view on the current page's band. While scrolling the
/// book, the reader may go on down past the last page or thread until only a strip of it is left at
/// the top of the window, at any zoom: room to move threads into, as on the web's free camera.
final class CenteringClipView: NSClipView {
    /// The vertical stretch the view may show (page-by-page reading), in world units.
    var band: ClosedRange<CGFloat>? {
        didSet { if band != oldValue { scroll(to: bounds.origin) } }
    }

    /// Where the lowest page, thread or translation ends, in world units.
    var contentBottom: CGFloat?

    /// How much of the content stays in view, on screen, when scrolled all the way down.
    static let keptInView: CGFloat = 120

    /// Programmatic scrolls (page keys, camera commands) obey the same limits as the trackpad.
    override func scroll(to newOrigin: NSPoint) {
        super.scroll(to: constrainBoundsRect(NSRect(origin: newOrigin, size: bounds.size)).origin)
    }

    override func constrainBoundsRect(_ proposed: NSRect) -> NSRect {
        var r = super.constrainBoundsRect(proposed)
        guard let doc = documentView?.frame else { return r }
        if r.width >= doc.width { r.origin.x = doc.midX - r.width / 2 }
        if let band {
            let length = band.upperBound - band.lowerBound
            r.origin.y = r.height >= length ? band.lowerBound + length / 2 - r.height / 2 : min(max(r.origin.y, band.lowerBound), band.upperBound - r.height)
        } else {
            // Bounds are in world units: a strip of so many points on screen is this many world units.
            let strip = Self.keptInView * r.height / max(frame.height, 1)
            let lowest = max((contentBottom ?? doc.maxY) - strip, doc.minY)
            r.origin.y = min(max(proposed.origin.y, doc.minY), lowest)
        }
        return r
    }
}
