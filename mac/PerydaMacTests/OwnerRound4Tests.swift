import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Owner test, 16 Nov: cards without the quote, translation options that stay open and switch, the
/// zoom kept when translating, a plain "Copy", an ask field as wide as the menu, and Pery's summary
/// folded or deleted.
@MainActor
final class OwnerRound4Tests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var reader: ReaderModel!
    var windows: [NSWindow] = []

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: "pagedReading")
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-round4-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        let book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
    }

    override func tearDown() async throws {
        for w in windows { w.orderOut(nil) }
        for key in ["journalSummary", "summaryCollapsed"] { UserDefaults.standard.removeObject(forKey: "\(key):\(reader.book.id)") }
    }

    func host<V: View>(_ view: V, size: CGSize) -> NSHostingView<V> {
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSHostingView(rootView: view)
        window.contentView = host
        window.orderFrontRegardless()
        windows.append(window)
        window.layoutIfNeeded()
        return host
    }

    func snapshot(_ view: NSView, _ name: String) throws {
        view.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent(name))
    }

    func anchor(_ text: String) -> YarnAnchor {
        let r = NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.02)
        return YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: text, lineRects: [r], boundingRect: r)
    }

    /// Every piece of text a SwiftUI view shows, from its accessibility tree.
    func shownText(_ element: Any) -> [String] {
        var out: [String] = []
        if let e = element as? NSAccessibilityProtocol {
            if let label = e.accessibilityLabel(), !label.isEmpty { out.append(label) }
            if let value = e.accessibilityValue() as? String, !value.isEmpty { out.append(value) }
            for child in e.accessibilityChildren() ?? [] { out += shownText(child) }
        }
        if let view = element as? NSView { for sub in view.subviews { out += shownText(sub) } }
        return out
    }

    // 1. A card shows the answer, not the passage again.
    func testACardShowsTheAnswerWithoutThePassage() async throws {
        reader.pending = PendingSelection(anchors: [anchor("Kavramlar sınırlarda netleşir ve bu cümle yalnız sayfada görünür.")], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        let card = try XCTUnwrap(reader.cards.cards.first)
        let view = host(YarnCardView(cardId: card.id, reader: reader, lang: .tr, openSettings: {}).background(Color.paper), size: CGSize(width: 420, height: 400))
        try await Task.sleep(for: .milliseconds(300))
        let texts = shownText(view).joined(separator: "\n")
        XCTAssertTrue(texts.contains("komşularıyla"), "the answer is there: \(texts)")
        XCTAssertFalse(texts.contains("yalnız sayfada görünür"), "the passage is not repeated: \(texts)")
        try snapshot(view, "peryda-mac-card-no-quote.png")
    }

    // Owner, 20 Nov: the reader's follow-up shows as a chat bubble, not as plain bold text.
    func testAFollowUpShowsAsTheReadersBubble() async throws {
        reader.pending = PendingSelection(anchors: [anchor("Kavramlar sınırlarda netleşir.")], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        let card = try XCTUnwrap(reader.cards.cards.first)
        reader.cards.ask(card.id, "Peki bunu gündelik bir örnekle anlatır mısın?")
        await reader.cards.waitForIdle()
        let view = host(YarnCardView(cardId: card.id, reader: reader, lang: .tr, openSettings: {}).background(Color.paper), size: CGSize(width: 420, height: 520))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertTrue(shownText(view).joined(separator: "\n").contains("gündelik bir örnekle"))
        try snapshot(view, "peryda-mac-follow-up-bubble.png")
    }

    // 2. "Explain terms in parentheses" switches both ways, and the options stay open.
    func testExplainTermsSwitchesAndTheOptionsStayOpen() async throws {
        UserDefaults.standard.removeObject(forKey: "explainTerms")
        defer { UserDefaults.standard.removeObject(forKey: "explainTerms") }
        let app = AppModel(store: store, settings: ByokSettings(), lang: .tr)
        var closed = 0
        let view = host(TranslateOptions(reader: reader, app: app, t: UIText(.tr)) { closed += 1 }.background(Color.paper), size: CGSize(width: 300, height: 320))
        try await Task.sleep(for: .milliseconds(200))
        /// SwiftUI draws a checkbox with an AppKit button inside a "Checkbox" host.
        func checkbox(_ v: NSView) -> NSButton? {
            if let b = v as? NSButton, String(describing: type(of: v.superview!)).contains("Checkbox") { return b }
            return v.subviews.lazy.compactMap(checkbox).first
        }
        let box = try XCTUnwrap(checkbox(view), "the setting is a checkbox")
        let window = try XCTUnwrap(view.window)
        /// A real click, as the reader makes it: the button tracks the press and waits for the release.
        func click() async {
            let p = box.convert(CGPoint(x: 8, y: box.bounds.midY), to: nil)
            func ev(_ type: NSEvent.EventType) -> NSEvent {
                NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
            }
            CardButtonTests.deliverQueuedMouseEvents(to: nil)
            NSApp.postEvent(ev(.leftMouseUp), atStart: false)
            window.sendEvent(ev(.leftMouseDown))
            CardButtonTests.deliverQueuedMouseEvents(to: window)
            try? await Task.sleep(for: .milliseconds(150))
        }
        XCTAssertTrue(app.explainTerms)
        XCTAssertEqual(box.state, .on)
        await click()
        XCTAssertFalse(app.explainTerms, "off")
        XCTAssertEqual(UserDefaults.standard.object(forKey: "explainTerms") as? Bool, false, "kept")
        XCTAssertEqual(try XCTUnwrap(checkbox(view)).state, .off, "the tick follows")
        await click()
        XCTAssertTrue(app.explainTerms, "on again")
        XCTAssertEqual(try XCTUnwrap(checkbox(view)).state, .on)
        XCTAssertEqual(closed, 0, "switching it does not close the options")
        try snapshot(view, "peryda-mac-translate-options.png")
    }

    // 3. Asking for a translation leaves the zoom (and the place being read) as they were.
    func testTranslatingKeepsTheZoom() async throws {
        let world = WorldView(model: reader) { _ in AnyView(EmptyView()) }
        let window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1400, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        windows.append(window)
        window.layoutIfNeeded()
        world.layoutSubtreeIfNeeded()
        world.scrollView.magnification = 0.8
        world.scrollView.contentView.scroll(to: CGPoint(x: 0, y: 300))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        let y = world.scrollView.contentView.bounds.minY
        world.perform(.showTranslation(page: 1), animated: false)
        XCTAssertEqual(world.scrollView.magnification, 0.8, accuracy: 0.0001, "the zoom stays")
        XCTAssertEqual(world.scrollView.contentView.bounds.minY, y, accuracy: 1, "and the place being read")
    }

    // 5. A long question wraps inside the menu instead of widening it.
    func testALongQuestionDoesNotWidenTheMenu() async throws {
        reader.pending = PendingSelection(anchors: [anchor("Kavramlar sınırlarda netleşir.")], rect: .zero)
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        let view = host(SelectionMenuView(reader: reader, lang: .tr).environment(app).padding(20), size: CGSize(width: 1400, height: 500))
        try await Task.sleep(for: .milliseconds(300))
        let before = view.fittingSize
        func field(_ v: NSView) -> NSView? {
            if v is NSTextView || v is NSTextField, (v as? NSTextField)?.isEditable ?? true { return v }
            return v.subviews.lazy.compactMap(field).first
        }
        let input = try XCTUnwrap(field(view))
        view.window?.makeFirstResponder(input)
        let long = String(repeating: "HGIUWRHGUWRIWRIUGHWRIUGHWIRUH ", count: 40)
        if let editor = view.window?.firstResponder as? NSTextView {
            editor.insertText(long, replacementRange: NSRange(location: 0, length: 0))
        } else if let text = input as? NSTextField {
            text.stringValue = long
        }
        try await Task.sleep(for: .milliseconds(300))
        view.layoutSubtreeIfNeeded()
        let after = view.fittingSize
        XCTAssertEqual(after.width, before.width, accuracy: 2, "as wide as before")
        XCTAssertLessThan(after.height, before.height + 4 * 24, "at most four lines taller")
        try snapshot(view, "peryda-mac-ask-long.png")
    }

    // 6. Pery's summary folds to its title and can be deleted.
    func testTheSummaryFoldsAndCanBeDeleted() async throws {
        try store.addJournal(JournalRecord(bookId: reader.book.id, source: .clip, quote: "Kavramlar sınırlarda netleşir.", text: "", pageNumber: 1))
        reader.reloadJournal()
        reader.summarize(lang: .tr)
        for _ in 0..<50 where reader.summarizing { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNotNil(reader.summary)
        reader.summaryCollapsed = true
        // Kept for the book.
        let again = try XCTUnwrap(ReaderModel(book: reader.book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        XCTAssertTrue(again.summaryCollapsed)
        XCTAssertNotNil(again.summary)
        let view = host(JournalPanel(reader: reader, lang: .tr, openSettings: {}), size: CGSize(width: 380, height: 600))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(shownText(view).joined().contains("komşularıyla"), "folded: the summary's text is hidden")
        try snapshot(view, "peryda-mac-summary-folded.png")

        reader.deleteSummary()
        XCTAssertNil(reader.summary)
        XCTAssertNil(UserDefaults.standard.object(forKey: "journalSummary:\(reader.book.id)"), "removed for good")
        XCTAssertEqual(reader.journal.count, 1, "the entries stay")
        let reopened = try XCTUnwrap(ReaderModel(book: reader.book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        XCTAssertNil(reopened.summary)

        // A new summary opens again.
        reader.summaryCollapsed = true
        reader.summarize(lang: .tr)
        XCTAssertFalse(reader.summaryCollapsed)
        for _ in 0..<50 where reader.summarizing { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(reader.summary?.text, "Kavram, komşularıyla karşılaştırıldığında netleşir.")
    }
}
