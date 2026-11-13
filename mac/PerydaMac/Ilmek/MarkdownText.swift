import AppKit
import PerydaKit

/// Pery's answers, page translations and journal text as attributed text: the paragraphs, headings,
/// lists, quotes and lines that Markdown.blocks finds (the same rules as the web engine), with bold,
/// italic and code inside. Text only: a link keeps its words and loses its address.
///
/// Lines and quote bars are not text: they are marked with an attribute holding their colour and drawn
/// by AnswerTextView (TextKit 1), the same way whether the app is light or dark.
enum MarkdownText {
    struct Style {
        var font: NSFont
        var color: NSColor
        /// Quotes.
        var soft: NSColor
        /// `---` lines and the bar beside quotes.
        var line: NSColor
        var lineSpacing: CGFloat
        /// Space between blocks.
        var blockSpacing: CGFloat
        /// Space between the items of a list.
        var itemSpacing: CGFloat
        /// Space before a heading that follows other text.
        var headingSpacing: CGFloat
        /// Headings are bold, at this multiple of the body size.
        var headingScale: CGFloat = 1
    }

    static func attributed(_ text: String, style: Style) -> NSAttributedString {
        let out = NSMutableAttributedString()
        func add(_ piece: NSAttributedString) {
            // The line break belongs to the paragraph before it, so it carries that paragraph's style.
            if out.length > 0 { out.append(NSAttributedString(string: "\n", attributes: out.attributes(at: out.length - 1, effectiveRange: nil))) }
            out.append(piece)
        }
        let size = style.font.pointSize
        for block in Markdown.blocks(text) {
            let first = out.length == 0
            switch block {
            case .paragraph(let body):
                add(inline(body, font: style.font, color: style.color, paragraph: paragraph(style, before: first ? 0 : style.blockSpacing)))
            case .heading(let body):
                let font = NSFont(descriptor: style.font.fontDescriptor.withSymbolicTraits(.bold), size: size * style.headingScale) ?? style.font
                add(inline(body, font: font, color: style.color, paragraph: paragraph(style, before: first ? 0 : style.headingSpacing)))
            case .quote(let body):
                // Indented; AnswerTextView draws the bar along its left edge.
                let para = paragraph(style, before: first ? 0 : style.blockSpacing)
                para.headIndent = size * 0.85
                para.firstLineHeadIndent = size * 0.85
                let quote = NSMutableAttributedString(attributedString: inline(body, font: style.font, color: style.soft, paragraph: para))
                quote.addAttribute(.markdownQuote, value: style.line, range: NSRange(location: 0, length: quote.length))
                add(quote)
            case .bullets(let items), .numbered(let items):
                let numbered = if case .numbered = block { true } else { false }
                let indent = size * (numbered ? 1.6 : 1.2)
                for (i, item) in items.enumerated() {
                    let para = paragraph(style, before: out.length == 0 ? 0 : (i == 0 ? style.blockSpacing : style.itemSpacing))
                    para.headIndent = indent
                    para.firstLineHeadIndent = 0
                    para.tabStops = [NSTextTab(textAlignment: .left, location: indent)]
                    let line = NSMutableAttributedString(string: numbered ? "\(i + 1).\t" : "•\t", attributes: [.font: style.font, .foregroundColor: style.color, .paragraphStyle: para])
                    line.append(inline(item, font: style.font, color: style.color, paragraph: para))
                    add(line)
                }
            case .rule:
                // A thin empty row; AnswerTextView draws the line through it, across the whole width.
                let para = paragraph(style, before: first ? 0 : style.blockSpacing)
                para.lineSpacing = 0
                add(NSAttributedString(string: "\u{00A0}", attributes: [.font: NSFont.systemFont(ofSize: max(4, size * 0.4)), .paragraphStyle: para, .markdownRule: style.line]))
            }
        }
        return out
    }

    /// The reader's own words (questions and notes), shown exactly as typed.
    static func plain(_ text: String, style: Style) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: style.font, .foregroundColor: style.color, .paragraphStyle: paragraph(style, before: 0)])
    }

    private static func paragraph(_ style: Style, before: CGFloat) -> NSMutableParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineSpacing = style.lineSpacing
        p.paragraphSpacingBefore = before
        return p
    }

    private static func inline(_ text: String, font: NSFont, color: NSColor, paragraph: NSParagraphStyle) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for span in Markdown.spans(text) {
            var f = span.code ? NSFont.monospacedSystemFont(ofSize: font.pointSize * 0.9, weight: .regular) : font
            var traits = f.fontDescriptor.symbolicTraits
            if span.bold { traits.insert(.bold) }
            if span.italic { traits.insert(.italic) }
            if traits != f.fontDescriptor.symbolicTraits {
                f = NSFont(descriptor: f.fontDescriptor.withSymbolicTraits(traits), size: f.pointSize) ?? f
            }
            out.append(NSAttributedString(string: span.text, attributes: [.font: f, .foregroundColor: color, .paragraphStyle: paragraph]))
        }
        return out
    }
}

extension NSAttributedString.Key {
    /// A `---` line: drawn across the text's width through this character's row. The value is its colour.
    static let markdownRule = NSAttributedString.Key("PerydaMarkdownRule")
    /// A quote: a bar is drawn along its left edge. The value is the bar's colour.
    static let markdownQuote = NSAttributedString.Key("PerydaMarkdownQuote")
}
