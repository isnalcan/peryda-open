import AppKit
import PerydaKit
import SwiftUI

/// Pery's answer as selectable text. Selecting part of it opens the selection menu, so a thread can be
/// pulled out of a card into the next lane.
struct SelectableAnswer: NSViewRepresentable {
    let text: String
    /// The reading face by default; follow-up questions use the interface face.
    var font: NSFont = SelectableAnswer.font
    /// Pery's answers and journal text are Markdown; the reader's own questions and notes are shown as typed.
    var markdown = true
    /// Passages threads were opened from, marked in those threads' colours.
    var marks: [AnswerTextView.Mark] = []
    /// A press in the text, before any new selection (it closes the open selection menu).
    var onPress: (() -> Void)?
    var onSelect: (String, CGRect) -> Void = { _, _ in }

    static let font: NSFont = readingFont(14)

    /// The reading face (Apple's serif) at a size.
    static func readingFont(_ size: CGFloat) -> NSFont {
        let base = NSFont.systemFont(ofSize: size)
        let serif = base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor
        return NSFont(descriptor: serif, size: size) ?? base
    }

    static func style(_ font: NSFont) -> MarkdownText.Style {
        MarkdownText.Style(font: font, color: Theme.ink, soft: Theme.inkSoft, line: Theme.lineStrong, lineSpacing: 3, blockSpacing: 8, itemSpacing: 3, headingSpacing: 10)
    }

    /// Markdown (paragraphs, headings, lists, quotes, lines; bold, italic, code) in the reading face.
    static func attributed(_ markdown: String, font: NSFont = SelectableAnswer.font) -> NSAttributedString {
        MarkdownText.attributed(markdown, style: style(font))
    }

    func makeNSView(context: Context) -> AnswerTextView {
        let view = AnswerTextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.selectedTextAttributes = [.backgroundColor: NSColor.selectedTextBackgroundColor.withAlphaComponent(0.5)]
        return view
    }

    func updateNSView(_ view: AnswerTextView, context: Context) {
        if view.source != text || view.sourceFont != font {
            view.source = text
            view.sourceFont = font
            view.textStorage?.setAttributedString(markdown ? Self.attributed(text, font: font) : MarkdownText.plain(text, style: Self.style(font)))
            view.heights.removeAll()
        }
        view.onSelect = onSelect
        view.onPress = onPress
        view.marks = marks
    }

    /// Measured on a copy of the text, so the view's own text keeps following its frame. (Measuring
    /// in the view itself left the text laid out at the last width asked about, wider than the
    /// journal it sat in: owner test 14 Nov.)
    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: AnswerTextView, context: Context) -> CGSize? {
        let width = (proposal.width ?? 340).rounded(.down)
        guard let storage = view.textStorage else { return nil }
        if let known = view.heights[width] { return CGSize(width: width, height: known) }
        let height = AnswerTextView.height(of: storage, width: width)
        view.heights[width] = height
        return CGSize(width: width, height: height)
    }
}

/// TextKit 1 text (create it with `usingTextLayoutManager: false`) that also draws the `---` lines and
/// quote bars MarkdownText marks.
final class AnswerTextView: NSTextView {
    var source = ""
    var sourceFont: NSFont?
    /// Heights of the current text at the widths SwiftUI asked about.
    var heights: [CGFloat: CGFloat] = [:]

    /// How tall a text is when laid out at a width (TextKit 1, no line padding, like these views).
    static func height(of text: NSAttributedString, width: CGFloat) -> CGFloat {
        let storage = NSTextStorage(attributedString: text)
        let container = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        let layout = NSLayoutManager()
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        return ceil(layout.usedRect(for: container).height)
    }
    var onSelect: ((String, CGRect) -> Void)?
    var onPress: (() -> Void)?

    /// A passage a thread was opened from: its text, its colour, and (for a card on the reading
    /// surface) where it was selected, in the card's own units, to tell repeated passages apart.
    struct Mark: Equatable {
        var text: String
        var color: NSColor
        var near: CGRect?
        /// Multiplied into the text like a highlighter on paper (the translated page).
        var multiply = false
    }

    var marks: [Mark] = [] {
        didSet { if marks != oldValue { needsDisplay = true } }
    }

    /// The text view holding the last selection, so a press in another one (or on the page) clears it.
    private static weak var active: AnswerTextView?

    /// Clears the selection left in a card's or translation's text.
    static func clearActive() {
        guard let view = active else { return }
        active = nil
        view.setSelectedRange(NSRange(location: 0, length: 0))
    }

    override func draw(_ dirtyRect: NSRect) {
        drawMarks()
        super.draw(dirtyRect)
        guard let storage = textStorage, storage.length > 0, let layout = layoutManager, let container = textContainer else { return }
        let all = NSRange(location: 0, length: storage.length)
        let origin = textContainerOrigin
        let left = origin.x + container.lineFragmentPadding
        let width = max(container.size.width - 2 * container.lineFragmentPadding, 0)
        storage.enumerateAttribute(.markdownRule, in: all) { value, range, _ in
            guard let color = value as? NSColor else { return }
            let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            guard glyphs.length > 0 else { return }
            let row = layout.lineFragmentUsedRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            color.setFill()
            NSRect(x: left, y: (origin.y + row.midY).rounded(.down), width: width, height: 1).fill()
        }
        storage.enumerateAttribute(.markdownQuote, in: all) { value, range, _ in
            guard let color = value as? NSColor else { return }
            let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            guard glyphs.length > 0 else { return }
            let first = layout.lineFragmentUsedRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            let last = layout.lineFragmentUsedRect(forGlyphAt: NSMaxRange(glyphs) - 1, effectiveRange: nil)
            color.setFill()
            NSRect(x: left, y: origin.y + first.minY + 2, width: 2, height: max(last.maxY - first.minY - 4, 2)).fill()
        }
    }

    /// Selecting in a card works on the first click, even when the window was not in front.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseUp(with event: NSEvent) {
        super.mouseUp(with: event)
        reportSelection()
    }

    override func mouseDown(with event: NSEvent) {
        // A press in other text closes the menu of the last selection and clears that selection
        // (owner test 14 Nov: only a click on empty space did).
        if Self.active !== self { Self.clearActive() }
        Self.active = self
        onPress?()
        super.mouseDown(with: event)
        // NSTextView tracks the drag inside mouseDown; report when it ends.
        reportSelection()
    }

    /// The marks, under the text: each passage's first line-by-line rectangles, slightly rounded.
    private func drawMarks() {
        guard !marks.isEmpty, let layout = layoutManager, let container = textContainer, let ctx = NSGraphicsContext.current?.cgContext else { return }
        let text = string.replacingOccurrences(of: "\u{00A0}", with: " ") as NSString
        let origin = textContainerOrigin
        for mark in marks {
            guard let range = range(of: mark, in: text, layout: layout, container: container) else { continue }
            let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            ctx.saveGState()
            if mark.multiply { ctx.setBlendMode(.multiply) }
            mark.color.setFill()
            layout.enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { rect, _ in
                NSBezierPath(roundedRect: rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -1.5, dy: 0), xRadius: 2.5, yRadius: 2.5).fill()
            }
            ctx.restoreGState()
        }
    }

    /// Where the passage is in this text; of several, the one nearest where it was selected.
    private func range(of mark: Mark, in text: NSString, layout: NSLayoutManager, container: NSTextContainer) -> NSRange? {
        let needle = mark.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return nil }
        var found: [NSRange] = []
        var search = NSRange(location: 0, length: text.length)
        while found.count < 20 {
            let r = text.range(of: needle, options: [], range: search)
            guard r.location != NSNotFound else { break }
            found.append(r)
            let next = NSMaxRange(r)
            search = NSRange(location: next, length: text.length - next)
        }
        guard found.count > 1, let near = mark.near, let card = Self.cardView(of: self) else { return found.first }
        return found.min { a, b in
            func distance(_ r: NSRange) -> CGFloat {
                let glyphs = layout.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
                let local = layout.boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
                return abs(convert(local, to: card).midY - near.midY)
            }
            return distance(a) < distance(b)
        }
    }

    /// The card on the reading surface this text belongs to (its coordinates are the card's units).
    private static func cardView(of view: NSView) -> NSView? {
        sequence(first: view.superview, next: { $0?.superview }).compactMap { $0 }.first { $0 is ZoomedHostingView<AnyView> }
    }

    private func reportSelection() {
        let range = selectedRange()
        guard range.length > 0, let layout = layoutManager, let container = textContainer else { return }
        let text = (string as NSString).substring(with: range).replacingOccurrences(of: "\u{00A0}", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let local = layout.boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
        onSelect?(text, convert(local, to: nil))
    }
}
