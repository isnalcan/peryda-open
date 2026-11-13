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
    var onSelect: (String, CGRect) -> Void = { _, _ in }

    static let font: NSFont = {
        let base = NSFont.systemFont(ofSize: 14)
        let serif = base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor
        return NSFont(descriptor: serif, size: 14) ?? base
    }()

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
        if view.source != text {
            view.source = text
            view.textStorage?.setAttributedString(markdown ? Self.attributed(text, font: font) : MarkdownText.plain(text, style: Self.style(font)))
        }
        view.onSelect = onSelect
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: AnswerTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 340
        guard let container = view.textContainer, let layout = view.layoutManager else { return nil }
        container.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: ceil(layout.usedRect(for: container).height))
    }
}

/// TextKit 1 text (create it with `usingTextLayoutManager: false`) that also draws the `---` lines and
/// quote bars MarkdownText marks.
final class AnswerTextView: NSTextView {
    var source = ""
    var onSelect: ((String, CGRect) -> Void)?

    override func draw(_ dirtyRect: NSRect) {
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
        super.mouseDown(with: event)
        // NSTextView tracks the drag inside mouseDown; report when it ends.
        reportSelection()
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
