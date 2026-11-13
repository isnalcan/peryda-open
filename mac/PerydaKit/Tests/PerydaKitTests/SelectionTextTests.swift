import CoreGraphics
import Testing
@testable import PerydaKit

/// Pieces as PDFKit gives them (page space, points), most from drags across Chrome-printed kant-en.pdf
/// and kant-de.pdf.
@Suite("Selection text")
struct SelectionTextTests {
    func piece(_ text: String, _ minX: CGFloat, _ maxX: CGFloat, y: CGFloat, h: CGFloat = 10.39) -> SelectionText.Piece {
        .init(text: text, bounds: CGRect(x: minX, y: y, width: maxX - minX, height: h))
    }

    @Test func joinsAWordPDFKitBrokeAfterItsFirstCapital() {
        let pieces = [
            piece("E", 45.00, 51.61, y: 462.82),
            piece("nlightenment is a person’s way out of a minority of their own", 51.61, 374.24, y: 462.82),
            piece("making. Minority is the inabil", 45.00, 197.67, y: 447.82),
        ]
        #expect(SelectionText.join(pieces, inLine: .space, lineBreak: " ") == "Enlightenment is a person’s way out of a minority of their own making. Minority is the inabil")
        #expect(SelectionText.join(pieces, inLine: .spaceAtGaps, lineBreak: "\n") == "Enlightenment is a person’s way out of a minority of their own\nmaking. Minority is the inabil")
        // The capital may end a longer piece, and kerning may pull the rest a little to the left.
        #expect(SelectionText.join([piece("sondern der E", 200, 268.4, y: 433.57), piece("ntschlie‐", 268.4, 312, y: 433.57)], inLine: .space, lineBreak: " ") == "sondern der Entschlie‐")
        #expect(SelectionText.join([piece("A", 45.00, 55.40, y: 526.49, h: 13.99), piece("n", 55.18, 64.68, y: 526.49, h: 13.99)], inLine: .space, lineBreak: " ") == "An")
    }

    @Test func aLoneCapitalBeforeAGapStaysAWord() {
        // "experiments I" at a line's end, "shall" on the next line; and "I" with a real space after it.
        #expect(SelectionText.join([piece("experiments I", 45, 120, y: 500), piece("shall have to", 45, 110, y: 486)], inLine: .space, lineBreak: " ") == "experiments I shall have to")
        #expect(SelectionText.join([piece("so I", 45, 62, y: 500), piece("think", 65, 90, y: 500)], inLine: .space, lineBreak: " ") == "so I think")
    }

    @Test func otherPiecesOnALineAreSeparatedAsBefore() {
        // Table cells and spaced formulas whose boxes touch are not glued together.
        let cells = [piece("[.39, .60]", 100, 140, y: 300), piece("–.57***", 140, 170, y: 300)]
        #expect(SelectionText.join(cells, inLine: .space, lineBreak: " ") == "[.39, .60] –.57***")
        #expect(SelectionText.join(cells, inLine: .spaceAtGaps, lineBreak: "\n") == "[.39, .60]–.57***")
        // In a region's text, pieces that stand apart on a line keep a space between them.
        let apart = [piece("10.1177/0956797617752640", 45, 160, y: 300), piece("https://doi.org", 166, 230, y: 300)]
        #expect(SelectionText.join(apart, inLine: .spaceAtGaps, lineBreak: "\n") == "10.1177/0956797617752640 https://doi.org")
    }

    @Test func linesAreSeparatedByTheLineBreak() {
        let lines = [
            piece("Aufklärung ist der Ausgang des Menschen aus seiner selbstver‐", 45, 374.25, y: 480.82),
            piece("schuldeten Unmündigkeit.", 45, 180, y: 465.07),
        ]
        #expect(SelectionText.join(lines, inLine: .space, lineBreak: " ") == "Aufklärung ist der Ausgang des Menschen aus seiner selbstver‐ schuldeten Unmündigkeit.")
        #expect(SelectionText.join(lines, inLine: .spaceAtGaps, lineBreak: "\n") == "Aufklärung ist der Ausgang des Menschen aus seiner selbstver‐\nschuldeten Unmündigkeit.")
    }

    @Test func takesARepeatedPieceOnce() {
        let pieces = [piece("Psychological Science", 45, 160, y: 700), piece("e", 170, 175, y: 700), piece("e", 170, 175, y: 700), piece("1–10", 180, 200, y: 700)]
        #expect(SelectionText.join(pieces, inLine: .space, lineBreak: " ") == "Psychological Science e 1–10")
        // Repeated a little to one side, it is still the same piece; the same word elsewhere is not.
        let shifted = [piece("e", 170, 175, y: 700), piece("e", 170.5, 175.5, y: 700), piece("e", 300, 305, y: 700)]
        #expect(SelectionText.join(shifted, inLine: .space, lineBreak: " ") == "e e")
    }

    @Test func joinsBrokenWordsInAPagesText() {
        // kant-en.pdf page 1 as PDFKit reads it, with the pieces of the whole page.
        let text = "A\nn\nnswer to the Question: What Is\nE\nnlightenment?\nImmanuel Kant · Berlinische Monatsschrift, December 1784\nA\nE\nnlightenment is a person’s way out of a minority of their own\nmaking."
        #expect(SelectionText.mayHaveBrokenWords(text))
        let pieces = [
            piece("A", 45.00, 55.40, y: 526.49, h: 13.99),
            piece("n", 55.18, 64.68, y: 526.49, h: 13.99),
            piece("nswer to the Question: What Is", 77.67, 289.80, y: 526.49, h: 13.99),
            piece("E", 45.00, 54.08, y: 509.24, h: 13.99),
            piece("nlightenment?", 54.07, 156.86, y: 509.24, h: 13.99),
            piece("Immanuel Kant · Berlinische Monatsschrift, December 1784\nA", 45, 282.65, y: 492.39, h: 48.1),
            piece("4\nA", 67.49, 282.65, y: 492.39, h: 48.1),
            piece("4\nA", 67.49, 282.65, y: 492.39, h: 48.1),
            piece("E", 45.00, 51.61, y: 462.82),
            piece("nlightenment is a person’s way out of a minority of their own", 51.61, 374.24, y: 462.82),
            piece("making.", 45.00, 80, y: 447.82),
        ]
        #expect(SelectionText.joinBrokenWords(in: text, pieces: pieces) == "An\nnswer to the Question: What Is\nEnlightenment?\nImmanuel Kant · Berlinische Monatsschrift, December 1784\nA\nEnlightenment is a person’s way out of a minority of their own\nmaking.")
    }

    @Test func leavesAPagesTextAloneWithoutBrokenPieces() {
        // "I" ends a line and "shall" starts the next: two words, in two lines.
        let text = "the experiments I\nshall have to"
        #expect(SelectionText.mayHaveBrokenWords(text))
        let pieces = [piece("the experiments I", 45, 120, y: 500), piece("shall have to", 45, 110, y: 486)]
        #expect(SelectionText.joinBrokenWords(in: text, pieces: pieces) == text)
        #expect(!SelectionText.mayHaveBrokenWords("Aufklärung ist der Ausgang\ndes Menschen"))
    }

    @Test func skipsEmptyPieces() {
        #expect(SelectionText.join([piece("", 0, 0, y: 0), piece("one", 45, 60, y: 400)], inLine: .space, lineBreak: " ") == "one")
        #expect(SelectionText.join([], inLine: .space, lineBreak: " ") == "")
    }
}
