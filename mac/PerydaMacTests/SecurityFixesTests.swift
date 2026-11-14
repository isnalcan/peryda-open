import AppKit
import Network
import PDFKit
import PerydaKit
import SwiftUI
import WebKit
import XCTest

/// The pre-release audit's fixes, on the app side: links, imports, deleting a book, the EPUB view's
/// network block, and page translation spending. Off-screen windows and temporary libraries only.
@MainActor
final class SecurityFixesTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let sampleEPUB = repo.appendingPathComponent("web/dev-samples/kenar.epub")

    func tempStore(_ name: String) throws -> LibraryStore {
        try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-\(name)-\(UUID().uuidString)"))
    }

    func epubBook(_ store: LibraryStore) throws -> BookRecord {
        try store.importBook(data: Data(contentsOf: Self.sampleEPUB), fileName: "kenar.epub", title: "Kenar", author: nil, pageCount: 2)
    }

    func pdf(pages: Int) throws -> Data {
        let source = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let doc = PDFDocument()
        for i in 0..<pages { doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: i) }
        return try XCTUnwrap(doc.dataRepresentation())
    }

    func waitUntil(_ timeout: Double = 8, _ check: () async -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTFail("timed out")
    }

    // MARK: M-3 links

    func testJournalTextKeepsItsEmphasisButNoLinks() {
        let text = "**Önemli**: [Re-verify your Gemini key](https://evil.example/k), [chapter 3](vscode://open), <https://evil.example/auto> ![x](https://evil.example/i.png)"
        let out = SelectableAnswer.attributed(text)
        var links = 0
        var bold = false
        out.enumerateAttributes(in: NSRange(location: 0, length: out.length)) { attrs, _, _ in
            if attrs[.link] != nil || attrs[.attachment] != nil { links += 1 }
            if let font = attrs[.font] as? NSFont, font.fontDescriptor.symbolicTraits.contains(.bold) { bold = true }
        }
        XCTAssertEqual(links, 0, "no run may open anything")
        XCTAssertTrue(out.string.contains("Re-verify your Gemini key"), "the words stay")
        XCTAssertFalse(out.string.contains("evil.example/k"), "the address does not")
        XCTAssertTrue(bold, "bold stays")
    }

    // MARK: M-14 and M-4 imports

    func testOnlyFilesOnThisMacAreImported() async throws {
        let app = AppModel(store: try tempStore("import"), settings: ByokSettings(), lang: .en)
        let link = try XCTUnwrap(URL(string: "https://evil.example/book.pdf"))
        let imported = await app.importFiles([link])
        XCTAssertNil(imported)
        XCTAssertEqual(app.lastError, UIText(.en)["unsupportedFile"])
        XCTAssertTrue(app.books.isEmpty)
    }

    func testAFileOverTheLimitIsNotRead() async throws {
        // A sparse file: over 2 GB long, taking no room on the disk.
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("huge-\(UUID().uuidString).pdf")
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: Data("%PDF-1.7".utf8)))
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(AppModel.maxImportMB) * 1024 * 1024 + 1)
        try handle.close()
        let app = AppModel(store: try tempStore("huge"), settings: ByokSettings(), lang: .en)
        let imported = await app.importFiles([url])
        XCTAssertNil(imported)
        XCTAssertEqual(app.lastError, UIText(.en)("fileTooLarge", ["n": 2048]))
        XCTAssertTrue(app.books.isEmpty)
    }

    // MARK: M-8 deleting a book

    func testDeletingABookRemovesEverythingKeptAboutIt() async throws {
        let store = try tempStore("delete")
        let batcher = TestBatcher()
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr, batcher: batcher)
        let book = try epubBook(store)
        app.reloadBooks()
        let reader = try XCTUnwrap(ReaderModel(epubBook: book, store: store, lang: .tr, settings: app.settings, streamer: InstantStreamer()))
        let cache = try XCTUnwrap(AppModel.epubCache).appendingPathComponent(book.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.path), "unpacked while reading")
        reader.translationTarget = .de
        UserDefaults.standard.set(["text": "Özet", "createdAt": 0.0], forKey: "journalSummary:\(book.id)")
        _ = await Covers.load(book, store: store)
        let marker = try XCTUnwrap(Covers.files(book)?.none)
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "a book without a cover is remembered as such")
        var waiting = YarnCard(bookId: book.id, color: .sky, kind: .translate, anchors: [])
        waiting.batchJob = "batches/left-behind"
        try store.saveCards([waiting], for: book.id)

        app.delete(book)
        for task in app.pendingWork { await task.value }
        XCTAssertTrue(app.books.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path), "the unpacked book")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "the cover")
        XCTAssertNil(UserDefaults.standard.object(forKey: "translateLang:\(book.id)"))
        XCTAssertNil(UserDefaults.standard.object(forKey: "journalSummary:\(book.id)"))
        let cancelled = await batcher.cancelled
        XCTAssertEqual(cancelled, ["batches/left-behind"], "Google stops the job")
        reader.close()
    }

    func testTheUnpackedBookGoesWhenItsLastReaderCloses() throws {
        let store = try tempStore("close")
        let book = try epubBook(store)
        let settings = ByokSettings(geminiApiKey: "placeholder-not-a-key")
        let first = try XCTUnwrap(ReaderModel(epubBook: book, store: store, lang: .tr, settings: settings, streamer: InstantStreamer()))
        let second = try XCTUnwrap(ReaderModel(epubBook: book, store: store, lang: .tr, settings: settings, streamer: InstantStreamer()))
        let cache = try XCTUnwrap(AppModel.epubCache).appendingPathComponent(book.id)
        first.close()
        first.close()
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.path), "another window still reads it")
        second.close()
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try store.fileURL(for: book).path), "the book itself stays")
    }

    // MARK: M-5 and M-13 the EPUB view

    func host(_ reader: ReaderModel, rules: String) -> (NSWindow, WKWebView?) {
        let window = NSWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        var view = EpubWebView(reader: reader, fontScale: 100, dark: false, command: .constant(nil), onSelect: { _, _ in })
        view.rules = rules
        window.contentView = NSHostingView(rootView: view)
        window.layoutIfNeeded()
        func find(_ v: NSView) -> WKWebView? { (v as? WKWebView) ?? v.subviews.lazy.compactMap(find).first }
        return (window, window.contentView.flatMap(find))
    }

    func testWithoutItsNetworkBlockTheBookIsNotShown() async throws {
        let store = try tempStore("blocked")
        let reader = try XCTUnwrap(ReaderModel(epubBook: try epubBook(store), store: store, lang: .tr, settings: ByokSettings(), streamer: InstantStreamer()))
        defer { reader.close() }
        let (window, web) = host(reader, rules: "this is not a rule list")
        _ = window
        try await waitUntil { reader.epubBlocked }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(try XCTUnwrap(web).url, "nothing was loaded")
    }

    func testOnlyTheBooksOwnPageMayLoad() {
        let page = URL(fileURLWithPath: "/tmp/peryda/epub/book/peryda-book.html")
        XCTAssertTrue(EpubWebView.allows(page, type: .other, page: page))
        XCTAssertTrue(EpubWebView.allows(URL(string: "file:///tmp/peryda/epub/book/../book/peryda-book.html#c2"), type: .other, page: page))
        XCTAssertFalse(EpubWebView.allows(URL(fileURLWithPath: "/tmp/peryda/epub/book/OEBPS/c1.xhtml"), type: .other, page: page), "another file in the book")
        XCTAssertFalse(EpubWebView.allows(URL(fileURLWithPath: "/Users/someone/Desktop/dropped.html"), type: .other, page: page), "a file dropped on the view")
        XCTAssertFalse(EpubWebView.allows(page, type: .linkActivated, page: page))
        XCTAssertFalse(EpubWebView.allows(URL(string: "https://evil.example/"), type: .other, page: page))
        XCTAssertFalse(EpubWebView.allows(nil, type: .other, page: page))
    }

    /// The rule list blocks by default: a page behind it reaches no server (here a listener on this
    /// Mac), and the same page without it does, so the listener is known to work.
    func testTheBlockStopsRequestsOfAnyScheme() async throws {
        let hits = Hits()
        let listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { connection in
            hits.add()
            connection.start(queue: .global())
            connection.cancel()
        }
        listener.start(queue: .global())
        defer { listener.cancel() }
        try await waitUntil { (listener.port?.rawValue ?? 0) != 0 }
        let port = try XCTUnwrap(listener.port?.rawValue)

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("peryda-block-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let page = dir.appendingPathComponent("page.html")
        try """
        <html><body><p>Metin</p>
        <img src="http://127.0.0.1:\(port)/pixel.png"><img src="ftp://127.0.0.1:\(port)/f.png">
        <svg><image href="http://127.0.0.1:\(port)/svg.png"/></svg><table background="http://127.0.0.1:\(port)/t.png"><tr><td>x</td></tr></table>
        </body></html>
        """.write(to: page, atomically: true, encoding: .utf8)
        let window = NSWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)

        func load(blocked: Bool) async throws -> WKWebView {
            let config = WKWebViewConfiguration()
            config.defaultWebpagePreferences.allowsContentJavaScript = false
            config.websiteDataStore = .nonPersistent()
            if blocked {
                let list = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "peryda-offline-test", encodedContentRuleList: EpubWebView.offlineRules)
                config.userContentController.add(try XCTUnwrap(list))
            }
            let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 600, height: 400), configuration: config)
            window.contentView = web
            web.loadFileURL(page, allowingReadAccessTo: dir)
            try await waitUntil { !web.isLoading && web.url != nil }
            return web
        }

        let blocked = try await load(blocked: true)
        try await Task.sleep(for: .seconds(1.5))
        XCTAssertEqual(hits.count, 0, "nothing left the page")
        let text = try await blocked.callAsyncJavaScript("return document.body.innerText", contentWorld: .defaultClient) as? String
        XCTAssertEqual(text?.contains("Metin"), true, "the page itself loads")

        _ = try await load(blocked: false)
        try await waitUntil(5) { hits.count > 0 }
        window.contentView = nil
    }

    // MARK: M-6 page translation spending

    func translatingReader(pages: Int, batcher: TestBatcher, streamer: RecordingInstantStreamer) throws -> ReaderModel {
        let store = try tempStore("spend")
        let book = try store.importBook(data: try pdf(pages: pages), fileName: "uzun.pdf", title: "Uzun", author: nil, pageCount: pages)
        return try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-placeholder-not-real"), streamer: streamer, batcher: batcher))
    }

    func testABatchThatCannotBeMadeOffersADirectTranslationInstead() async throws {
        let batcher = TestBatcher()
        await batcher.failCreating(AIError(.network))
        let streamer = RecordingInstantStreamer()
        let reader = try translatingReader(pages: 4, batcher: batcher, streamer: streamer)
        reader.translateRange(1...4)
        try await waitUntil { (1...4).allSatisfy { reader.translation(of: $0)?.messages.last?.state == .error } }
        XCTAssertTrue(streamer.requests.isEmpty, "nothing is sent again at full price on its own")
        let t = UIText(.tr)
        XCTAssertEqual(reader.translation(of: 1)?.messages.last?.content, "batch")
        XCTAssertEqual(TranslatedPageView.errorText("batch", t), t["batchFailed"])
        reader.cards.retranslate(try XCTUnwrap(reader.translation(of: 2)).id)
        await reader.cards.waitForIdle()
        XCTAssertEqual(streamer.requests.count, 1, "Retry translates that page, directly")
        reader.close()
    }

    func testARangeIsAtMostTwoHundredPages() async throws {
        let batcher = TestBatcher()
        let reader = try translatingReader(pages: 210, batcher: batcher, streamer: RecordingInstantStreamer())
        reader.translateRange(1...210)
        try await waitUntil { await batcher.jobs.count == 1 }
        let job = await batcher.jobs[0]
        XCTAssertEqual(job.count, 200, "text pages fit in one job")
        XCTAssertNotNil(reader.translation(of: 200))
        XCTAssertNil(reader.translation(of: 201))
        XCTAssertEqual(TranslateRangeSheet.upperLimit(from: 5, pageCount: 260), 204)
        XCTAssertEqual(TranslateRangeSheet.upperLimit(from: 100, pageCount: 260), 260)
        reader.close()
    }
}

/// Counts connections to the test listener.
final class Hits: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var count: Int { lock.withLock { n } }
    func add() { lock.withLock { n += 1 } }
}
