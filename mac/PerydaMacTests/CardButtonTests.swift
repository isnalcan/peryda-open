import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Borderless and far off every screen, so it is never seen, but it is ordered in like a real window
/// and so receives clicks the way the app's window does.
final class OffscreenKeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Clicks a card's controls with real mouse events through the window, at several zoom levels.
/// (Bug found 12 Nov: the buttons worked only at exactly 100%.)
@MainActor
final class CardButtonTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    var store: LibraryStore!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    /// A two-page book: the sample page twice.
    func twoPagePDF() throws -> Data {
        let source = try XCTUnwrap(PDFDocument(url: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf")))
        let doc = PDFDocument()
        doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: 0)
        doc.insert(try XCTUnwrap(source.page(at: 0)?.copy() as? PDFPage), at: 1)
        return try XCTUnwrap(doc.dataRepresentation())
    }

    override func setUp() async throws {
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-buttons-\(UUID().uuidString)"))
        let book = try store.importBook(data: try twoPagePDF(), fileName: "iki.pdf", title: "İki Sayfa", author: nil, pageCount: 2)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        let reader = self.reader!
        world = WorldView(model: reader) { id in
            AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {}))
        }
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1400, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
        world.layoutSubtreeIfNeeded()
    }

    override func tearDown() async throws {
        window.orderOut(nil)
    }

    func mouse(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }

    func click(_ windowPoint: CGPoint) async {
        Self.deliverQueuedMouseEvents(to: nil)
        // A button tracks the press in its own loop and waits for the release there.
        NSApp.postEvent(mouse(.leftMouseUp, windowPoint), atStart: false)
        window.sendEvent(mouse(.leftMouseDown, windowPoint))
        // If nothing took the release (not a button), deliver it as the app's event loop would.
        Self.deliverQueuedMouseEvents(to: window)
        try? await Task.sleep(for: .milliseconds(150))
    }

    /// There is no running event loop in tests: queued mouse events are delivered (or dropped) here.
    static func deliverQueuedMouseEvents(to window: NSWindow?) {
        while let e = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDown, .leftMouseDragged], until: Date(), inMode: .default, dequeue: true) {
            window?.sendEvent(e)
        }
    }

    func cardView(_ cardId: String) throws -> NSView {
        world.sync()
        let p = try XCTUnwrap(reader.placements[cardId])
        return try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> && abs($0.frame.minX - p.x) < 1 && abs($0.frame.minY - p.y) < 1 })
    }

    /// Window point of a header button, counted from the right (0 = close, 1 = fold, 2 = save, 3 = unpin).
    func headerButton(_ cardId: String, fromRight index: Int) throws -> CGPoint {
        let view = try cardView(cardId)
        return world.documentView.convert(CGPoint(x: view.frame.maxX - 18 - Double(index) * 32, y: view.frame.minY + 18), to: nil)
    }

    /// Zooms and scrolls so the card is in view, then lets the card lay out.
    func zoom(_ m: Double, onto cardId: String) async throws {
        world.scrollView.magnification = m
        let view = try cardView(cardId)
        world.scrollView.contentView.scroll(to: CGPoint(x: max(0, view.frame.minX - 200), y: max(0, view.frame.minY - 100)))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        window.displayIfNeeded()
        view.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
    }

    func makeCard(anchors: [YarnAnchor]) async throws -> YarnCard {
        reader.pending = PendingSelection(anchors: anchors, rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await reader.cards.waitForIdle()
        reader.pending = nil
        world.sync()
        window.displayIfNeeded()
        return try XCTUnwrap(reader.cards.cards.last)
    }

    func anchor(page: Int, y: Double, text: String) -> YarnAnchor {
        let r = NormalizedRect(x: 0.1, y: y, width: 0.6, height: 0.02)
        return YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: page, selectedText: text, lineRects: [r], boundingRect: r)
    }

    func testHarnessClicksAPlainButton() async throws {
        final class Box { var tapped = 0 }
        let box = Box()
        let w = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        w.contentView = NSHostingView(rootView: Button("x") { box.tapped += 1 }.buttonStyle(.borderless).frame(width: 400, height: 300))
        w.orderFrontRegardless()
        w.layoutIfNeeded()
        let p = CGPoint(x: 200, y: 150)
        Self.deliverQueuedMouseEvents(to: nil)
        NSApp.postEvent(NSEvent.mouseEvent(with: .leftMouseUp, location: p, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
        w.sendEvent(NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
        try await Task.sleep(for: .milliseconds(150))
        w.orderOut(nil)
        XCTAssertEqual(box.tapped, 1, "the harness itself must be able to click")
    }

    func testFoldButtonWorksAtEveryZoom() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        for m in [1.0, 0.63, 0.4, 1.5, 2.2] {
            reader.cards.setCollapsed(card.id, false)
            try await zoom(m, onto: card.id)
            await click(try headerButton(card.id, fromRight: 1))
            XCTAssertEqual(reader.cards.cards.first?.collapsed, true, "fold button at \(Int(m * 100))%")
        }
    }

    func testCloseAsksBeforeRemovingAnAnsweredThread() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        try await zoom(0.63, onto: card.id)
        await click(try headerButton(card.id, fromRight: 0))
        // An answered thread asks first, so a stray click cannot lose it.
        XCTAssertEqual(reader.cards.cards.count, 1)
        XCTAssertNotNil(window.attachedSheet ?? NSApp.modalWindow, "the confirmation should be on screen")
        if let sheet = window.attachedSheet { window.endSheet(sheet) }
    }

    func testButtonsWorkOnAThreadAcrossTwoPages() async throws {
        let card = try await makeCard(anchors: [
            anchor(page: 1, y: 0.95, text: "sayfanın son satırı"),
            anchor(page: 2, y: 0.05, text: "sonraki sayfanın ilk satırı"),
        ])
        try await zoom(0.63, onto: card.id)
        await click(try headerButton(card.id, fromRight: 2))
        XCTAssertEqual(reader.journal.count, 1, "save to journal on a two-page thread")
        await click(try headerButton(card.id, fromRight: 1))
        XCTAssertEqual(reader.cards.cards.first?.collapsed, true, "fold on a two-page thread")
    }

    /// Dragging the header moves the card with the pointer at any zoom, and its buttons work after.
    func testDraggingFollowsThePointerWhenZoomed() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        let m = 0.63
        try await zoom(m, onto: card.id)
        let view = try cardView(card.id)
        let start = view.frame.origin
        let grab = world.documentView.convert(CGPoint(x: view.frame.minX + 120, y: view.frame.minY + 18), to: nil)
        window.sendEvent(mouse(.leftMouseDown, grab))
        for i in 1...10 {
            window.sendEvent(mouse(.leftMouseDragged, CGPoint(x: grab.x + Double(i) * 6.3, y: grab.y - Double(i) * 3.15)))
            try await Task.sleep(for: .milliseconds(16))
        }
        window.sendEvent(mouse(.leftMouseUp, CGPoint(x: grab.x + 63, y: grab.y - 31.5)))
        try await Task.sleep(for: .milliseconds(150))
        let moved = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertTrue(moved.isPinned)
        // 63 window points at 63% is 100 world units; window y grows upwards, the world's downwards.
        XCTAssertEqual(moved.x - start.x, 100, accuracy: 2)
        XCTAssertEqual(moved.y - start.y, 50, accuracy: 2)
        await click(try headerButton(card.id, fromRight: 1))
        XCTAssertEqual(reader.cards.cards.first?.collapsed, true, "fold after a drag")
    }

    /// The eye button hides every thread (cards and yarns); highlights stay, and a click on one brings
    /// back just its card.
    func testHidingThreadsKeepsHighlightsAndOneComesBackFromItsHighlight() async throws {
        let a = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        let b = try await makeCard(anchors: [anchor(page: 1, y: 0.6, text: "Dikkat sınırlı bir kaynaktır.")])
        reader.hideThreads = true
        world.sync()
        XCTAssertTrue(reader.segments.isEmpty, "no yarns")
        XCTAssertFalse(world.documentView.subviews.contains { $0 is ZoomedHostingView<AnyView> && !$0.isHidden }, "no cards")
        XCTAssertEqual(reader.highlights(onPage: 1).count, 2, "highlights stay as cues")
        world.highlightClicked(b.id)
        world.sync()
        XCTAssertEqual(reader.segments.map(\.cardId), [b.id], "only the clicked thread comes back")
        reader.hideThreads = false
        world.sync()
        XCTAssertEqual(Set(reader.segments.map(\.cardId)), [a.id, b.id])
    }

    func drag(from start: CGPoint, by d: CGSize, clicks: Int = 1) async {
        func ev(_ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
        }
        window.sendEvent(ev(.leftMouseDown, start))
        for i in 1...8 {
            window.sendEvent(ev(.leftMouseDragged, CGPoint(x: start.x + d.width * Double(i) / 8, y: start.y + d.height * Double(i) / 8)))
            try? await Task.sleep(for: .milliseconds(16))
        }
        window.sendEvent(ev(.leftMouseUp, CGPoint(x: start.x + d.width, y: start.y + d.height)))
        try? await Task.sleep(for: .milliseconds(150))
    }

    /// The bottom-right corner resizes a card within its limits; a double-click there resets it.
    func testCornerResizesTheCardWithinLimits() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        try await zoom(0.63, onto: card.id)
        var view = try cardView(card.id)
        let startHeight = view.frame.height
        func corner() throws -> CGPoint {
            let v = try cardView(card.id)
            return world.documentView.convert(CGPoint(x: v.frame.maxX - 4, y: v.frame.maxY - 4), to: nil)
        }
        // 63 window points at 63% is 100 world units; down the screen is down the world.
        await drag(from: try corner(), by: CGSize(width: 63, height: -63))
        var c = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(c.width, 490, accuracy: 2)
        XCTAssertEqual(try XCTUnwrap(c.height), startHeight + 100, accuracy: 2)
        view = try cardView(card.id)
        XCTAssertEqual(view.frame.width, 490, accuracy: 2)

        await drag(from: try corner(), by: CGSize(width: -600, height: 600))
        c = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(c.width, CardsModel.widthRange.lowerBound, "not narrower than the minimum")
        XCTAssertEqual(c.height, CardsModel.heightRange.lowerBound, "not shorter than the minimum")
        // Smaller than its content: the middle scrolls.
        view = try cardView(card.id)
        view.layoutSubtreeIfNeeded()
        XCTAssertNotNil(ZoomedHostingView<AnyView>.scrollView(in: view, at: CGPoint(x: view.bounds.midX, y: view.bounds.midY)))

        await drag(from: try corner(), by: CGSize(width: 2000, height: -2000))
        c = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(c.width, CardsModel.widthRange.upperBound, "not wider than the maximum")
        XCTAssertEqual(c.height, CardsModel.heightRange.upperBound, "not taller than the maximum")

        let p = try corner()
        window.sendEvent(mouse(.leftMouseDown, p))
        window.sendEvent(NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 2, pressure: 1)!)
        window.sendEvent(mouse(.leftMouseUp, p))
        c = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(c.width, Geometry.cardWidth, "double-click: natural width")
        XCTAssertNil(c.height, "and natural height")
    }

    /// Owner, 16 Nov: a card widens from either side. From the right only the width changes; from the
    /// left the right edge stays put and the card stays where the reader put it.
    func testSidesWidenTheCard() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        try await zoom(0.63, onto: card.id)
        var view = try cardView(card.id)
        let startX = view.frame.minX
        // 63 window points at 63% is 100 world units.
        await drag(from: world.documentView.convert(CGPoint(x: view.frame.maxX - 2, y: view.frame.midY), to: nil), by: CGSize(width: 63, height: 0))
        var c = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(c.width, Geometry.cardWidth + 100, accuracy: 2, "right side: wider")
        XCTAssertFalse(c.isPinned, "still in the lane")
        view = try cardView(card.id)
        XCTAssertEqual(view.frame.minX, startX, accuracy: 0.5, "its left edge stays")
        let right = view.frame.maxX
        await drag(from: world.documentView.convert(CGPoint(x: view.frame.minX + 2, y: view.frame.midY), to: nil), by: CGSize(width: -63, height: 0))
        c = try XCTUnwrap(reader.cards.cards.first)
        XCTAssertEqual(c.width, Geometry.cardWidth + 200, accuracy: 3, "left side: wider")
        XCTAssertTrue(c.isPinned, "the card stays where the reader widened it")
        XCTAssertEqual(c.x + c.width, right, accuracy: 1, "its right edge stays")
        // A double-click on a side: natural width again.
        view = try cardView(card.id)
        let p = world.documentView.convert(CGPoint(x: view.frame.maxX - 2, y: view.frame.midY), to: nil)
        window.sendEvent(mouse(.leftMouseDown, p))
        window.sendEvent(NSEvent.mouseEvent(with: .leftMouseDown, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 2, pressure: 1)!)
        window.sendEvent(mouse(.leftMouseUp, p))
        XCTAssertEqual(try XCTUnwrap(reader.cards.cards.first).width, Geometry.cardWidth)
    }

    /// Text in the middle of a card still selects: only a thin strip at each side resizes.
    func testTheSideStripsAreThin() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        try await zoom(1, onto: card.id)
        let view = try cardView(card.id)
        let inside = view.hitTest(world.documentView.convert(CGPoint(x: view.frame.minX + 30, y: view.frame.midY), to: view.superview))
        let edge = view.hitTest(world.documentView.convert(CGPoint(x: view.frame.minX + 2, y: view.frame.midY), to: view.superview))
        XCTAssertTrue(edge === view, "the side strip belongs to the card itself")
        XCTAssertFalse(inside === nil)
    }

    /// The reply line is a light label until clicked; a click opens the field ready for typing.
    func testReplyLabelOpensTheFieldWhenZoomed() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        try await zoom(0.63, onto: card.id)
        let view = try cardView(card.id)
        await click(world.documentView.convert(CGPoint(x: view.frame.minX + 80, y: view.frame.maxY - 20), to: nil))
        // The field appears and takes the focus on the next turns of the run loop.
        for _ in 0..<40 {
            if let r = window.firstResponder as? NSView, r is NSText, r.isDescendant(of: view) { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let responder = try XCTUnwrap(window.firstResponder as? NSView)
        XCTAssertTrue(responder.isDescendant(of: view), "the reply field has the focus")
        XCTAssertTrue(responder is NSText, "and takes typing")
    }

    /// The knot left by folding a thread opens it again with a click, at any zoom.
    func testKnotOpensTheThreadWhenZoomed() async throws {
        let card = try await makeCard(anchors: [anchor(page: 1, y: 0.3, text: "Kavramlar sınırlarda netleşir.")])
        reader.cards.setCollapsed(card.id, true)
        world.sync()
        world.scrollView.magnification = 0.63
        window.displayIfNeeded()
        let page = try XCTUnwrap(world.documentView.subviews.compactMap { $0 as? PageView }.first { $0.number == 1 })
        let badge = try XCTUnwrap(page.subviews.first { $0 is ZoomedHostingView<KnotBadge> })
        badge.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        await click(page.convert(CGPoint(x: badge.frame.midX, y: badge.frame.midY), to: nil))
        XCTAssertEqual(reader.cards.cards.first?.collapsed, false)
    }
}
