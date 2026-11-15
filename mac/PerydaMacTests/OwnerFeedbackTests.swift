import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Owner test 15 Nov on the Mac: the brush, "Vurgula" (highlight), region cards that show only their
/// picture, and a journal whose answers open on a click. Off-screen windows only.
@MainActor
final class OwnerFeedbackTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())

    var store: LibraryStore!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-feedback-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        let book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        let reader = self.reader!
        world = WorldView(model: reader) { id in AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {})) }
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1300, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
        world.layoutSubtreeIfNeeded()
    }

    override func tearDown() async throws {
        window.orderOut(nil)
    }

    private func event(_ type: NSEvent.EventType, at p: CGPoint, flags: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: p, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }

    private func pageView() throws -> PageView {
        try XCTUnwrap(world.documentView.subviews.compactMap { $0 as? PageView }.first { $0.number == 1 })
    }

    private func windowPoint(_ view: PageView, _ pagePoint: CGPoint) -> CGPoint {
        let n = view.geometry.normalized(fromPage: CGRect(origin: pagePoint, size: .zero))
        return view.convert(CGPoint(x: n.x * view.bounds.width, y: n.y * view.bounds.height), to: nil)
    }

    /// Ends of a sentence on page 1, in window points.
    private func sentence(_ text: String) throws -> (start: CGPoint, end: CGPoint, view: PageView) {
        let found = try XCTUnwrap(reader.document!.findString(text, withOptions: []).first)
        let page = try XCTUnwrap(found.pages.first)
        let view = try pageView()
        let b = found.bounds(for: page)
        return (windowPoint(view, CGPoint(x: b.minX + 1, y: b.midY)), windowPoint(view, CGPoint(x: b.maxX - 1, y: b.midY)), view)
    }

    private func select(_ text: String) throws {
        let s = try sentence(text)
        s.view.mouseDown(with: event(.leftMouseDown, at: s.start))
        s.view.mouseDragged(with: event(.leftMouseDragged, at: CGPoint(x: (s.start.x + s.end.x) / 2, y: s.start.y)))
        s.view.mouseDragged(with: event(.leftMouseDragged, at: s.end))
        s.view.mouseUp(with: event(.leftMouseUp, at: s.end))
    }

    private func snapshot(_ view: NSView, _ name: String) throws {
        view.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent(name))
    }

    // B. The brush: drag over a sentence, pull to the right, let go: a thread in the brush's colour.
    func testTheBrushMakesAThreadInItsColour() async throws {
        reader.tool = .brush
        reader.brushColor = .coral
        let s = try sentence("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        s.view.mouseDown(with: event(.leftMouseDown, at: s.start))
        s.view.mouseDragged(with: event(.leftMouseDragged, at: s.end))
        // Pulled well past the end of the line: the yarn leaves the page.
        for i in 1...4 {
            s.view.mouseDragged(with: event(.leftMouseDragged, at: CGPoint(x: s.end.x + Double(i) * 150, y: s.end.y)))
        }
        XCTAssertNotNil(reader.liveBrush, "the yarn follows the pointer")
        s.view.mouseUp(with: event(.leftMouseUp, at: CGPoint(x: s.end.x + 600, y: s.end.y)))
        await reader.cards.waitForIdle()
        let card = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(card.color, .coral)
        XCTAssertTrue(card.anchors.first?.selectedText.hasPrefix("Kavramlar") == true, card.anchors.first?.selectedText ?? "")
        XCTAssertNil(reader.liveBrush)
    }

    // D. "Vurgula": yellow on the page, a highlight in the journal; deleting the entry takes the mark away.
    func testAHighlightIsMarkedOnThePageAndKeptInTheJournal() async throws {
        try select("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        XCTAssertTrue(reader.canHighlight)

        // The menu, with Vurgula between "Özete kırp" and "Notum".
        let app = AppModel(store: store, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), lang: .tr)
        let menu = NSHostingView(rootView: SelectionMenuView(reader: reader, lang: .tr).environment(app).padding(20).background(Color.paper))
        menu.frame = CGRect(x: 0, y: 0, width: 560, height: 160)
        let menuWindow = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 560, height: 160), styleMask: [.borderless], backing: .buffered, defer: false)
        menuWindow.contentView = menu
        menuWindow.orderFrontRegardless()
        try await Task.sleep(for: .milliseconds(300))
        try snapshot(menu, "peryda-mac-menu-highlight.png")
        menuWindow.orderOut(nil)

        reader.highlight(lang: .tr)
        XCTAssertNil(reader.pending)
        let entry = try XCTUnwrap(reader.journal.first)
        XCTAssertEqual(entry.source, .highlight)
        XCTAssertTrue(entry.quote.hasPrefix("Kavramlar"))
        XCTAssertEqual(entry.text, "")
        XCTAssertEqual(entry.marks?.first?.pageNumber, 1)
        XCTAssertFalse(entry.marks?.first?.lineRects.isEmpty ?? true)
        XCTAssertEqual(reader.toast, UIText(.tr)["highlighted"])
        XCTAssertEqual(store.journal(for: reader.book.id).first?.marks, entry.marks, "kept on disk")

        world.sync()
        let page = try pageView()
        XCTAssertEqual(page.marks.count, 1)
        XCTAssertEqual(page.marks.first, entry.marks?.first?.lineRects)
        let image = NSImage(size: page.bounds.size)
        image.lockFocusFlipped(true)
        page.draw(page.bounds)
        image.unlockFocus()
        if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
            try rep.representation(using: .png, properties: [:])!.write(to: Self.outDir.appendingPathComponent("peryda-mac-page-highlight.png"))
            // The middle of the highlighted line is yellow (red and green high, blue lower).
            let r = entry.marks!.first!.lineRects.first!
            let x = Int((r.x + r.width / 2) * Double(rep.pixelsWide)), y = Int((r.y + r.height / 2) * Double(rep.pixelsHigh))
            var found = false
            for dx in stride(from: -40, through: 40, by: 2) {
                if let c = rep.colorAt(x: x + dx, y: y)?.usingColorSpace(.sRGB), c.blueComponent < c.redComponent - 0.15, c.greenComponent > 0.5 { found = true; break }
            }
            XCTAssertTrue(found, "yellow under the highlighted line")
        }

        reader.deleteJournal(entry.id)
        world.sync()
        XCTAssertTrue(page.marks.isEmpty, "deleting the entry takes the mark away")
    }

    /// A highlight covers whole words even when the selection starts and ends inside words.
    func testAHighlightCoversWholeWords() throws {
        try select("avramlar, birbirlerinden ayrıldıkları sınırlarda netl")
        let partial = try XCTUnwrap(reader.pending?.anchors.first)
        XCTAssertFalse(partial.selectedText.hasPrefix("Kavramlar"), "the selection itself starts inside the word: \(partial.selectedText)")
        reader.highlight(lang: .tr)
        let entry = try XCTUnwrap(reader.journal.first)
        XCTAssertTrue(entry.quote.hasPrefix("Kavramlar,"), entry.quote)
        XCTAssertTrue(entry.quote.contains("netleşir"), entry.quote)
        let mark = try XCTUnwrap(entry.marks?.first?.lineRects.first)
        let before = try XCTUnwrap(partial.lineRects.first)
        XCTAssertLessThan(mark.x, before.x, "the mark reaches back to the word's start")
        XCTAssertGreaterThan(mark.x + mark.width, before.x + before.width, "and on to its end")
    }

    func testHighlightIsOfferedOnlyForTextOnAPage() throws {
        let area = YarnAnchor(sourceType: .pdfArea, bookId: reader.book.id, pageNumber: 1, selectedText: "Hfe 4oward", lineRects: [], boundingRect: NormalizedRect(x: 0.1, y: 0.1, width: 0.3, height: 0.2), croppedImage: "data:image/png;base64,AAAA")
        reader.pending = PendingSelection(anchors: [area], rect: .zero)
        XCTAssertFalse(reader.canHighlight, "not for a region")
        let r = NormalizedRect(x: 0.1, y: 0.3, width: 0.5, height: 0.02)
        let text = YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: "Kavramlar", lineRects: [r], boundingRect: r)
        reader.pending = PendingSelection(anchors: [text], rect: .zero, parentCardId: "some-card")
        XCTAssertFalse(reader.canHighlight, "not for text inside a card or translation")
        reader.pending = PendingSelection(anchors: [text], rect: .zero)
        XCTAssertTrue(reader.canHighlight)
    }

    // A. A region's card shows its picture alone; the journal names the region instead of quoting it.
    func testARegionsCardShowsOnlyItsPicture() async throws {
        let size = CGSize(width: 600, height: 160)
        let picture = NSImage(size: size)
        picture.lockFocus()
        NSColor.white.setFill()
        CGRect(origin: .zero, size: size).fill()
        ("takes in the conduct of life are usually dangerous" as NSString).draw(at: CGPoint(x: 20, y: 70), withAttributes: [.font: NSFont(name: "Times New Roman", size: 26) ?? NSFont.systemFont(ofSize: 26)])
        picture.unlockFocus()
        let png = NSBitmapImageRep(data: picture.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        let area = YarnAnchor(sourceType: .pdfArea, bookId: reader.book.id, pageNumber: 1, selectedText: "takes in the conduct of life are usually dangerous to Hfe", lineRects: [], boundingRect: NormalizedRect(x: 0.1, y: 0.1, width: 0.6, height: 0.2), croppedImage: "data:image/png;base64," + png.base64EncodedString())
        reader.pending = PendingSelection(anchors: [area], rect: .zero)
        reader.create(color: .coral, kind: .quick(.coral))
        await reader.cards.waitForIdle()
        let card = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(reader.journalQuote(card.anchors, lang: .tr), UIText(.tr)["areaQuote"])
        reader.saveToJournal(card.id, lang: .tr)
        XCTAssertEqual(reader.journal.first?.quote, UIText(.tr)["areaQuote"], "the garbled text does not go to the journal")
        XCTAssertEqual(reader.journalState(card.id), .saved)

        let view = NSHostingView(rootView: YarnCardView(cardId: card.id, reader: reader, lang: .tr, openSettings: {}).padding(20).background(Color.paperSunken))
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 460, height: 420), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = view
        w.orderFrontRegardless()
        defer { w.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(400))
        try snapshot(view, "peryda-mac-area-card.png")
        func texts(_ v: NSView) -> [String] { ((v as? NSTextView)?.string).map { [$0] } ?? v.subviews.flatMap(texts) }
        XCTAssertFalse(texts(view).joined().contains("Hfe"), "no read-out text on the card")
    }

    // E. The journal shows passages; Pery's answer opens with a click and closes again.
    func testJournalAnswersOpenOnAClick() async throws {
        try select("Kavramlar, birbirlerinden ayrıldıkları sınırlarda netleşir.")
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        reader.saveToJournal(try XCTUnwrap(reader.cards.cards.first?.id), lang: .tr)
        reader.addNote("Kendi notum burada görünür.")
        try select("arasındaki fark, ancak ikisinin")
        reader.highlight(lang: .tr)
        XCTAssertEqual(reader.journal.count, 3)

        let panel = NSHostingView(rootView: JournalPanel(reader: reader, lang: .tr, openSettings: {}))
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 380, height: 760), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = panel
        w.orderFrontRegardless()
        defer { w.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(400))
        func answers() -> [String] {
            func walk(_ v: NSView) -> [String] { ((v as? AnswerTextView)?.string).map { [$0] } ?? v.subviews.flatMap(walk) }
            return walk(panel)
        }
        XCTAssertEqual(answers(), ["Kendi notum burada görünür."], "only the note's text is open")
        try snapshot(panel, "peryda-mac-journal-closed.png")

        // Click "Show Pery's answer".
        func controls(_ v: NSView) -> [NSControl] { ((v as? NSControl).map { [$0] } ?? []) + v.subviews.flatMap(controls) }
        // The disclosure is the one button at the entries' left edge (page links sit after the source label,
        // trash buttons at the right).
        let toggle = try XCTUnwrap(controls(panel).first { c in
            let f = c.convert(c.bounds, to: panel)
            return !(c is NSTextField) && f.minX < 24 && f.width > 60
        })
        CardButtonTests.deliverQueuedMouseEvents(to: nil)
        let p = toggle.convert(CGPoint(x: toggle.bounds.midX, y: toggle.bounds.midY), to: nil)
        NSApp.postEvent(event(.leftMouseUp, at: p).withWindow(w), atStart: false)
        w.sendEvent(event(.leftMouseDown, at: p).withWindow(w))
        CardButtonTests.deliverQueuedMouseEvents(to: w)
        try await Task.sleep(for: .milliseconds(300))
        panel.layoutSubtreeIfNeeded()
        XCTAssertEqual(answers().count, 2, "the thread's answer is open")
        XCTAssertTrue(answers().contains { $0.contains("komşularıyla") })
        try snapshot(panel, "peryda-mac-journal-open.png")
    }
}

private extension NSEvent {
    /// The same mouse event for another window.
    func withWindow(_ w: NSWindow) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: locationInWindow, modifierFlags: modifierFlags, timestamp: timestamp, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }
}
