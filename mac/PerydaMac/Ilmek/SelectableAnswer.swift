import AppKit
import PerydaKit
import SwiftUI

/// Pery's answer as selectable text. Selecting part of it opens the selection menu, so a thread can be
/// pulled out of a card into the next lane.
struct SelectableAnswer: NSViewRepresentable {
    let text: String
    /// The reading face by default; follow-up questions use the interface face.
    var font: NSFont = SelectableAnswer.font
    let onSelect: (String, CGRect) -> Void

    static let font: NSFont = {
        let base = NSFont.systemFont(ofSize: 14)
        let serif = base.fontDescriptor.withDesign(.serif) ?? base.fontDescriptor
        return NSFont(descriptor: serif, size: 14) ?? base
    }()

    /// Markdown (bold, italic, code) to attributed text in the reading face.
    static func attributed(_ markdown: String, font baseFont: NSFont = SelectableAnswer.font) -> NSAttributedString {
        let parsed = (try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(markdown)
        let out = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        for run in parsed.runs {
            let piece = String(parsed[run.range].characters)
            var font = baseFont
            if let intent = run.inlinePresentationIntent {
                var traits: NSFontDescriptor.SymbolicTraits = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
                if intent.contains(.emphasized) { traits.insert(.italic) }
                if intent.contains(.code) { font = .monospacedSystemFont(ofSize: 12.5, weight: .regular) }
                if !traits.isEmpty { font = NSFont(descriptor: font.fontDescriptor.withSymbolicTraits(traits), size: font.pointSize) ?? font }
            }
            out.append(NSAttributedString(string: piece, attributes: [.font: font, .foregroundColor: Theme.ink, .paragraphStyle: paragraph]))
        }
        return out
    }

    func makeNSView(context: Context) -> AnswerTextView {
        let view = AnswerTextView()
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
            view.textStorage?.setAttributedString(Self.attributed(text, font: font))
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

final class AnswerTextView: NSTextView {
    var source = ""
    var onSelect: ((String, CGRect) -> Void)?

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
        let text = (string as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let local = layout.boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
        onSelect?(text, convert(local, to: nil))
    }
}
