import AppKit
import PerydaKit
import SwiftUI
import XCTest

/// Pery's answers on the Mac show headings, bullets and lines, not the marks that make them (the
/// parsing itself is checked against the shared vectors in PerydaKit).
@MainActor
final class MarkdownRenderingTests: XCTestCase {
    static let answer = """
    ### Kısaca

    Bu cümle **iki** şey söylüyor:

    * Birincisi, *zaman*.
    * İkincisi, `mekân`.

    ---

    1. Bir
    2. İki

    > Yazarın kendi sözü.

    Sonuç: [ayrıntı](https://evil.example/x) burada.
    """

    func testNoMarkdownMarksAreLeftInTheText() {
        let out = SelectableAnswer.attributed(Self.answer).string
        for mark in ["###", "* ", "---", "**", "`", "> ", "](", "evil.example"] {
            XCTAssertFalse(out.contains(mark), "\(mark) is still visible in: \(out)")
        }
        XCTAssertTrue(out.contains("•\tBirincisi, zaman."))
        XCTAssertTrue(out.contains("2.\tİki"))
        XCTAssertTrue(out.contains("Sonuç: ayrıntı burada."))
    }

    func testHeadingsAreBoldAndLinesAndQuotesAreMarked() throws {
        let out = SelectableAnswer.attributed(Self.answer)
        let heading = try XCTUnwrap(out.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        XCTAssertTrue(heading.fontDescriptor.symbolicTraits.contains(.bold))
        var rules = 0
        var quotes = 0
        out.enumerateAttribute(.markdownRule, in: NSRange(location: 0, length: out.length)) { value, _, _ in if value != nil { rules += 1 } }
        out.enumerateAttribute(.markdownQuote, in: NSRange(location: 0, length: out.length)) { value, _, _ in if value != nil { quotes += 1 } }
        XCTAssertEqual(rules, 1, "the line is drawn")
        XCTAssertEqual(quotes, 1, "the quote gets its bar")
    }

    func testLineColoursKeepTheirTransparency() throws {
        let line = try XCTUnwrap(Theme.hex("rgba(33, 31, 26, 0.18)").usingColorSpace(.sRGB))
        XCTAssertEqual(line.alphaComponent, 0.18, accuracy: 0.001)
        XCTAssertEqual(line.redComponent, 33.0 / 255, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(Theme.hex("#716B60").usingColorSpace(.sRGB)).alphaComponent, 1)
    }

    func testTheReadersOwnWordsStayAsTyped() {
        let typed = "- benim notum\n### değil başlık"
        XCTAssertEqual(MarkdownText.plain(typed, style: SelectableAnswer.style(SelectableAnswer.font)).string, typed)
    }

    func testAnswerSnapshot() async throws {
        for dark in [false, true] {
            let view = SelectableAnswer(text: Self.answer)
                .padding(16)
                .frame(width: 360)
                .background(Color.paperRaised)
            let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 360, height: 460), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            window.contentView = NSHostingView(rootView: view.frame(width: 360, height: 460, alignment: .top))
            window.orderFrontRegardless()
            defer { window.orderOut(nil) }
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(400))
            window.displayIfNeeded()
            let content = try XCTUnwrap(window.contentView)
            let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
            content.cacheDisplay(in: content.bounds, to: rep)
            let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
            try rep.representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(dark ? "peryda-mac-markdown-dark.png" : "peryda-mac-markdown.png"))
        }
    }
}
