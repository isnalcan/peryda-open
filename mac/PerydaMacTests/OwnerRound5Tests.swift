import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Owner, 16 Nov: find in the document, a book's details, four highlighter colours (hold Vurgula),
/// and page thumbnails beside the book.
@MainActor
final class OwnerRound5Tests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var reader: ReaderModel!
    var windows: [NSWindow] = []

    override func setUp() async throws {
        for key in ["pagedReading", "highlightColor", "thumbnailsOpen"] { UserDefaults.standard.removeObject(forKey: key) }
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-round5-\(UUID().uuidString)"))
        let source = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let doc = PDFDocument()
        for i in 0..<3 { doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: i) }
        let book = try store.importBook(data: try XCTUnwrap(doc.dataRepresentation()), fileName: "uc.pdf", title: "Üç Sayfa", author: "Bir Yazar", pageCount: 3)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
    }

    override func tearDown() async throws {
        for w in windows { w.orderOut(nil) }
        for key in ["pagedReading", "highlightColor", "thumbnailsOpen"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    func window(_ content: NSView, size: CGSize) -> NSWindow {
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = content
        w.orderFrontRegardless()
        windows.append(w)
        w.layoutIfNeeded()
        return w
    }

    func snapshot(_ view: NSView, _ name: String) throws {
        view.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent(name))
    }

    func waitFor(_ timeout: Double = 5, _ check: @escaping @MainActor () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if check() { return }
            try await Task.sleep(for: .milliseconds(30))
        }
        XCTFail("timed out")
    }

    func select(_ text: String) {
        let r = NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.02)
        reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: text, lineRects: [r], boundingRect: r)], rect: .zero)
    }

    // 1. Find: every page, Turkish letters and case alike, next and previous going round.
    func testFindGoesThroughTheWholeBook() async throws {
        reader.startFind()
        XCTAssertTrue(reader.finding)
        reader.find("DİKKAT")
        try await waitFor { [reader] in !reader!.findSearching && !reader!.findHits.isEmpty }
        let pages = Set(reader.findHits.map(\.page))
        XCTAssertEqual(pages, [1, 2, 3], "found on every page")
        let perPage = reader.findHits.filter { $0.page == 1 }.count
        XCTAssertGreaterThan(perPage, 0)
        XCTAssertEqual(reader.findIndex, 0, "the first match on or after the page being read")
        guard case .reveal(let page, _) = reader.cameraCommand else { return XCTFail("the match comes into view") }
        XCTAssertEqual(page, 1)
        reader.stepFind(-1)
        XCTAssertEqual(reader.findIndex, reader.findHits.count - 1, "previous from the first goes round to the last")
        reader.stepFind(1)
        XCTAssertEqual(reader.findIndex, 0)
        XCTAssertEqual(reader.findHitsByPage[2]?.count, perPage)
        for hit in reader.findHits { XCTAssertFalse(hit.rects.isEmpty) }
        reader.find("böyle bir söz yok")
        try await waitFor { [reader] in !reader!.findSearching }
        XCTAssertTrue(reader.findHits.isEmpty)
        XCTAssertNil(reader.findIndex)
        reader.closeFind()
        XCTAssertFalse(reader.finding)
    }

    // 1b. The matches are drawn on the pages and the view goes to the current one, at the same zoom.
    func testFindShowsTheMatchAtTheSameZoom() async throws {
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        reader.showThumbnails = true
        let host = NSHostingView(rootView: ReaderSurface(reader: reader).environment(app))
        let w = window(host, size: CGSize(width: 1400, height: 900))
        try await Task.sleep(for: .milliseconds(400))
        reader.cameraCommand = .focus
        try await Task.sleep(for: .milliseconds(400))
        reader.startFind()
        try await Task.sleep(for: .milliseconds(200))
        // Typed into the find bar.
        func field(_ v: NSView) -> NSTextField? { (v as? NSTextField).flatMap { $0.isEditable ? $0 : nil } ?? v.subviews.lazy.compactMap(field).first }
        let input = try XCTUnwrap(field(host))
        w.makeFirstResponder(input)
        (w.firstResponder as? NSTextView)?.insertText("dikkat", replacementRange: NSRange(location: 0, length: 0))
        try await waitFor { [reader] in !reader!.findHits.isEmpty && !reader!.findSearching }
        reader.stepFind(1)
        reader.stepFind(1)
        try await Task.sleep(for: .milliseconds(600))
        func find<T: NSView>(_ type: T.Type, in view: NSView) -> [T] { view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + find(type, in: $0) } }
        let pages = find(PageView.self, in: host)
        XCTAssertTrue(pages.contains { !$0.findHits.isEmpty }, "matches are drawn")
        XCTAssertTrue(pages.contains { $0.currentFind == reader.findIndex }, "the current one stronger")
        try snapshot(host, "peryda-mac-find-and-thumbnails.png")
    }

    // 2. A book's details.
    func testBookInfo() async throws {
        XCTAssertEqual(BookInfoSheet.size(4_210_000, .tr), "4,2 MB")
        XCTAssertEqual(BookInfoSheet.size(4_210_000, .en), "4.2 MB")
        XCTAssertEqual(BookInfoSheet.size(820_400, .tr), "820 KB")
        select("Kavramlar sınırlarda netleşir.")
        reader.highlight(lang: .tr)
        select("Dikkat sınırlı bir kaynaktır.")
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        let host = NSHostingView(rootView: BookInfoSheet(book: reader.book, store: store, lang: .tr))
        _ = window(host, size: CGSize(width: 380, height: 460))
        try await Task.sleep(for: .milliseconds(300))
        try snapshot(host, "peryda-mac-book-info.png")
        reader.showingInfo = false
    }

    // 3. Four highlighter colours: the one chosen is drawn, kept in the journal, and stays in use.
    func testAHighlightKeepsItsColour() throws {
        XCTAssertEqual(reader.highlightColor, "yellow")
        select("Kavramlar sınırlarda netleşir.")
        reader.highlight(lang: .tr)
        XCTAssertNil(reader.journal.first?.highlightColor, "yellow is not written")
        select("Dikkat sınırlı bir kaynaktır.")
        reader.highlight(lang: .tr, color: "pink")
        XCTAssertEqual(reader.journal.first?.highlightColor, "pink")
        XCTAssertEqual(reader.highlightColor, "pink", "now in use")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "highlightColor"), "pink", "for every book")
        select("Okumak yavaşlamaktır.")
        reader.highlight(lang: .tr)
        XCTAssertEqual(reader.journal.first?.highlightColor, "pink", "a click uses the colour in use")
        XCTAssertEqual(Set(reader.highlighterMarks(onPage: 1).map(\.color)), ["yellow", "pink"])
        XCTAssertEqual(store.journal(for: reader.book.id).filter { $0.highlightColor == "pink" }.count, 2, "kept on disk")
        // An unknown colour from elsewhere is yellow.
        XCTAssertNil(HighlightColor.stored("purple"))
        XCTAssertEqual(HighlightColor.id("purple"), "yellow")
    }

    // 3b. A click on Vurgula highlights; holding it two seconds opens the colours instead.
    func testHoldingVurgulaOpensTheColours() async throws {
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        select("Kavramlar sınırlarda netleşir.")
        let host = NSHostingView(rootView: HighlightButton(reader: reader, lang: .tr).environment(app).frame(width: 60, height: 40))
        let w = window(host, size: CGSize(width: 60, height: 40))
        try await Task.sleep(for: .milliseconds(200))
        let p = CGPoint(x: 30, y: 20)
        func ev(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        // A short click highlights.
        w.sendEvent(ev(.leftMouseDown))
        try await Task.sleep(for: .milliseconds(120))
        w.sendEvent(ev(.leftMouseUp))
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(reader.journal.count, 1, "a click highlights")
        // Held for 2.4 s: no highlight; the colours open beside the button.
        select("Dikkat sınırlı bir kaynaktır.")
        let before = NSApp.windows.filter { $0.isVisible }.count
        w.sendEvent(ev(.leftMouseDown))
        try await Task.sleep(for: .milliseconds(2400))
        w.sendEvent(ev(.leftMouseUp))
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(reader.journal.count, 1, "holding does not highlight")
        XCTAssertGreaterThan(NSApp.windows.filter { $0.isVisible }.count, before, "the colours open")
    }

    // 4. Page thumbnails: open for every book, and a click goes to the page.
    func testThumbnailsGoToThePage() async throws {
        XCTAssertFalse(reader.showThumbnails)
        reader.showThumbnails = true
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "thumbnailsOpen"), "remembered")
        XCTAssertNotNil(reader.thumbnail(2))
        XCTAssertTrue(reader.thumbnail(2) === reader.thumbnail(2), "drawn once")
        let host = NSHostingView(rootView: ThumbnailSidebar(reader: reader, lang: .tr).frame(width: 168, height: 700))
        _ = window(host, size: CGSize(width: 168, height: 700))
        try await Task.sleep(for: .milliseconds(400))
        // Page 2's thumbnail: below page 1's (14 points of padding, the picture, its number, 14 between).
        let w = try XCTUnwrap(host.window)
        let box = reader.pages[0]
        let thumb = 120 * box.height / box.width
        let y = 14 + thumb + 5 + 16 + 14 + thumb / 2
        let p = host.convert(CGPoint(x: 84, y: y), to: nil)
        func ev(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        NSApp.postEvent(ev(.leftMouseUp), atStart: false)
        w.sendEvent(ev(.leftMouseDown))
        CardButtonTests.deliverQueuedMouseEvents(to: w)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(reader.cameraCommand, .goToPage(2))
        try snapshot(host, "peryda-mac-thumbnails.png")
    }
}
