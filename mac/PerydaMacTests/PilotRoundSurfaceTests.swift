import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// The 0.1.3 reader round (first shipped on the web), on the Mac surface in an off-screen window:
/// the left margin lane, threads drawing out and reeling back, highlights on translated pages and
/// "Remove highlight", Focus and Map, the journal's Escape.
@MainActor
final class PilotRoundSurfaceTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: "pagedReading")
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-pilot-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        let book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        try open(book)
    }

    func open(_ book: BookRecord) throws {
        window?.orderOut(nil)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(activeProvider: .gemini, geminiApiKey: "AIza-placeholder-not-real"), streamer: RecordingInstantStreamer()))
        let reader = self.reader!
        var worldRef: WorldView?
        world = WorldView(model: reader) { id in
            let select: (String, String, CGRect) -> Void = { id, text, rect in worldRef?.cardTextSelected(id, text: text, windowRect: rect) }
            if reader.cards.cards.first(where: { $0.id == id })?.translatedPage != nil {
                return AnyView(TranslatedPageView(cardId: id, reader: reader, lang: .tr, openSettings: {}, onSelectText: select))
            }
            return AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {}, onSelectText: select))
        }
        worldRef = world
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1600, height: 1000), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
        world.layoutSubtreeIfNeeded()
    }

    override func tearDown() async throws {
        window.orderOut(nil)
        // Choosing a colour is remembered for every book: leave the default for the other tests.
        UserDefaults.standard.removeObject(forKey: "highlightColor")
    }

    func settle() async {
        await reader.cards.waitForIdle()
        world.sync()
        for _ in 0..<3 {
            window.displayIfNeeded()
            try? await Task.sleep(for: .milliseconds(40))
            world.sync()
        }
    }

    func snapshot(_ name: String) throws {
        window.displayIfNeeded()
        let rep = try XCTUnwrap(world.bitmapImageRepForCachingDisplay(in: world.bounds))
        world.cacheDisplay(in: world.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent(name))
    }

    /// A passage of page 1 as the selection menu gets it.
    func select(_ text: String) throws {
        let doc = try XCTUnwrap(reader.document)
        let found = try XCTUnwrap(doc.findString(text, withOptions: []).first)
        let page = try XCTUnwrap(found.pages.first)
        let geometry = PageGeometry(page: page)
        let rects = found.selectionsByLine().map { geometry.normalized(fromPage: $0.bounds(for: page).insetBy(dx: -1, dy: -1)) }
        reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: text, lineRects: rects, boundingRect: Geometry.union(rects))], rect: .zero)
    }

    func cardViews() -> [NSView] {
        world.documentView.subviews.filter { $0 is ZoomedHostingView<AnyView> }
    }

    // MARK: Left lane

    func testACrowdedPassageOpensItsThreadOnTheLeftWithItsYarnOnTheCardsRightEdge() async throws {
        try select("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        try select("arasındaki fark, ancak ikisinin")
        reader.create(color: .coral, kind: .quick(.coral))
        reader.pending = nil
        await settle()
        let right = try XCTUnwrap(reader.cards.cards.first)
        let left = try XCTUnwrap(reader.cards.cards.last)
        let pr = try XCTUnwrap(reader.placements[right.id])
        let pl = try XCTUnwrap(reader.placements[left.id])
        XCTAssertEqual(pr.x, Geometry.laneX(pageWidth: reader.pageWidth))
        XCTAssertEqual(pl.x, -SharedContract.tokens.geometry.laneOffset - left.width)
        // The left card's yarn leaves the passage's left end and reaches the card's right edge.
        let seg = try XCTUnwrap(reader.segments.first { $0.cardId == left.id })
        XCTAssertEqual(seg.to.x, pl.x + left.width, accuracy: 0.5)
        XCTAssertLessThan(seg.from.x, reader.pageWidth / 2)
        // The world reaches far enough left to show it.
        XCTAssertLessThanOrEqual(reader.worldRect.minX, pl.x)
        reader.cameraCommand = .map
        world.sync()
        try await Task.sleep(for: .milliseconds(100))
        try snapshot("peryda-mac-left-lane.png")
    }

    // MARK: Motion

    func testThreadsInTheBookOpenAsTheyAreAndNewOnesDrawOutThenReelBack() async throws {
        try select("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        reader.pending = nil
        await reader.cards.waitForIdle()
        // Reopen the book: its thread is simply there.
        try open(reader.book)
        await settle()
        let saved = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertTrue(world.yarnView.progress.isEmpty, "nothing replays on open")
        XCTAssertTrue(cardViews().allSatisfy { $0.alphaValue == 1 })

        // A new thread: its yarn starts undrawn and its card waits.
        try select("arasındaki fark, ancak ikisinin")
        reader.create(color: .coral, kind: .quick(.coral))
        reader.pending = nil
        world.sync()
        let fresh = try XCTUnwrap(reader.cards.cards.first { $0.id != saved.id })
        let start = try XCTUnwrap(world.yarnView.progress[fresh.id])
        XCTAssertLessThan(start, 0.2)
        XCTAssertNil(world.yarnView.progress[saved.id], "the old thread does not move")
        try await Task.sleep(for: .milliseconds(150))
        world.refreshYarns(dt: 1.0 / 60)
        let mid = try XCTUnwrap(world.yarnView.progress[fresh.id])
        XCTAssertGreaterThan(mid, start)
        try snapshot("peryda-mac-thread-drawing-out.png")
        try await Task.sleep(for: .milliseconds(600))
        world.refreshYarns(dt: 1.0 / 60)
        XCTAssertNil(world.yarnView.progress[fresh.id], "fully drawn")
        XCTAssertTrue(cardViews().allSatisfy { $0.alphaValue > 0.99 }, "every card faded in")

        // Folding it: the yarn reels back from where it was, and the card fades where it stood.
        reader.cards.setCollapsed(fresh.id, true)
        world.sync()
        XCTAssertFalse(world.yarnView.closing.isEmpty)
        XCTAssertTrue(world.documentView.subviews.contains { $0 is NSImageView }, "a fading picture of the card")
        try await Task.sleep(for: .milliseconds(500))
        world.refreshYarns(dt: 1.0 / 60)
        XCTAssertTrue(world.yarnView.closing.isEmpty)
        XCTAssertNil(world.yarnView.progress[fresh.id])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(world.documentView.subviews.contains { $0 is NSImageView }, "the picture is gone")
        // Its knot by the passage brings it back.
        XCTAssertEqual(reader.knots(onPage: 1, lang: .tr).map(\.cardId), [fresh.id])
    }

    // MARK: Highlights

    func testRemoveHighlightOnThePageTakesOnlyTheOverlappedOne() async throws {
        try select("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        XCTAssertTrue(reader.removableHighlights.isEmpty)
        reader.highlight(lang: .tr)
        try select("arasındaki fark, ancak ikisinin")
        reader.highlight(lang: .tr, color: "green")
        XCTAssertEqual(reader.journal.filter { $0.source == .highlight }.count, 2)
        try select("birbirlerinden ayrıldıkları")
        XCTAssertEqual(reader.removableHighlights.count, 1)
        try snapshot("peryda-mac-remove-highlight-offered.png")
        reader.removeHighlights(lang: .tr)
        XCTAssertNil(reader.pending)
        let left = reader.journal.filter { $0.source == .highlight }
        XCTAssertEqual(left.map(\.highlightColor), ["green"])
        XCTAssertEqual(reader.toast, UIText(.tr)["highlightRemoved"])
    }

    func testHighlightOnATranslatedPageIsKeptByItsWordsAndCanBeRemoved() async throws {
        reader.startTranslating(at: 1)
        try await waitUntil { self.reader.translation(of: 1)?.messages.last?.role == .assistant && self.reader.translation(of: 1)?.messages.last?.state == nil }
        await settle()
        let translation = try XCTUnwrap(reader.translation(of: 1))
        let quote = "Dikkat sınırlı bir kaynaktır."
        let anchor = YarnAnchor(sourceType: .card, bookId: reader.book.id, pageNumber: 0, selectedText: quote, lineRects: [], boundingRect: NormalizedRect(x: 0, y: 0, width: 1, height: 1), sourceCardId: translation.id)
        reader.pending = PendingSelection(anchors: [anchor], rect: .zero, parentCardId: translation.id)
        XCTAssertTrue(reader.canHighlight, "Vurgula on a translated page")
        reader.highlight(lang: .tr, color: "pink")
        let entry = try XCTUnwrap(reader.journal.first { $0.source == .highlight })
        XCTAssertEqual(entry.cardId, translation.id)
        XCTAssertEqual(entry.pageNumber, 1)
        XCTAssertNil(entry.marks, "no PDF geometry: it is never drawn on the PDF page")
        XCTAssertEqual(entry.highlightColor, "pink")
        XCTAssertTrue(reader.highlighterMarks(onPage: 1).isEmpty)
        XCTAssertEqual(reader.translationHighlights(translation.id).map(\.id), [entry.id])
        XCTAssertEqual(reader.journalState(translation.id), .notSaved, "a highlight is not the card's own journal entry")

        // The translated page draws it, and a selection over it offers "Remove highlight".
        await settle()
        let text = try XCTUnwrap(answerTextViews().first { $0.string.contains(quote) })
        XCTAssertEqual(text.marks.compactMap(\.highlightId), [entry.id])
        let range = (text.string as NSString).range(of: "sınırlı")
        XCTAssertEqual(text.highlightIds(overlapping: range), [entry.id])
        XCTAssertTrue(text.highlightIds(overlapping: (text.string as NSString).range(of: "Yavaş")).isEmpty)
        try snapshot("peryda-mac-translated-highlight.png")
        reader.pending = PendingSelection(anchors: [anchor], rect: .zero, parentCardId: translation.id, translationHighlightIds: [entry.id])
        XCTAssertEqual(reader.removableHighlights, [entry.id])
        reader.removeHighlights(lang: .tr)
        XCTAssertTrue(reader.translationHighlights(translation.id).isEmpty)
    }

    func answerTextViews() -> [AnswerTextView] {
        func all(_ v: NSView) -> [AnswerTextView] { ((v as? AnswerTextView).map { [$0] } ?? []) + v.subviews.flatMap(all) }
        return all(world.documentView)
    }

    func waitUntil(_ timeout: Double = 5, _ check: () async -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if await check() { return }
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTFail("timed out")
    }

    // MARK: Cameras

    func testFocusStopsAt100PercentAndMapFitsBothLanes() async throws {
        try select("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        try select("arasındaki fark, ancak ikisinin")
        reader.create(color: .coral, kind: .quick(.coral))
        reader.pending = nil
        await settle()
        world.perform(.focus, animated: false)
        XCTAssertLessThanOrEqual(world.scrollView.magnification, 1.0001, "a wide window no longer blows the page up")
        world.perform(.map, animated: false)
        XCTAssertLessThanOrEqual(world.scrollView.magnification, 0.8501)
        let visible = world.scrollView.contentView.bounds
        let content = reader.shownBounds
        XCTAssertLessThanOrEqual(visible.minX, content.minX + 0.5, "the left lane is in view")
        XCTAssertGreaterThanOrEqual(visible.maxX, content.maxX - 0.5, "the right lane is in view")
    }

    // MARK: Journal

    func testEscapeClosesTheJournalButNeverWhileTypingOrWithTheMenuOpen() throws {
        reader.showJournal = true
        func escape() -> NSEvent {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
        }
        window.makeKey()
        let field = NSTextView()
        world.addSubview(field)
        window.makeFirstResponder(field)
        XCTAssertFalse(JournalEscape.closes(reader: reader, event: escape()), "typing: the draft stays")
        window.makeFirstResponder(nil)
        try select("Kavramlar")
        XCTAssertFalse(JournalEscape.closes(reader: reader, event: escape()), "the selection menu closes first")
        reader.pending = nil
        XCTAssertTrue(JournalEscape.closes(reader: reader, event: escape()))
        field.removeFromSuperview()
    }
}

/// EPUB: the contents menu and previous/next chapter go through one jump, and a journal entry's
/// number is its chapter.
@MainActor
final class EpubChapterTests: XCTestCase {
    func testGoingToAChapterJumpsThereWithinTheBook() throws {
        let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-epub-ch-\(UUID().uuidString)"))
        let data = try Data(contentsOf: PilotRoundSurfaceTests.repo.appendingPathComponent("web/dev-samples/kenar.epub"))
        let book = try store.importBook(data: data, fileName: "kenar.epub", title: "Kenar", author: nil, pageCount: 2)
        let reader = try XCTUnwrap(ReaderModel(epubBook: book, store: store, lang: .tr, settings: ByokSettings(), streamer: InstantStreamer()))
        let count = try XCTUnwrap(reader.epub?.chapters.count)
        XCTAssertGreaterThan(count, 1)
        XCTAssertFalse(reader.epubReady, "Opening book… until the page has loaded")
        reader.goToChapter(2)
        XCTAssertEqual(reader.epubChapter, 2)
        XCTAssertEqual(reader.epubJump?.chapter, 1, "the page counts chapters from 0")
        XCTAssertEqual(reader.epubJump?.start, 0)
        let first = reader.epubJump
        reader.goToChapter(2)
        XCTAssertNotEqual(reader.epubJump, first, "the same chapter again still jumps")
        reader.goToChapter(count + 5)
        XCTAssertEqual(reader.epubChapter, count)
        reader.goToChapter(-3)
        XCTAssertEqual(reader.epubChapter, 1)
    }
}
