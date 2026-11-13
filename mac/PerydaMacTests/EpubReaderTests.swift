import AppKit
import PerydaKit
import SwiftUI
import WebKit
import XCTest

/// The EPUB reader in an off-screen window: selection, highlight, position and the book's own scripts.
@MainActor
final class EpubReaderTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var app: AppModel!
    var reader: ReaderModel!
    var window: NSWindow!
    var selections: [(EpubWebView.Selection, CGRect)] = []

    override func setUp() async throws {
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-epub-tests-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/kenar.epub"))
        let book = try store.importBook(data: data, fileName: "kenar.epub", title: "Kenar Notları Üzerine", author: nil, pageCount: 2)
        let settings = ByokSettings(geminiApiKey: "placeholder-not-a-key")
        app = AppModel(store: store, settings: settings, lang: .tr)
        reader = try XCTUnwrap(ReaderModel(epubBook: book, store: store, lang: .tr, settings: settings, streamer: InstantStreamer()))
        window = NSWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1200, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
    }

    /// Hosts only the book page, reporting selections to the test.
    func hostPage() -> WKWebView? {
        let view = PageHost(reader: reader) { [weak self] s, r in self?.selections.append((s, r)) }
        window.contentView = NSHostingView(rootView: view)
        window.layoutIfNeeded()
        return webView()
    }

    func webView() -> WKWebView? {
        func find(_ v: NSView) -> WKWebView? {
            if let w = v as? WKWebView { return w }
            for s in v.subviews { if let w = find(s) { return w } }
            return nil
        }
        return window.contentView.flatMap(find)
    }

    struct PageHost: View {
        let reader: ReaderModel
        let onSelect: (EpubWebView.Selection, CGRect) -> Void
        @State var command: EpubWebView.Command?
        var body: some View { EpubWebView(reader: reader, fontScale: 100, dark: false, command: $command, onSelect: onSelect) }
    }

    func js(_ web: WKWebView, _ source: String) async throws -> Any? {
        try await web.callAsyncJavaScript(source, contentWorld: .defaultClient)
    }

    func waitFor(_ timeout: Double = 8, _ check: () async throws -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if try await check() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("timed out")
    }

    func ready(_ web: WKWebView) async throws {
        try await waitFor {
            (try? await js(web, "return document.readyState === 'complete' && typeof perydaHighlight === 'function' && !!document.querySelector('section.peryda-chapter')")) as? Bool == true
        }
    }

    /// Selects `length` characters of the first long text node in a chapter and releases the mouse.
    let selectScript = """
    const sec = document.querySelector(`section.peryda-chapter[data-chapter="${chapter}"]`);
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n && n.data.trim().length < 40) n = walker.nextNode();
    const lead = n.data.length - n.data.trimStart().length;
    const r = document.createRange(); r.setStart(n, lead); r.setEnd(n, lead + length);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return r.toString();
    """

    func testSelectionBecomesAnchorAndHighlight() async throws {
        let web = try XCTUnwrap(hostPage())
        try await ready(web)
        // The book's own script must not have run.
        let scriptRan = try await js(web, "return document.body.innerText.includes('SCRIPT RAN')") as? Bool
        XCTAssertEqual(scriptRan, false)

        let picked = try await web.callAsyncJavaScript(selectScript, arguments: ["chapter": 1, "length": 24], contentWorld: .defaultClient) as? String
        try await waitFor { !selections.isEmpty }
        let (sel, rect) = try XCTUnwrap(selections.first)
        XCTAssertEqual(sel.chapter, 1)
        XCTAssertFalse(sel.context.isEmpty, "the chapter's text goes with the selection")
        XCTAssertLessThanOrEqual(sel.context.count, YarnAnchor.contextLength)
        XCTAssertEqual(sel.text, picked?.trimmingCharacters(in: .whitespaces))
        XCTAssertEqual(sel.end - sel.start, 24)
        XCTAssertGreaterThan(rect.width, 0)
        let sliced = try await web.callAsyncJavaScript(
            "return document.querySelector(`section.peryda-chapter[data-chapter=\"${c}\"]`).textContent.slice(s, e)",
            arguments: ["c": sel.chapter, "s": sel.start, "e": sel.end], contentWorld: .defaultClient) as? String
        XCTAssertEqual(sliced, picked)

        // Opening a thread from it stores the locator and paints the passage.
        let anchor = YarnAnchor(sourceType: .epubText, bookId: reader.book.id, pageNumber: sel.chapter + 1, selectedText: sel.text, lineRects: [], boundingRect: .zero, cfi: EPUBBook.locator(chapter: sel.chapter, start: sel.start, end: sel.end))
        reader.pending = PendingSelection(anchors: [anchor], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        let card = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(card.anchors.first?.cfi, "peryda:c=1;s=\(sel.start);e=\(sel.end)")
        try await waitFor { (try? await js(web, "return document.querySelectorAll('mark.peryda-mark').length")) as? Int ?? 0 > 0 }
        let marked = try await js(web, "return [...document.querySelectorAll('mark.peryda-mark')].map(m => m.textContent).join('')") as? String
        XCTAssertEqual(marked, picked)
        let markCard = try await js(web, "return document.querySelector('mark.peryda-mark').dataset.card") as? String
        XCTAssertEqual(markCard, card.id)

        // Clicking the highlight focuses its card.
        reader.focusedCard = nil
        _ = try await js(web, "document.querySelector('mark.peryda-mark').click(); return true")
        try await waitFor { reader.focusedCard == card.id }

        // Highlighting again does not nest or duplicate marks.
        _ = try await js(web, "perydaHighlight([]); return true")
        let cleared = try await js(web, "return document.querySelectorAll('mark.peryda-mark').length") as? Int
        XCTAssertEqual(cleared, 0)
        let restored = try await web.callAsyncJavaScript(
            "return document.querySelector(`section.peryda-chapter[data-chapter=\"1\"]`).textContent.slice(s, e)",
            arguments: ["s": sel.start, "e": sel.end], contentWorld: .defaultClient) as? String
        XCTAssertEqual(restored, picked, "removing marks must leave the text as it was")
    }

    func testScrollSavesPositionAndReopensThere() async throws {
        let web = try XCTUnwrap(hostPage())
        try await ready(web)
        _ = try await js(web, "perydaScrollTo(1, 0); window.dispatchEvent(new Event('scroll')); return true")
        try await waitFor { EPUBBook.parseLocator(self.store.position(for: self.reader.book.id)?.cfi)?.chapter == 1 }
        XCTAssertEqual(reader.epubChapter, 2)

        // A second window on the same book opens at the saved chapter.
        let again = try XCTUnwrap(ReaderModel(epubBook: reader.book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        reader = again
        let web2 = try XCTUnwrap(hostPage())
        try await ready(web2)
        try await waitFor {
            let top = try await web2.callAsyncJavaScript(
                "const r = document.querySelector('section.peryda-chapter[data-chapter=\"1\"]').getBoundingClientRect(); return r.top < 120 && r.bottom > 0",
                contentWorld: .defaultClient) as? Bool
            return top == true
        }
    }

    func testOfflineRulesCompile() async throws {
        let list = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "peryda-offline-test", encodedContentRuleList: EpubWebView.offlineRules)
        XCTAssertNotNil(list)
    }

    /// The whole surface, lane included, rendered for a visual check.
    func testSurfaceSnapshot() async throws { try await snapshot(dark: false) }
    func testSurfaceSnapshotDark() async throws { try await snapshot(dark: true) }

    func snapshot(dark: Bool) async throws {
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let web = try XCTUnwrap(hostPage())
        try await ready(web)
        _ = try await web.callAsyncJavaScript(selectScript, arguments: ["chapter": 0, "length": 30], contentWorld: .defaultClient)
        try await waitFor { !selections.isEmpty }
        let sel = selections[0].0
        let anchor = YarnAnchor(sourceType: .epubText, bookId: reader.book.id, pageNumber: 1, selectedText: sel.text, lineRects: [], boundingRect: .zero, cfi: EPUBBook.locator(chapter: sel.chapter, start: sel.start, end: sel.end))
        reader.pending = PendingSelection(anchors: [anchor], rect: .zero)
        reader.create(color: .sky, kind: .quick(.sky))
        await reader.cards.waitForIdle()

        let surface = NavigationStack { EpubReaderSurface(reader: reader) }.environment(app)
        window.contentView = NSHostingView(rootView: surface)
        window.layoutIfNeeded()
        let web2 = try XCTUnwrap(webView())
        try await ready(web2)
        try await waitFor { (try? await js(web2, "return document.querySelectorAll('mark.peryda-mark').length")) as? Int ?? 0 > 0 }
        try await Task.sleep(for: .milliseconds(400))
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        let page = try await web2.takeSnapshot(configuration: nil)
        let canvas = NSImage(size: content.bounds.size)
        canvas.lockFocus()
        NSImage(cgImage: rep.cgImage!, size: content.bounds.size).draw(in: content.bounds)
        let frame = web2.convert(web2.bounds, to: content)
        page.draw(in: CGRect(x: frame.minX, y: content.bounds.height - frame.maxY, width: frame.width, height: frame.height))
        canvas.unlockFocus()
        let png = NSBitmapImageRep(data: canvas.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        try png.write(to: Self.outDir.appendingPathComponent(dark ? "epub-surface-dark.png" : "epub-surface.png"))
    }
}
