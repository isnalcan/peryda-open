import AppKit
import SwiftUI

/// A SwiftUI view living inside the magnified world (cards, knot badges).
///
/// Inside a magnified scroll view SwiftUI's own hit testing and gestures stop working: only exactly
/// 100% worked, so at 63% a card's buttons did nothing and its header could not be dragged. AppKit's
/// geometry stays right at any zoom, so here clicks go to the AppKit control under the pointer
/// (buttons, the reply field, answer text), and the card's own gestures (dragging the header, a click
/// to focus or reveal) are handled with AppKit too, at every zoom.
final class ZoomedHostingView<Content: View>: NSHostingView<Content> {
    /// Header drag in world units (translation, ended).
    var onHeaderDrag: ((CGSize, Bool) -> Void)?
    /// A click that was not a drag, at a point measured from the view's top-left corner.
    var onClick: ((CGPoint) -> Void)?
    /// Resizing from the bottom-right corner: the new size in world units, and whether it ended.
    var onResize: ((CGSize, Bool) -> Void)?
    /// A double-click on the corner returns the card to its natural size.
    var onResizeReset: (() -> Void)?
    var headerHeight: CGFloat = 36
    var gripSize: CGFloat = 16

    private enum Grab { case header, corner(CGSize), body }
    private var press: (start: CGPoint, grab: Grab)?
    private var dragging = false

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let superview, !isHidden else { return nil }
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        return Self.control(in: self, at: local) ?? self
    }

    /// The front-most control or text view containing `point` (in `view`'s coordinates).
    static func control(in view: NSView, at point: CGPoint) -> NSView? {
        for sub in view.subviews.reversed() where !sub.isHidden && sub.alphaValue > 0.01 {
            let p = sub.convert(point, from: view)
            guard sub.bounds.contains(p) else { continue }
            if sub is NSControl { return sub }
            // Text that cannot be selected (a blurred answer) lets the click through to the card.
            if let text = sub as? NSText { if text.isSelectable || text.isEditable { return sub } else { continue } }
            if let inner = control(in: sub, at: p) { return inner }
        }
        return nil
    }

    /// A click on a card in an inactive window acts at once, like the buttons on it.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// A point measured from the top-left corner, whichever way this view is flipped.
    private func fromTopLeft(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)
    }

    private func inCorner(_ p: CGPoint) -> Bool {
        onResize != nil && p.x > bounds.width - gripSize && p.y > bounds.height - gripSize
    }

    override func mouseDown(with event: NSEvent) {
        guard let superview else { return }
        let p = fromTopLeft(event)
        let grab: Grab
        if inCorner(p) {
            if event.clickCount == 2 {
                onResizeReset?()
                press = nil
                return
            }
            grab = .corner(bounds.size)
        } else if p.y < headerHeight, onHeaderDrag != nil {
            grab = .header
        } else {
            grab = .body
        }
        press = (superview.convert(event.locationInWindow, from: nil), grab)
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let press, let superview else { return }
        let p = superview.convert(event.locationInWindow, from: nil)
        let t = CGSize(width: p.x - press.start.x, height: p.y - press.start.y)
        switch press.grab {
        case .header:
            let m = enclosingScrollView?.magnification ?? 1
            if !dragging, hypot(t.width, t.height) * m < 4 { return }
            dragging = true
            NSCursor.closedHand.set()
            onHeaderDrag?(t, false)
        case .corner(let start):
            dragging = true
            onResize?(CGSize(width: start.width + t.width, height: start.height + t.height), false)
        case .body:
            break
        }
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            press = nil
            dragging = false
        }
        guard let press, let superview else { return }
        let p = superview.convert(event.locationInWindow, from: nil)
        let t = CGSize(width: p.x - press.start.x, height: p.y - press.start.y)
        switch press.grab {
        case .header where dragging:
            onHeaderDrag?(t, true)
            NSCursor.arrow.set()
        case .corner(let start) where dragging:
            onResize?(CGSize(width: start.width + t.width, height: start.height + t.height), true)
        default:
            onClick?(fromTopLeft(event))
        }
    }

    /// A card whose middle scrolls (it was resized smaller than its content) scrolls under the pointer;
    /// otherwise the reading surface scrolls.
    override func scrollWheel(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        if let inner = Self.scrollView(in: self, at: local), let doc = inner.documentView, doc.frame.height > inner.contentView.bounds.height + 1 {
            inner.scrollWheel(with: event)
        } else {
            super.scrollWheel(with: event)
        }
    }

    static func scrollView(in view: NSView, at point: CGPoint) -> NSScrollView? {
        for sub in view.subviews.reversed() where !sub.isHidden {
            let p = sub.convert(point, from: view)
            guard sub.bounds.contains(p) else { continue }
            if let s = sub as? NSScrollView { return s }
            if let inner = scrollView(in: sub, at: p) { return inner }
        }
        return nil
    }

    override func resetCursorRects() {
        if onHeaderDrag != nil { addCursorRect(CGRect(x: 0, y: isFlipped ? 0 : bounds.height - headerHeight, width: bounds.width, height: headerHeight), cursor: .openHand) }
        if onResize != nil {
            let corner = CGRect(x: bounds.width - gripSize, y: isFlipped ? bounds.height - gripSize : 0, width: gripSize, height: gripSize)
            if #available(macOS 15.0, *) {
                addCursorRect(corner, cursor: .frameResize(position: .bottomRight, directions: .all))
            } else {
                addCursorRect(corner, cursor: .crosshair)
            }
        }
    }
}
