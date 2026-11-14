import Foundation

/// How Pery's answers, page translations and journal text are read as Markdown: paragraphs, headings,
/// bullet and numbered lists, quotes, lines (`---`), and bold, italic and code inside them. The same
/// rules as the web engine (web/src/ui/Markdown.tsx), checked against shared/vectors/markdown.json.
/// Only text comes out: a link or image keeps its words and loses its address.
public enum Markdown {
    public enum Block: Equatable, Sendable {
        case paragraph(String)
        case heading(String)
        case quote(String)
        case bullets([String])
        case numbered([String])
        case rule
    }

    public struct Span: Equatable, Sendable {
        public var text: String
        public var bold = false
        public var italic = false
        public var code = false

        public init(text: String, bold: Bool = false, italic: Bool = false, code: Bool = false) {
            self.text = text
            self.bold = bold
            self.italic = italic
            self.code = code
        }
    }

    private static func regex(_ pattern: String) -> NSRegularExpression {
        // The patterns are fixed and tested; a typo must fail the tests, not hide.
        try! NSRegularExpression(pattern: pattern)
    }

    private static let setext = regex(#"^\s*(?:={2,}|-{2,})\s*$"#)
    private static let rule = regex(#"^\s*([-*_])(?:\s*\1){2,}\s*$"#)
    // The heading's text is taken whole; closing hashes are trimmed by hand (a lazy group followed by
    // optional spaces took quadratic time on a long line of spaces, audit WW-1).
    private static let heading = regex(#"^\s*#{1,6}\s+(\S.*)$"#)
    private static let bullet = regex(#"^\s*[-*•+]\s+(.*)$"#)
    private static let number = regex(#"^\s*\d+[.)]\s+(.*)$"#)
    private static let quote = regex(#"^\s*>\s?(.*)$"#)
    private static let indented = regex(#"^\s+\S"#)

    private static func match(_ re: NSRegularExpression, _ line: String) -> String?? {
        let ns = line as NSString
        guard let m = re.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        if m.numberOfRanges > 1, m.range(at: 1).location != NSNotFound { return .some(ns.substring(with: m.range(at: 1))) }
        return .some(nil)
    }

    private enum LineKind { case blank, paragraph, item, quote, other }

    /// Text longer than this is shown as plain paragraphs, without looking for marks: a crafted backup
    /// or answer cannot then make one card slow to draw (audit WW-1, 15 Nov). Same limit as the web.
    public static let plainAbove = 200_000

    /// A line without its trailing spaces and tabs (by hand: `\s+$` searched every position of a long
    /// run of spaces).
    static func trimmingTrailingSpace(_ line: String) -> String {
        var end = line.endIndex
        while end > line.startIndex, line[line.index(before: end)].isWhitespace { end = line.index(before: end) }
        return String(line[..<end])
    }

    /// A heading's text without its closing hashes ("## Title ##" → "Title").
    static func headingText(_ raw: String) -> String {
        let text = trimmingTrailingSpace(raw)
        var end = text.endIndex
        while end > text.startIndex, text[text.index(before: end)] == "#" { end = text.index(before: end) }
        guard end < text.endIndex, end > text.startIndex, text[text.index(before: end)].isWhitespace else { return text }
        let rest = trimmingTrailingSpace(String(text[..<end]))
        return rest.isEmpty ? text : rest
    }

    public static func blocks(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var previous = LineKind.blank
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        if text.utf16.count > plainAbove {
            return lines.split { $0.trimmingCharacters(in: .whitespaces).isEmpty }.map { .paragraph($0.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")) }
        }
        for raw in lines {
            let line = trimmingTrailingSpace(raw)
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
                previous = .blank
            } else if !paragraph.isEmpty, match(setext, line) != nil {
                blocks.append(.heading(paragraph.joined(separator: " ")))
                paragraph = []
                previous = .other
            } else if match(rule, line) != nil {
                flush()
                blocks.append(.rule)
                previous = .other
            } else if let text = match(heading, line), let text {
                flush()
                blocks.append(.heading(headingText(text)))
                previous = .other
            } else if let item = match(bullet, line) ?? match(number, line), let item {
                flush()
                let isBullet = match(bullet, line) != nil
                switch (blocks.last, isBullet) {
                case (.bullets(let items), true): blocks[blocks.count - 1] = .bullets(items + [item])
                case (.numbered(let items), false): blocks[blocks.count - 1] = .numbered(items + [item])
                default: blocks.append(isBullet ? .bullets([item]) : .numbered([item]))
                }
                previous = .item
            } else if previous == .item, match(indented, line) != nil {
                // An indented line under a list item goes on with that item.
                let more = line.trimmingCharacters(in: .whitespaces)
                switch blocks.last {
                case .bullets(var items): items[items.count - 1] += " " + more; blocks[blocks.count - 1] = .bullets(items)
                case .numbered(var items): items[items.count - 1] += " " + more; blocks[blocks.count - 1] = .numbered(items)
                default: break
                }
            } else if let text = match(quote, line), let text {
                flush()
                if previous == .quote, case .quote(let before) = blocks.last {
                    blocks[blocks.count - 1] = .quote(before + " " + text)
                } else {
                    blocks.append(.quote(text))
                }
                previous = .quote
            } else {
                paragraph.append(line.trimmingCharacters(in: .whitespaces))
                previous = .paragraph
            }
        }
        flush()
        return blocks
    }

    /// Bold italic, bold, italic, code, and links or images (their words only). A closing mark must
    /// follow a letter, not a space, and an underscore inside a word is just an underscore.
    private static let inline = regex(
        #"(\*\*\*[^*\s](?:[^*]*[^*\s])?\*\*\*|\*\*[^*\s](?:[^*]*[^*\s])?\*\*|__[^_\s](?:[^_]*[^_\s])?__|\*[^*\s](?:[^*]*[^*\s])?\*|(?<![\p{L}\p{N}])_[^_\s](?:[^_]*[^_\s])?_(?![\p{L}\p{N}])|`[^`]+`|!?\[[^\]\n]{1,200}+\]\([^)\s]{0,500}+\))"#
    )

    public static func spans(_ text: String) -> [Span] {
        guard text.utf16.count <= plainAbove else { return [Span(text: text)] }
        let ns = text as NSString
        var out: [Span] = []
        func add(_ span: Span) {
            guard !span.text.isEmpty else { return }
            if let last = out.last, !last.bold, !last.italic, !last.code, !span.bold, !span.italic, !span.code {
                out[out.count - 1].text += span.text
            } else {
                out.append(span)
            }
        }
        var last = 0
        for m in inline.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > last { add(Span(text: ns.substring(with: NSRange(location: last, length: m.range.location - last)))) }
            let token = ns.substring(with: m.range)
            if token.hasPrefix("***") {
                add(Span(text: String(token.dropFirst(3).dropLast(3)), bold: true, italic: true))
            } else if token.hasPrefix("**") || token.hasPrefix("__") {
                add(Span(text: String(token.dropFirst(2).dropLast(2)), bold: true))
            } else if token.hasPrefix("`") {
                add(Span(text: String(token.dropFirst().dropLast()), code: true))
            } else if token.hasPrefix("[") || token.hasPrefix("![") {
                let open = token.firstIndex(of: "[")!
                let close = token.firstIndex(of: "]")!
                add(Span(text: String(token[token.index(after: open)..<close])))
            } else {
                add(Span(text: String(token.dropFirst().dropLast()), italic: true))
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length { add(Span(text: ns.substring(from: last))) }
        return out
    }
}
