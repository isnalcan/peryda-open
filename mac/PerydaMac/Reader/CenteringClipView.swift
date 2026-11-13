import AppKit

/// Keeps the world centred when it is smaller than the window (zoomed out), instead of pinned to the
/// left, and in page-by-page reading keeps the view on the current page's band.
final class CenteringClipView: NSClipView {
    /// The vertical stretch the view may show (page-by-page reading), in world units.
    var band: ClosedRange<CGFloat>? {
        didSet { if band != oldValue { scroll(to: bounds.origin) } }
    }

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
        } else if r.height >= doc.height {
            r.origin.y = doc.minY
        }
        return r
    }
}
