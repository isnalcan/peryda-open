import AppKit
import PDFKit
import PerydaKit
import SwiftUI
import XCTest

/// Threads opened inside threads, folded threads as paper clips, and new threads from a margin note.
@MainActor
final class NestedThreadsTests: XCTestCase {
    static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    var store: LibraryStore!
    var reader: ReaderModel!
    var window: NSWindow!
    var world: WorldView!

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: "pagedReading")
        store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("peryda-nested-\(UUID().uuidString)"))
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("web/dev-samples/okuma.pdf"))
        let book = try store.importBook(data: data, fileName: "okuma.pdf", title: "Yavaş Okuma", author: nil, pageCount: 1)
        reader = try XCTUnwrap(ReaderModel(book: book, store: store, lang: .tr, settings: ByokSettings(geminiApiKey: "placeholder-not-a-key"), streamer: InstantStreamer()))
        let reader = self.reader!
        var worldRef: WorldView?
        world = WorldView(model: reader) { id in
            AnyView(YarnCardView(cardId: id, reader: reader, lang: .tr, openSettings: {}, onSelectText: { id, text, rect in
                worldRef?.cardTextSelected(id, text: text, windowRect: rect)
            }, resizable: true))
        }
        worldRef = world
        window = OffscreenKeyWindow(contentRect: CGRect(x: -10_000, y: -10_000, width: 1600, height: 1000), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = world
        window.orderFrontRegardless()
        window.layoutIfNeeded()
    }

    override func tearDown() async throws { window.orderOut(nil) }

    func mouse(_ type: NSEvent.EventType, _ p: CGPoint, clicks: Int = 1) -> NSEvent {
        NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
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

    func root() async throws -> YarnCard {
        let r = NormalizedRect(x: 0.1, y: 0.3, width: 0.6, height: 0.02)
        reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: "Kavramlar sınırlarda netleşir.", lineRects: [r], boundingRect: r)], rect: .zero)
        reader.create(color: .mint, kind: .quick(.mint))
        await settle()
        return try XCTUnwrap(reader.cards.cards.last)
    }

    /// A thread opened from a passage `at` units down inside `parent`.
    func child(of parent: YarnCard, color: YarnColor = .lavender, at y: Double = 40) async throws -> YarnCard {
        let anchor = YarnAnchor(sourceType: .card, bookId: reader.book.id, pageNumber: 0, selectedText: "komşularıyla", lineRects: [], boundingRect: NormalizedRect(x: 30, y: y, width: 80, height: 16), sourceCardId: parent.id)
        reader.pending = PendingSelection(anchors: [anchor], rect: .zero, parentCardId: parent.id)
        reader.create(color: color, kind: .quick(color))
        await settle()
        return try XCTUnwrap(reader.cards.cards.last)
    }

    func testTheSelectionBarOffersThreeThreadsAndATranslateIcon() {
        XCTAssertEqual(SelectionMenuView.quick, [.lavender, .mint, .coral])
        XCTAssertNotNil(NSImage(systemSymbolName: "translate", accessibilityDescription: nil))
    }

    /// Six generations deep, every thread sits level with the passage it came from, one lane to the
    /// right of its parent; none flies to the top.
    func testADeepChainStaysLevelWithItsPassages() async throws {
        var chain = [try await root()]
        for _ in 0..<5 { chain.append(try await child(of: chain.last!)) }
        let place = reader.placements
        for (parent, kid) in zip(chain, chain.dropFirst()) {
            let pp = try XCTUnwrap(place[parent.id]), kp = try XCTUnwrap(place[kid.id])
            XCTAssertEqual(kp.x, pp.x + parent.width + Geometry.g.subLaneGap, accuracy: 0.5)
            XCTAssertEqual(kp.y, pp.y + 40 + 8 - Geometry.g.anchorLift, accuracy: 0.5, "level with its passage in the parent")
        }
        XCTAssertGreaterThan(try XCTUnwrap(place[chain.last!.id]).y, try XCTUnwrap(place[chain[0].id]).y)
        // The world grows to hold every lane.
        XCTAssertGreaterThan(reader.worldRect.maxX, try XCTUnwrap(place[chain.last!.id]).x + chain.last!.width)
    }

    /// Folding a thread opened inside a card leaves a paper clip on that card's edge (and hides the
    /// threads below it); a click on the clip opens it again, at any zoom.
    func testAFoldedSubThreadBecomesAClipThatOpensIt() async throws {
        let a = try await root()
        let b = try await child(of: a)
        let c = try await child(of: b, color: .coral)
        reader.cards.setCollapsed(b.id, true)
        await settle()
        XCTAssertNil(reader.placements[b.id])
        XCTAssertNil(reader.placements[c.id], "a thread under a folded one is folded with it")
        let clip = try XCTUnwrap(reader.clips(placements: reader.placements, lang: .tr).first)
        XCTAssertEqual(clip.cardId, b.id)
        XCTAssertTrue(clip.right, "the thread was to the right, so is the clip")
        let pa = try XCTUnwrap(reader.placements[a.id])
        XCTAssertEqual(clip.point.x, pa.x + a.width, accuracy: 0.5)

        world.scrollView.magnification = 0.63
        world.scrollView.contentView.scroll(to: CGPoint(x: pa.x - 300, y: max(0, pa.y - 200)))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let view = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<ClipBadge> })
        let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent("peryda-mac-clip.png"))
        let p = world.documentView.convert(CGPoint(x: view.frame.midX, y: view.frame.midY), to: nil)
        NSApp.postEvent(mouse(.leftMouseUp, p), atStart: false)
        window.sendEvent(mouse(.leftMouseDown, p))
        while let e = NSApp.nextEvent(matching: [.leftMouseUp], until: Date(), inMode: .default, dequeue: true) { window.sendEvent(e) }
        await settle()
        XCTAssertEqual(reader.cards.cards.first { $0.id == b.id }?.collapsed, false)
        XCTAssertNotNil(reader.placements[c.id], "and the threads under it come back")
    }

    func testAClipSitsOnTheLeftWhenTheThreadWasMovedLeft() async throws {
        let a = try await root()
        let b = try await child(of: a)
        let pa = try XCTUnwrap(reader.placements[a.id])
        reader.cards.pin(b.id, x: pa.x - 500, y: pa.y)
        reader.cards.setCollapsed(b.id, true)
        await settle()
        let clip = try XCTUnwrap(reader.clips(placements: reader.placements, lang: .tr).first)
        XCTAssertFalse(clip.right)
        XCTAssertEqual(clip.point.x, pa.x, accuracy: 0.5)
    }

    /// Text in a margin note can be selected to open a thread from it.
    func testSelectingInAMarginNoteOpensAThreadFromIt() async throws {
        let r = NormalizedRect(x: 0.1, y: 0.5, width: 0.6, height: 0.02)
        reader.pending = PendingSelection(anchors: [YarnAnchor(sourceType: .pdfText, bookId: reader.book.id, pageNumber: 1, selectedText: "Dikkat sınırlı bir kaynaktır.", lineRects: [r], boundingRect: r)], rect: .zero)
        reader.create(color: .cream, kind: .quick(.cream), text: "Bu cümle sınav için önemli, dikkat ile odak farkını sor.")
        await settle()
        let note = try XCTUnwrap(reader.cards.cards.last)
        world.scrollView.magnification = 0.63
        let place = try XCTUnwrap(reader.placements[note.id])
        world.scrollView.contentView.scroll(to: CGPoint(x: place.x - 300, y: max(0, place.y - 200)))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let host = try XCTUnwrap(world.documentView.subviews.first { $0 is ZoomedHostingView<AnyView> })
        func find(_ v: NSView) -> AnswerTextView? { (v as? AnswerTextView) ?? v.subviews.lazy.compactMap(find).first }
        let text = try XCTUnwrap(find(host), "the note is selectable text")
        // Drag across the first words, as a reader would.
        let start = text.convert(CGPoint(x: 2, y: 6), to: nil)
        let end = text.convert(CGPoint(x: 90, y: 6), to: nil)
        let down = mouse(.leftMouseDown, start)
        NSApp.postEvent(mouse(.leftMouseDragged, CGPoint(x: (start.x + end.x) / 2, y: start.y)), atStart: false)
        NSApp.postEvent(mouse(.leftMouseDragged, end), atStart: false)
        NSApp.postEvent(mouse(.leftMouseUp, end), atStart: false)
        window.sendEvent(down)
        while let e = NSApp.nextEvent(matching: [.leftMouseUp, .leftMouseDragged], until: Date(), inMode: .default, dequeue: true) { window.sendEvent(e) }
        let pending = try XCTUnwrap(reader.pending, "the selection menu opened")
        XCTAssertEqual(pending.parentCardId, note.id)
        XCTAssertEqual(pending.anchors.first?.context, "Bu cümle sınav için önemli, dikkat ile odak farkını sor.", "read with the note it came from")
        XCTAssertEqual(pending.anchors.first?.sourceType, .card)
        XCTAssertFalse(pending.anchors.first?.selectedText.isEmpty ?? true)
    }

    // MARK: Several threads from one card

    func frames() -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        for (id, p) in reader.placements {
            let c = reader.cards.cards.first { $0.id == id }!
            out[id] = CGRect(x: p.x, y: p.y, width: c.width, height: reader.heights[id] ?? 150)
        }
        return out
    }

    /// Three threads from different passages of one card share its second lane in passage order,
    /// each level with its passage unless that would overlap, and each has its own yarn.
    func testSeveralThreadsFromOneCard() async throws {
        let a = try await root()
        let kids = [try await child(of: a, color: .lavender, at: 30), try await child(of: a, color: .mint, at: 70), try await child(of: a, color: .coral, at: 110)]
        let f = frames()
        let pa = try XCTUnwrap(reader.placements[a.id])
        for k in kids { XCTAssertEqual(try XCTUnwrap(f[k.id]).minX, pa.x + a.width + Geometry.g.subLaneGap, accuracy: 0.5) }
        let ys = kids.map { f[$0.id]!.minY }
        XCTAssertEqual(ys, ys.sorted(), "in passage order")
        for (x, y) in zip(kids, kids.dropFirst()) {
            XCTAssertLessThanOrEqual(f[x.id]!.maxY + Geometry.g.laneGap - 0.5, f[y.id]!.minY, "no overlap")
        }
        XCTAssertEqual(f[kids[0].id]!.minY, pa.y + 30 + 8 - Geometry.g.anchorLift, accuracy: 0.5, "the first sits level with its passage")
        let segs = reader.segments.filter { $0.sourceCardId == a.id }
        XCTAssertEqual(Set(segs.map(\.cardId)), Set(kids.map(\.id)), "one yarn each, from the parent")
        for s in segs { XCTAssertEqual(s.from.x, pa.x + a.width, accuracy: 0.5) }
    }

    /// Two threads from the same line never overlap either.
    func testTwoThreadsFromTheSamePassageStack() async throws {
        let a = try await root()
        let b = try await child(of: a, at: 50)
        let c = try await child(of: a, color: .coral, at: 50)
        let f = frames()
        XCTAssertFalse(f[b.id]!.intersects(f[c.id]!))
    }

    /// Folding all of them leaves one knot each on the parent's edge, never overlapping (even from
    /// one line); opening one brings back only that one; one moved to the left gets its knot left.
    func testFoldedSiblingsGetSeparateKnots() async throws {
        let a = try await root()
        let b = try await child(of: a, at: 50)
        let c = try await child(of: a, color: .coral, at: 50)
        let d = try await child(of: a, color: .mint, at: 120)
        let pa = try XCTUnwrap(reader.placements[a.id])
        reader.cards.pin(d.id, x: pa.x - 520, y: pa.y + 100)
        for k in [b, c, d] { reader.cards.setCollapsed(k.id, true) }
        await settle()
        let knots = reader.clips(placements: reader.placements, lang: .tr)
        XCTAssertEqual(Set(knots.map(\.cardId)), [b.id, c.id, d.id])
        let right = knots.filter(\.right).sorted { $0.point.y < $1.point.y }
        XCTAssertEqual(right.map(\.cardId).count, 2)
        XCTAssertGreaterThanOrEqual(right[1].point.y - right[0].point.y, 30, "knots from one line are spaced apart")
        XCTAssertEqual(knots.first { $0.cardId == d.id }?.right, false, "the one moved left is tied on the left")
        XCTAssertEqual(world.documentView.subviews.filter { $0 is ZoomedHostingView<ClipBadge> }.count, 3)

        world.scrollView.magnification = 1.4
        world.scrollView.contentView.scroll(to: CGPoint(x: pa.x - 200, y: max(0, pa.y - 60)))
        world.scrollView.reflectScrolledClipView(world.scrollView.contentView)
        await settle()
        let outDir = URL(fileURLWithPath: ProcessInfo.processInfo.environment["PERYDA_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
        let content = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
        content.cacheDisplay(in: content.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent("peryda-mac-knots.png"))

        world.highlightClicked(c.id)
        await settle()
        XCTAssertNotNil(reader.placements[c.id])
        XCTAssertNil(reader.placements[b.id])
        XCTAssertNil(reader.placements[d.id])
        XCTAssertEqual(Set(reader.clips(placements: reader.placements, lang: .tr).map(\.cardId)), [b.id, d.id])
    }

    /// Threads under a folded thread stay with it (no knots of their own); removing a thread removes
    /// what was opened from it and nothing else.
    func testGrandchildrenFoldAndGoWithTheirParent() async throws {
        let a = try await root()
        let b = try await child(of: a, at: 40)
        let c = try await child(of: a, color: .coral, at: 100)
        let g1 = try await child(of: b, at: 30)
        let g2 = try await child(of: b, color: .mint, at: 80)
        reader.cards.setCollapsed(b.id, true)
        await settle()
        XCTAssertNil(reader.placements[g1.id])
        XCTAssertNil(reader.placements[g2.id])
        XCTAssertEqual(reader.clips(placements: reader.placements, lang: .tr).map(\.cardId), [b.id], "only the folded thread has a knot")
        reader.cards.setCollapsed(b.id, false)
        await settle()
        XCTAssertNotNil(reader.placements[g1.id])
        XCTAssertNotNil(reader.placements[g2.id])

        reader.cards.remove(b.id)
        await settle()
        XCTAssertEqual(Set(reader.cards.cards.map(\.id)), [a.id, c.id], "its own threads go with it, the sibling stays")
        XCTAssertNotNil(reader.placements[c.id])
    }
}
