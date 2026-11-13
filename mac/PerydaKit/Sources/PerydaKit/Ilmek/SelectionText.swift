import CoreGraphics
import Foundation

/// The text of a PDF selection, put together from PDFKit's pieces line by line (`selectionsByLine`).
///
/// PDFKit breaks some lines of Chrome-printed PDFs (pages set in Type3 fonts) after a word's first
/// capital, so a selection reads "E" + "nlightenment is a person's way". The two halves sit side by side
/// on one line with no gap between them, and are joined again. Nothing else is joined by position:
/// PDFKit's piece boxes on ordinary PDFs are not exact enough for that (table cells and spaced
/// formulas would run together).
public enum SelectionText {
    public struct Piece: Sendable, Equatable {
        public var text: String
        /// In page space (points, bottom-left origin), as `PDFSelection.bounds(for:)` gives it.
        public var bounds: CGRect

        public init(text: String, bounds: CGRect) {
            self.text = text
            self.bounds = bounds
        }
    }

    /// Bottoms closer than this (in line heights) are one line.
    static let sameLine: CGFloat = 0.15
    /// The second half of a broken word starts within this of the first half's end (in line heights).
    static let brokenWordGap: CGFloat = 0.1
    static let overlap: CGFloat = 0.2
    /// A gap this wide (in line heights) between two pieces on one line is a space.
    static let spaceGap: CGFloat = 0.2

    /// What goes between two pieces on one line.
    public enum InLine: Sendable {
        /// Always a space (a drag selection's text, as before).
        case space
        /// A space only where the pieces stand apart, as PDFKit's own text of a region does.
        case spaceAtGaps
    }

    /// Pieces in order: between pieces on one line as `inLine` says, `lineBreak` between lines, and
    /// nothing between the two halves of a word PDFKit broke after its first capital. A piece PDFKit
    /// repeats (same text over the same place) is taken once.
    public static func join(_ pieces: [Piece], inLine: InLine, lineBreak: String) -> String {
        var out = ""
        var previous: Piece?
        var seen: [Piece] = []
        for piece in pieces where !piece.text.isEmpty && !seen.contains(where: { isRepeat($0, piece) }) {
            seen.append(piece)
            if let p = previous {
                if !sharesLine(p.bounds, piece.bounds) {
                    out += lineBreak
                } else if !isBrokenWord(p, piece) {
                    switch inLine {
                    case .space: out += " "
                    case .spaceAtGaps: if piece.bounds.minX - p.bounds.maxX >= spaceGap * max(p.bounds.height, piece.bounds.height) { out += " " }
                    }
                }
            }
            out += piece.text
            previous = piece
        }
        return out
    }

    /// The same text again, its box at least half over the first one's.
    static func isRepeat(_ a: Piece, _ b: Piece) -> Bool {
        guard a.text == b.text else { return false }
        if a.bounds == b.bounds { return true }
        let overlap = a.bounds.intersection(b.bounds)
        guard !overlap.isNull else { return false }
        let smaller = min(a.bounds.width * a.bounds.height, b.bounds.width * b.bounds.height)
        return smaller > 0 && overlap.width * overlap.height >= 0.5 * smaller
    }

    static func sharesLine(_ a: CGRect, _ b: CGRect) -> Bool {
        let height = max(a.height, b.height)
        guard height > 0, a.minY.isFinite, b.minY.isFinite else { return false }
        return abs(a.minY - b.minY) < sameLine * height
    }

    /// `a` ends in a capital standing alone ("E", "der E") and `b` goes on in lower case right where `a`
    /// ends: PDFKit's broken word, not two words.
    static func isBrokenWord(_ a: Piece, _ b: Piece) -> Bool {
        guard a.text.range(of: "(^|\\s)\\p{Lu}$", options: .regularExpression) != nil,
              b.text.range(of: "^\\p{Ll}", options: .regularExpression) != nil else { return false }
        let height = max(a.bounds.height, b.bounds.height)
        let gap = b.bounds.minX - a.bounds.maxX
        return gap >= -overlap * height && gap < brokenWordGap * height
    }

    // MARK: A page's whole text

    /// Whether a page's text may hold a word PDFKit broke after its first capital: a capital standing
    /// alone at a line's end, the next line going on in lower case. (Cheap; checked before anything else.)
    public static func mayHaveBrokenWords(_ text: String) -> Bool {
        text.range(of: "(^|\\s)\\p{Lu}\\n\\p{Ll}", options: .regularExpression) != nil
    }

    /// A page's text (`PDFPage.string`) with the line breaks PDFKit put inside broken words taken out,
    /// only where the page's pieces (the whole page's `selectionsByLine`) show the two halves side by
    /// side on one line. Everything else is left as it is.
    public static func joinBrokenWords(in text: String, pieces: [Piece]) -> String {
        var distinct: [Piece] = []
        for piece in pieces where !piece.text.isEmpty && !distinct.contains(where: { isRepeat($0, piece) }) { distinct.append(piece) }
        var out = text
        var cursor = out.startIndex
        for (a, b) in zip(distinct, distinct.dropFirst()) where sharesLine(a.bounds, b.bounds) && isBrokenWord(a, b) {
            guard let capital = a.text.last else { continue }
            let head = String(b.text.prefix { $0 != "\n" && $0 != "\r" }.prefix(20))
            guard let found = out.range(of: "\(capital)\n\(head)", range: cursor..<out.endIndex) else { continue }
            let offset = out.distance(from: out.startIndex, to: found.lowerBound) + 1
            out.remove(at: out.index(out.startIndex, offsetBy: offset))
            cursor = out.index(out.startIndex, offsetBy: offset)
        }
        return out
    }
}
